import type { HeliusClient, EnhancedTransaction } from '../sources/helius';
import type { BirdeyeClient } from '../sources/birdeye';
import type { Cache } from '../cache';
import { CACHE_TTL } from '../config';
import { formatTimestamp } from '../utils/normalize';

interface TradeEntry {
  mint: string;
  symbol: string;
  side: 'buy' | 'sell';
  amount_usd: number;
  timestamp: number;
}

interface ClosedTrade {
  buy_token: string;
  sell_token: string;
  entry_usd: number;
  exit_usd: number;
  pnl_usd: number;
  hold_time_days: number;
}

export interface TopPair {
  buy_token: string;
  sell_token: string;
  win_count: number;
  avg_pnl: number;
}

export interface CopyTradeEnrichment {
  address: string;
  lookback_days: number;
  trades_analyzed: number;
  win_rate: number;
  total_pnl_usd: number;
  avg_pnl_per_trade_usd: number;
  avg_hold_time_days: number;
  consistency_score: number;
  trade_frequency_per_day: number;
  top_performing_pairs: TopPair[];
  labels: string[];
  last_updated: string;
}

const SWAP_TYPES = new Set(['SWAP', 'TOKEN_SWAP', 'EXCHANGE']);

export class CopyTradeAnalyzer {
  constructor(
    private helius: HeliusClient,
    private birdeye: BirdeyeClient,
    private cache: Cache,
  ) {}

  async enrich(address: string, lookbackDays: number): Promise<CopyTradeEnrichment> {
    const cacheKey = `copytrade:${address}:${lookbackDays}`;
    const cached = await this.cache.get<CopyTradeEnrichment>(cacheKey);
    if (cached) return cached;

    // Fetch recent transactions
    const sigs = await this.helius.getSignaturesForAddress(address, 100);
    const cutoff = Date.now() / 1000 - lookbackDays * 86400;
    const recentSigs = sigs.filter((s) => (s.blockTime ?? 0) >= cutoff);
    const sigStrings = recentSigs.map((s) => s.signature);

    let txs: EnhancedTransaction[] = [];
    if (sigStrings.length > 0) {
      try {
        txs = await this.helius.getEnhancedTransactions(sigStrings);
      } catch {
        // Graceful degradation
      }
    }

    // Extract swap trades
    const trades: TradeEntry[] = [];
    for (const tx of txs) {
      if (!SWAP_TYPES.has(tx.type.toUpperCase())) continue;
      if (!tx.tokenTransfers || tx.tokenTransfers.length < 2) continue;

      for (const transfer of tx.tokenTransfers) {
        // Try to get USD value from token price
        let amountUsd = transfer.tokenAmount;
        try {
          const price = await this.birdeye.getTokenPrice(transfer.mint);
          amountUsd = transfer.tokenAmount * price.value;
        } catch {
          // Use raw amount as fallback
        }

        const side: 'buy' | 'sell' =
          transfer.toUserAccount === address ? 'buy' : 'sell';

        trades.push({
          mint: transfer.mint,
          symbol: transfer.mint.slice(0, 6),
          side,
          amount_usd: amountUsd,
          timestamp: tx.timestamp,
        });
      }
    }

    // Match buy/sell pairs per token to compute PnL
    const buysByToken = new Map<string, TradeEntry[]>();
    const sellsByToken = new Map<string, TradeEntry[]>();

    for (const trade of trades) {
      const map = trade.side === 'buy' ? buysByToken : sellsByToken;
      const existing = map.get(trade.mint) ?? [];
      existing.push(trade);
      map.set(trade.mint, existing);
    }

    const closedTrades: ClosedTrade[] = [];
    for (const [mint, buys] of buysByToken) {
      const sells = sellsByToken.get(mint) ?? [];
      const pairs = Math.min(buys.length, sells.length);
      for (let i = 0; i < pairs; i++) {
        const buy = buys[i];
        const sell = sells[i];
        const holdTimeDays = Math.abs(sell.timestamp - buy.timestamp) / 86400;
        closedTrades.push({
          buy_token: mint,
          sell_token: mint,
          entry_usd: buy.amount_usd,
          exit_usd: sell.amount_usd,
          pnl_usd: sell.amount_usd - buy.amount_usd,
          hold_time_days: holdTimeDays,
        });
      }
    }

    // Compute metrics
    const totalTrades = closedTrades.length;
    const wins = closedTrades.filter((t) => t.pnl_usd > 0).length;
    const winRate = totalTrades > 0 ? wins / totalTrades : 0;
    const totalPnl = closedTrades.reduce((sum, t) => sum + t.pnl_usd, 0);
    const avgPnl = totalTrades > 0 ? totalPnl / totalTrades : 0;
    const avgHoldTime = totalTrades > 0
      ? closedTrades.reduce((sum, t) => sum + t.hold_time_days, 0) / totalTrades
      : 0;

    // Consistency: 1 - normalized stddev of returns
    let consistency = 0;
    if (totalTrades >= 2) {
      const returns = closedTrades.map((t) => t.pnl_usd);
      const mean = totalPnl / totalTrades;
      const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / totalTrades;
      const stddev = Math.sqrt(variance);
      const maxAbsReturn = Math.max(...returns.map(Math.abs), 1);
      consistency = Math.max(0, Math.min(1, 1 - stddev / maxAbsReturn));
    }

    const tradeFrequency = lookbackDays > 0 ? trades.length / lookbackDays : 0;

    // Top performing pairs
    const pairMap = new Map<string, { wins: number; totalPnl: number; count: number }>();
    for (const ct of closedTrades) {
      const key = ct.buy_token;
      const entry = pairMap.get(key) ?? { wins: 0, totalPnl: 0, count: 0 };
      entry.count++;
      entry.totalPnl += ct.pnl_usd;
      if (ct.pnl_usd > 0) entry.wins++;
      pairMap.set(key, entry);
    }

    const topPairs: TopPair[] = [...pairMap.entries()]
      .map(([mint, data]) => ({
        buy_token: mint,
        sell_token: mint,
        win_count: data.wins,
        avg_pnl: data.count > 0 ? data.totalPnl / data.count : 0,
      }))
      .sort((a, b) => b.avg_pnl - a.avg_pnl)
      .slice(0, 5);

    // Labels
    const labels: string[] = [];
    if (winRate > 0.55 && totalPnl > 500) labels.push('smart_money');
    if (tradeFrequency > 5) labels.push('high_frequency');
    if (consistency > 0.7) labels.push('consistent_trader');

    const enrichment: CopyTradeEnrichment = {
      address,
      lookback_days: lookbackDays,
      trades_analyzed: totalTrades,
      win_rate: Math.round(winRate * 1000) / 1000,
      total_pnl_usd: Math.round(totalPnl * 100) / 100,
      avg_pnl_per_trade_usd: Math.round(avgPnl * 100) / 100,
      avg_hold_time_days: Math.round(avgHoldTime * 10) / 10,
      consistency_score: Math.round(consistency * 100) / 100,
      trade_frequency_per_day: Math.round(tradeFrequency * 100) / 100,
      top_performing_pairs: topPairs,
      labels,
      last_updated: formatTimestamp(),
    };

    await this.cache.set(cacheKey, enrichment, CACHE_TTL.copyTrade);
    return enrichment;
  }
}
