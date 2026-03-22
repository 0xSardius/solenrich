import type { HeliusClient, EnhancedTransaction } from '../sources/helius';
import type { DexScreenerClient } from '../sources/dexscreener';
import type { PriceAggregator } from '../utils/price-aggregator';
import type { Cache } from '../cache';
import { CACHE_TTL } from '../config';
import { formatTimestamp } from '../utils/normalize';

interface TradeEntry {
  mint: string;
  symbol: string;
  side: 'buy' | 'sell';
  amount_units: number;
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

export interface RiskAdjustedReturns {
  sharpe_ratio: number;       // return per unit of risk (>1 = good, >2 = excellent)
  sortino_ratio: number;      // like sharpe but only penalizes downside
  max_drawdown_pct: number;   // worst peak-to-trough decline (%)
  max_drawdown_usd: number;   // worst peak-to-trough decline ($)
  profit_factor: number;      // gross profit / gross loss (>1 = profitable)
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
  risk_adjusted?: RiskAdjustedReturns;
  trade_frequency_per_day: number;
  top_performing_pairs: TopPair[];
  labels: string[];
  last_updated: string;
}

const SWAP_TYPES = new Set(['SWAP', 'TOKEN_SWAP', 'EXCHANGE']);

export class CopyTradeAnalyzer {
  constructor(
    private helius: HeliusClient,
    private dexscreener: DexScreenerClient,
    private cache: Cache,
    private priceAggregator?: PriceAggregator,
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

    // Collect unique mints from swaps for batch pricing
    const swapMints = new Set<string>();
    for (const tx of txs) {
      if (!SWAP_TYPES.has(tx.type.toUpperCase())) continue;
      for (const transfer of tx.tokenTransfers ?? []) {
        swapMints.add(transfer.mint);
      }
    }

    // Multi-source price aggregation (DexScreener + Jupiter median)
    const mintList = [...swapMints];
    const mintPrices = new Map<string, number>();
    if (this.priceAggregator && mintList.length > 0) {
      const agg = await this.priceAggregator.getBatchPrices(mintList);
      for (const [mint, data] of agg) {
        mintPrices.set(mint, data.price);
      }
    } else {
      const priceResults = await Promise.allSettled(
        mintList.map((mint) => this.dexscreener.getTokenPrice(mint)),
      );
      for (let i = 0; i < mintList.length; i++) {
        const result = priceResults[i];
        mintPrices.set(mintList[i], result.status === 'fulfilled' ? result.value : 0);
      }
    }

    // Extract swap trades
    const trades: TradeEntry[] = [];
    for (const tx of txs) {
      if (!SWAP_TYPES.has(tx.type.toUpperCase())) continue;
      if (!tx.tokenTransfers || tx.tokenTransfers.length < 2) continue;

      for (const transfer of tx.tokenTransfers) {
        const price = mintPrices.get(transfer.mint) ?? 0;
        const amountUsd = price > 0 ? transfer.tokenAmount * price : transfer.tokenAmount;

        const side: 'buy' | 'sell' =
          transfer.toUserAccount === address ? 'buy' : 'sell';

        trades.push({
          mint: transfer.mint,
          symbol: transfer.mint.slice(0, 6),
          side,
          amount_units: transfer.tokenAmount,
          amount_usd: amountUsd,
          timestamp: tx.timestamp,
        });
      }
    }

    // Average cost basis matching — more accurate than FIFO
    trades.sort((a, b) => a.timestamp - b.timestamp);

    const positions = new Map<string, { units: number; cost_usd: number; first_buy_ts: number }>();
    const closedTrades: ClosedTrade[] = [];

    for (const trade of trades) {
      const pos = positions.get(trade.mint) ?? { units: 0, cost_usd: 0, first_buy_ts: trade.timestamp };

      if (trade.side === 'buy') {
        pos.units += trade.amount_units;
        pos.cost_usd += trade.amount_usd;
        positions.set(trade.mint, pos);
      } else if (trade.side === 'sell' && pos.units > 0) {
        const avgCost = pos.cost_usd / pos.units;
        const sellUnits = Math.min(trade.amount_units, pos.units);
        const costOfSold = sellUnits * avgCost;
        const pnl = trade.amount_usd - costOfSold;
        const holdDays = Math.max(0, (trade.timestamp - pos.first_buy_ts) / 86400);

        closedTrades.push({
          buy_token: trade.mint,
          sell_token: trade.mint,
          entry_usd: costOfSold,
          exit_usd: trade.amount_usd,
          pnl_usd: pnl,
          hold_time_days: holdDays,
        });

        // Reduce position proportionally
        pos.units -= sellUnits;
        pos.cost_usd -= costOfSold;
        if (pos.units <= 0) {
          pos.units = 0;
          pos.cost_usd = 0;
          pos.first_buy_ts = trade.timestamp;
        }
        positions.set(trade.mint, pos);
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

    // Risk-adjusted returns
    let riskAdjusted: RiskAdjustedReturns | undefined;
    if (totalTrades >= 3) {
      const pnls = closedTrades.map((t) => t.pnl_usd);
      const mean = totalPnl / totalTrades;

      // Sharpe: mean return / stddev of all returns
      const allVariance = pnls.reduce((s, r) => s + (r - mean) ** 2, 0) / totalTrades;
      const allStd = Math.sqrt(allVariance);
      const sharpe = allStd > 0 ? mean / allStd : 0;

      // Sortino: mean return / stddev of negative returns only
      const negReturns = pnls.filter((r) => r < 0);
      const downVariance = negReturns.length > 0
        ? negReturns.reduce((s, r) => s + r ** 2, 0) / negReturns.length
        : 0;
      const downStd = Math.sqrt(downVariance);
      const sortino = downStd > 0 ? mean / downStd : (mean > 0 ? 999 : 0);

      // Max drawdown: worst peak-to-trough decline
      let peak = 0;
      let cumulative = 0;
      let maxDdUsd = 0;
      for (const pnl of pnls) {
        cumulative += pnl;
        if (cumulative > peak) peak = cumulative;
        const dd = peak - cumulative;
        if (dd > maxDdUsd) maxDdUsd = dd;
      }
      const maxDdPct = peak > 0 ? (maxDdUsd / peak) * 100 : 0;

      // Profit factor: gross profit / gross loss
      const grossProfit = pnls.filter((r) => r > 0).reduce((s, r) => s + r, 0);
      const grossLoss = Math.abs(pnls.filter((r) => r < 0).reduce((s, r) => s + r, 0));
      const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);

      riskAdjusted = {
        sharpe_ratio: Math.round(sharpe * 100) / 100,
        sortino_ratio: Math.round(Math.min(sortino, 999) * 100) / 100,
        max_drawdown_pct: Math.round(maxDdPct * 100) / 100,
        max_drawdown_usd: Math.round(maxDdUsd * 100) / 100,
        profit_factor: Math.round(Math.min(profitFactor, 999) * 100) / 100,
      };
    }

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

    // Labels — use risk-adjusted metrics when available
    const labels: string[] = [];
    if (riskAdjusted && riskAdjusted.sharpe_ratio > 1.0 && totalPnl > 0) {
      labels.push('smart_money');
    } else if (winRate > 0.55 && totalPnl > 500) {
      labels.push('smart_money');
    }
    if (tradeFrequency > 5) labels.push('high_frequency');
    if (consistency > 0.7) labels.push('consistent_trader');
    if (riskAdjusted && riskAdjusted.max_drawdown_pct > 50) labels.push('high_risk');
    if (riskAdjusted && riskAdjusted.profit_factor > 2.0) labels.push('strong_edge');

    const enrichment: CopyTradeEnrichment = {
      address,
      lookback_days: lookbackDays,
      trades_analyzed: totalTrades,
      win_rate: Math.round(winRate * 1000) / 1000,
      total_pnl_usd: Math.round(totalPnl * 100) / 100,
      avg_pnl_per_trade_usd: Math.round(avgPnl * 100) / 100,
      avg_hold_time_days: Math.round(avgHoldTime * 10) / 10,
      consistency_score: Math.round(consistency * 100) / 100,
      risk_adjusted: riskAdjusted,
      trade_frequency_per_day: Math.round(tradeFrequency * 100) / 100,
      top_performing_pairs: topPairs,
      labels,
      last_updated: formatTimestamp(),
    };

    await this.cache.set(cacheKey, enrichment, CACHE_TTL.copyTrade);
    return enrichment;
  }
}
