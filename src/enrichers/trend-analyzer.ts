import type { TokenAnalyzer, TokenEnrichment } from './token-analyzer';
import type { WalletProfiler, WalletEnrichment } from './wallet-profiler';
import type { SnapshotStore, TokenSnapshot, WalletSnapshot } from './snapshot-store';
import type { Cache } from '../cache';
import { CACHE_TTL } from '../config';
import { formatTimestamp } from '../utils/normalize';

// --- Types ---

export type Direction = 'improving' | 'declining' | 'stable' | 'insufficient_data';

export interface MetricDelta {
  metric: string;
  current: number;
  oldest: number;
  absolute_change: number;
  pct_change: number;
  direction: Direction;
}

export interface TokenTrend {
  current: TokenEnrichment;
  snapshots: TokenSnapshot[];
  lookback_days: number;
  data_points: number;
  deltas: MetricDelta[];
  overall_direction: Direction;
  last_updated: string;
}

export interface WalletHistory {
  current: WalletEnrichment;
  snapshots: WalletSnapshot[];
  lookback_days: number;
  data_points: number;
  deltas: MetricDelta[];
  position_changes: {
    added: string[];
    removed: string[];
  };
  overall_direction: Direction;
  last_updated: string;
}

// --- Class ---

export class TrendAnalyzer {
  constructor(
    private tokenAnalyzer: TokenAnalyzer,
    private walletProfiler: WalletProfiler,
    private snapshotStore: SnapshotStore,
    private cache: Cache,
  ) {}

  async analyzeTokenTrend(mint: string, lookbackDays: number): Promise<TokenTrend> {
    const cacheKey = `trend:token:${mint}:${lookbackDays}d`;
    const cached = await this.cache.get<TokenTrend>(cacheKey);
    if (cached) return cached;

    const [current, snapshots] = await Promise.all([
      this.tokenAnalyzer.enrich(mint, true),
      this.snapshotStore.getTokenSnapshots(mint, lookbackDays),
    ]);

    let deltas: MetricDelta[] = [];
    let overall: Direction = 'insufficient_data';

    if (snapshots.length > 0) {
      const oldest = snapshots[0];
      deltas = [
        computeDelta('price', current.price_usd, oldest.price_usd, true),
        computeDelta('market_cap', current.market_cap, oldest.market_cap, true),
        computeDelta('volume_24h', current.volume_24h, oldest.volume_24h, true),
        computeDelta('liquidity', current.liquidity, oldest.liquidity, true),
        computeDelta('risk_flags', current.risk_flags.length, oldest.risk_flag_count, false),
      ];

      if (current.concentration && oldest.concentration_hhi !== null) {
        deltas.push(computeDelta('concentration_hhi', current.concentration.herfindahl_index, oldest.concentration_hhi, false));
      }

      overall = majorityDirection(deltas);
    }

    const result: TokenTrend = {
      current,
      snapshots,
      lookback_days: lookbackDays,
      data_points: snapshots.length,
      deltas,
      overall_direction: overall,
      last_updated: formatTimestamp(),
    };

    if (snapshots.length > 0) {
      await this.cache.set(cacheKey, result, CACHE_TTL.trend);
    }

    return result;
  }

  async analyzeWalletHistory(address: string, lookbackDays: number): Promise<WalletHistory> {
    const cacheKey = `trend:wallet:${address}:${lookbackDays}d`;
    const cached = await this.cache.get<WalletHistory>(cacheKey);
    if (cached) return cached;

    const [current, snapshots] = await Promise.all([
      this.walletProfiler.enrich(address, 'full'),
      this.snapshotStore.getWalletSnapshots(address, lookbackDays),
    ]);

    let deltas: MetricDelta[] = [];
    let positionChanges = { added: [] as string[], removed: [] as string[] };
    let overall: Direction = 'insufficient_data';

    if (snapshots.length > 0) {
      const oldest = snapshots[0];
      deltas = [
        computeDelta('portfolio_value', current.portfolio_value_usd, oldest.portfolio_value_usd, true),
        computeDelta('sol_balance', current.sol_balance, oldest.sol_balance, true),
        computeDelta('token_count', current.token_count, oldest.token_count, true),
        computeDelta('risk_score', current.risk_score, oldest.risk_score, false),
        computeDelta('activity_30d', current.tx_count_30d, oldest.tx_count_30d, true),
      ];

      // Position changes
      const currentMints = new Set(current.top_holdings.slice(0, 5).map(h => h.mint));
      const oldestMints = new Set(oldest.top_holding_mints);
      positionChanges = {
        added: [...currentMints].filter(m => !oldestMints.has(m)),
        removed: [...oldestMints].filter(m => !currentMints.has(m)),
      };

      overall = majorityDirection(deltas);
    }

    const result: WalletHistory = {
      current,
      snapshots,
      lookback_days: lookbackDays,
      data_points: snapshots.length,
      deltas,
      position_changes: positionChanges,
      overall_direction: overall,
      last_updated: formatTimestamp(),
    };

    if (snapshots.length > 0) {
      await this.cache.set(cacheKey, result, CACHE_TTL.trend);
    }

    return result;
  }
}

// --- Pure Helpers (exported for testing) ---

export function computeDelta(
  metric: string,
  current: number,
  historical: number,
  higherIsBetter: boolean,
): MetricDelta {
  const absoluteChange = current - historical;
  const pctChange = historical !== 0 ? (absoluteChange / Math.abs(historical)) * 100 : 0;

  let direction: Direction;
  if (Math.abs(pctChange) < 2) {
    direction = 'stable';
  } else if ((pctChange > 0 && higherIsBetter) || (pctChange < 0 && !higherIsBetter)) {
    direction = 'improving';
  } else {
    direction = 'declining';
  }

  return {
    metric,
    current: Math.round(current * 1e6) / 1e6,
    oldest: Math.round(historical * 1e6) / 1e6,
    absolute_change: Math.round(absoluteChange * 1e6) / 1e6,
    pct_change: Math.round(pctChange * 100) / 100,
    direction,
  };
}

function majorityDirection(deltas: MetricDelta[]): Direction {
  const counts = { improving: 0, declining: 0, stable: 0 };
  for (const d of deltas) {
    if (d.direction !== 'insufficient_data') counts[d.direction]++;
  }
  if (counts.improving > counts.declining) return 'improving';
  if (counts.declining > counts.improving) return 'declining';
  return 'stable';
}
