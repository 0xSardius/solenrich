import type { Cache } from '../cache';
import type { CopyTradeAnalyzer, CopyTradeEnrichment } from './copy-trade-analyzer';
import type { WhaleWatcher } from './whale-watch';
import type { GraphMapper } from './graph-mapper';
import { CACHE_TTL } from '../config';
import { formatTimestamp, shortenAddress } from '../utils/normalize';
import { resolveSeedWallets } from './smart-money-seeds';

export interface SmartWallet {
  address: string;
  win_rate: number;
  total_pnl_usd: number;
  trades_analyzed: number;
  sharpe_ratio: number | null;
  consistency_score: number;
  labels: string[];
}

export interface AccumulatedToken {
  mint: string;
  symbol: string;
  smart_money_buyers: number; // count of seed wallets accumulating this
  total_buy_volume_usd: number;
  avg_avg_hold_time_days: number | null;
}

export interface WalletCluster {
  members: string[];
  size: number;
  suspicious_pattern: string | null;
}

export interface SmartMoneyFlowResult {
  seed_wallets_considered: number;
  qualifying_smart_wallets: SmartWallet[];
  accumulated_tokens: AccumulatedToken[];
  clusters: WalletCluster[];
  filters: {
    lookback_days: number;
    min_win_rate: number;
    top_n_tokens: number;
    include_graph: boolean;
    user_provided_wallets: boolean;
  };
  last_updated: string;
}

/**
 * Orchestrates copy-trade analysis across seed wallets → identifies qualifying
 * smart money → surfaces what tokens they're accumulating and cluster relationships.
 *
 * Three-phase pipeline:
 *   1. Score every seed wallet via copy-trade (win rate, PnL, consistency)
 *   2. Filter to qualifying wallets (win rate ≥ min_win_rate, trades ≥ 5)
 *   3. Aggregate their top-performing pairs to surface accumulated tokens,
 *      and optionally graph-map them to find clusters.
 */
export class SmartMoneyAnalyzer {
  constructor(
    private copyTrade: CopyTradeAnalyzer,
    private whaleWatcher: WhaleWatcher,
    private graphMapper: GraphMapper,
    private cache: Cache,
  ) {}

  async enrich(
    userWallets: readonly string[] | undefined,
    lookbackDays: number,
    minWinRate: number,
    topNTokens: number,
    includeGraph: boolean,
  ): Promise<SmartMoneyFlowResult> {
    const seeds = resolveSeedWallets(userWallets);
    const cacheKey = `smart-money:${seeds.length}:${lookbackDays}:${minWinRate}:${topNTokens}:${includeGraph}:${seeds.slice(0, 3).join(',')}`;
    const cached = await this.cache.get<SmartMoneyFlowResult>(cacheKey);
    if (cached) return cached;

    // Phase 1: Score every seed via copy-trade (parallel, batches of 4)
    const copyResults: Array<{ address: string; result: CopyTradeEnrichment | null }> = [];
    for (let i = 0; i < seeds.length; i += 4) {
      const batch = seeds.slice(i, i + 4);
      const settled = await Promise.allSettled(
        batch.map(addr => this.copyTrade.enrich(addr, lookbackDays)),
      );
      for (let j = 0; j < batch.length; j++) {
        const s = settled[j];
        copyResults.push({
          address: batch[j],
          result: s.status === 'fulfilled' ? s.value : null,
        });
      }
    }

    // Phase 2: Filter to qualifying wallets
    const qualifying: SmartWallet[] = [];
    for (const { address, result } of copyResults) {
      if (!result) continue;
      if (result.trades_analyzed < 5) continue;
      if (result.win_rate < minWinRate) continue;
      qualifying.push({
        address,
        win_rate: result.win_rate,
        total_pnl_usd: result.total_pnl_usd,
        trades_analyzed: result.trades_analyzed,
        sharpe_ratio: result.risk_adjusted?.sharpe_ratio ?? null,
        consistency_score: result.consistency_score,
        labels: result.labels,
      });
    }
    qualifying.sort((a, b) => b.total_pnl_usd - a.total_pnl_usd);

    // Phase 3a: Aggregate accumulated tokens from qualifying wallets' top pairs
    const tokenAgg = new Map<
      string,
      { buyers: Set<string>; totalVolume: number; symbols: Set<string>; holdTimes: number[] }
    >();
    for (const { address, result } of copyResults) {
      if (!result) continue;
      const isQualifying = qualifying.some(q => q.address === address);
      if (!isQualifying) continue;
      for (const pair of result.top_performing_pairs) {
        // buy_token is the token being accumulated
        const key = pair.buy_token;
        if (!tokenAgg.has(key)) {
          tokenAgg.set(key, { buyers: new Set(), totalVolume: 0, symbols: new Set(), holdTimes: [] });
        }
        const bucket = tokenAgg.get(key)!;
        bucket.buyers.add(address);
        bucket.totalVolume += Math.max(0, pair.avg_pnl * pair.win_count); // approximation
        bucket.symbols.add(pair.buy_token);
        if (result.avg_hold_time_days > 0) bucket.holdTimes.push(result.avg_hold_time_days);
      }
    }
    const accumulated: AccumulatedToken[] = Array.from(tokenAgg.entries())
      .map(([mint, bucket]) => ({
        mint,
        symbol: Array.from(bucket.symbols)[0] ?? mint.slice(0, 4),
        smart_money_buyers: bucket.buyers.size,
        total_buy_volume_usd: Math.round(bucket.totalVolume * 100) / 100,
        avg_avg_hold_time_days:
          bucket.holdTimes.length > 0
            ? Math.round((bucket.holdTimes.reduce((s, x) => s + x, 0) / bucket.holdTimes.length) * 10) / 10
            : null,
      }))
      .filter(t => t.smart_money_buyers >= 2) // Require 2+ smart wallets to call it a signal
      .sort((a, b) => b.smart_money_buyers - a.smart_money_buyers || b.total_buy_volume_usd - a.total_buy_volume_usd)
      .slice(0, topNTokens);

    // Phase 3b: Graph-map qualifying wallets to find clusters (optional, expensive)
    let clusters: WalletCluster[] = [];
    if (includeGraph && qualifying.length > 0) {
      const topForGraph = qualifying.slice(0, Math.min(10, qualifying.length));
      const graphResults = await Promise.allSettled(
        topForGraph.map(w => this.graphMapper.enrich(w.address, 1, 2)),
      );
      const seen = new Set<string>();
      for (const r of graphResults) {
        if (r.status !== 'fulfilled') continue;
        for (const c of r.value.clusters) {
          const key = [...c.members].sort().join('|');
          if (seen.has(key)) continue;
          seen.add(key);
          clusters.push({
            members: c.members,
            size: c.members.length,
            suspicious_pattern: c.suspicious_pattern,
          });
        }
      }
      clusters.sort((a, b) => b.size - a.size);
      clusters = clusters.slice(0, 5);
    }

    const out: SmartMoneyFlowResult = {
      seed_wallets_considered: seeds.length,
      qualifying_smart_wallets: qualifying,
      accumulated_tokens: accumulated,
      clusters,
      filters: {
        lookback_days: lookbackDays,
        min_win_rate: minWinRate,
        top_n_tokens: topNTokens,
        include_graph: includeGraph,
        user_provided_wallets: !!(userWallets && userWallets.length > 0),
      },
      last_updated: formatTimestamp(),
    };
    await this.cache.set(cacheKey, out, CACHE_TTL.copyTrade); // 10 min — smart money shifts over days
    return out;
  }
}
