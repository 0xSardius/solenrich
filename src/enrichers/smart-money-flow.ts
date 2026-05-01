import type { Cache } from '../cache';
import type { CopyTradeAnalyzer, CopyTradeEnrichment } from './copy-trade-analyzer';
import type { WhaleWatcher } from './whale-watch';
import type { GraphMapper } from './graph-mapper';
import type { TokenDiscovery } from './token-discovery';
import { CACHE_TTL } from '../config';
import { formatTimestamp, shortenAddress } from '../utils/normalize';
import { DEFAULT_SMART_MONEY_SEEDS } from './smart-money-seeds';

const DERIVED_SEEDS_CACHE_KEY = 'smart-money:derived-seeds:v1';
const DERIVED_SEEDS_TTL = 7 * 24 * 60 * 60; // 7 days
const MIN_DERIVED_SEEDS = 5;
const MAX_DERIVED_SEEDS = 50;
const TRENDING_TOKEN_LIMIT = 10;
const TRENDING_MIN_LIQUIDITY = 50_000;

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
  seed_source: 'user' | 'derived' | 'fallback';
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
    private tokenDiscovery?: TokenDiscovery,
  ) {}

  /**
   * Programmatically derives a seed list from current on-chain trending-token
   * whale activity. Cached 7d so we only pay the derivation cost once per week.
   *
   * Algorithm:
   *   1. Discover top trending tokens via TokenDiscovery
   *   2. For each, fetch top whales via WhaleWatcher
   *   3. Pool unique addresses, exclude entity-labeled wallets (CEXes, protocols)
   *   4. Cap at MAX_DERIVED_SEEDS to bound downstream copy-trade scoring cost
   *
   * Returns null if derivation yields fewer than MIN_DERIVED_SEEDS — caller
   * falls back to DEFAULT_SMART_MONEY_SEEDS.
   */
  private async deriveDefaultSeeds(): Promise<readonly string[] | null> {
    const cached = await this.cache.get<string[]>(DERIVED_SEEDS_CACHE_KEY);
    if (cached && cached.length >= MIN_DERIVED_SEEDS) return cached;

    if (!this.tokenDiscovery) return null;

    try {
      const discovery = await this.tokenDiscovery.discover(
        TRENDING_MIN_LIQUIDITY,
        0.8, // accept all but the riskiest
        TRENDING_TOKEN_LIMIT,
      );
      if (discovery.tokens.length === 0) return null;

      const whaleResults = await Promise.allSettled(
        discovery.tokens.map((t) => this.whaleWatcher.enrich(t.mint, 10_000, 72)),
      );

      const candidates = new Set<string>();
      for (const r of whaleResults) {
        if (r.status !== 'fulfilled') continue;
        for (const whale of r.value.whales) {
          // Exclude entity-labeled wallets (CEX hot wallets, protocol vaults, etc.)
          // — they're high-volume but not active traders.
          if (whale.entity_label) continue;
          candidates.add(whale.address);
          if (candidates.size >= MAX_DERIVED_SEEDS) break;
        }
        if (candidates.size >= MAX_DERIVED_SEEDS) break;
      }

      if (candidates.size < MIN_DERIVED_SEEDS) return null;

      const derived = Array.from(candidates);
      await this.cache.set(DERIVED_SEEDS_CACHE_KEY, derived, DERIVED_SEEDS_TTL);
      return derived;
    } catch {
      return null;
    }
  }

  async enrich(
    userWallets: readonly string[] | undefined,
    lookbackDays: number,
    minWinRate: number,
    topNTokens: number,
    includeGraph: boolean,
  ): Promise<SmartMoneyFlowResult> {
    // Resolve seed wallets:
    //   - User provided → use as-is (BYO path, unchanged)
    //   - Default → try programmatic derivation
    //   - Derivation failed → fallback curated list
    let seeds: readonly string[];
    let seedSource: 'user' | 'derived' | 'fallback';

    if (userWallets && userWallets.length > 0) {
      seeds = Array.from(new Set(userWallets));
      seedSource = 'user';
    } else {
      const derived = await this.deriveDefaultSeeds();
      if (derived && derived.length >= MIN_DERIVED_SEEDS) {
        seeds = derived;
        seedSource = 'derived';
      } else {
        seeds = DEFAULT_SMART_MONEY_SEEDS;
        seedSource = 'fallback';
      }
    }

    const cacheKey = `smart-money:${seedSource}:${seeds.length}:${lookbackDays}:${minWinRate}:${topNTokens}:${includeGraph}:${seeds.slice(0, 3).join(',')}`;
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
      seed_source: seedSource,
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
