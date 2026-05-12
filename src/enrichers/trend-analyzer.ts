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

export interface PortfolioHistory {
  address: string;
  current: {
    portfolio_value_usd: number;
    sol_balance: number;
    token_count: number;
    risk_score: number;
    risk_level: string;
  };
  /** Oldest to newest snapshot points. Gaps mean the wallet was not queried that day. */
  series: WalletSnapshot[];
  summary: {
    data_points: number;
    lookback_days: number;
    period_start: string | null;
    period_end: string | null;
    peak: { date: string; portfolio_value_usd: number } | null;
    trough: { date: string; portfolio_value_usd: number } | null;
    max_drawdown_pct: number | null;
    average_portfolio_value_usd: number | null;
    change_vs_start_pct: number | null;
  };
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

  /**
   * Full time-series portfolio history. Distinct from analyzeWalletHistory
   * which focuses on two-point deltas — this returns the series for charting
   * + summary stats (peak, trough, max drawdown, avg).
   */
  async analyzePortfolioHistory(address: string, lookbackDays: number): Promise<PortfolioHistory> {
    const cacheKey = `portfolio-history:${address}:${lookbackDays}d`;
    const cached = await this.cache.get<PortfolioHistory>(cacheKey);
    if (cached) return cached;

    const [current, snapshots] = await Promise.all([
      this.walletProfiler.enrich(address, 'light'),
      this.snapshotStore.getWalletSnapshots(address, lookbackDays),
    ]);

    // Append today's live point if not already in the series — gives agents the
    // current-vs-history view in one response without a second call.
    const todayKey = new Date().toISOString().slice(0, 10);
    const series: WalletSnapshot[] = [...snapshots];
    if (!series.some((s) => s.date === todayKey)) {
      series.push({
        date: todayKey,
        sol_balance: current.sol_balance,
        portfolio_value_usd: current.portfolio_value_usd,
        token_count: current.token_count,
        nft_count: current.nft_count,
        tx_count_30d: current.tx_count_30d,
        risk_score: current.risk_score,
        risk_level: current.risk_level,
        label_count: current.labels.length,
        defi_position_count: current.defi_positions.length,
        top_holding_mints: current.top_holdings.slice(0, 5).map((h) => h.mint),
      });
    }

    const summary = computePortfolioSummary(series, lookbackDays);

    const result: PortfolioHistory = {
      address,
      current: {
        portfolio_value_usd: current.portfolio_value_usd,
        sol_balance: current.sol_balance,
        token_count: current.token_count,
        risk_score: current.risk_score,
        risk_level: current.risk_level,
      },
      series,
      summary,
      last_updated: formatTimestamp(),
    };

    if (series.length > 0) {
      await this.cache.set(cacheKey, result, CACHE_TTL.trend);
    }

    return result;
  }
}

/** Compute peak, trough, drawdown, avg, change-vs-start from a snapshot series. */
function computePortfolioSummary(
  series: WalletSnapshot[],
  lookbackDays: number,
): PortfolioHistory['summary'] {
  if (series.length === 0) {
    return {
      data_points: 0,
      lookback_days: lookbackDays,
      period_start: null,
      period_end: null,
      peak: null,
      trough: null,
      max_drawdown_pct: null,
      average_portfolio_value_usd: null,
      change_vs_start_pct: null,
    };
  }

  let peak = series[0];
  let trough = series[0];
  let runningPeak = series[0].portfolio_value_usd;
  let maxDrawdownPct = 0;
  let sum = 0;

  for (const s of series) {
    if (s.portfolio_value_usd > peak.portfolio_value_usd) peak = s;
    if (s.portfolio_value_usd < trough.portfolio_value_usd) trough = s;
    if (s.portfolio_value_usd > runningPeak) runningPeak = s.portfolio_value_usd;
    if (runningPeak > 0) {
      const drawdown = ((runningPeak - s.portfolio_value_usd) / runningPeak) * 100;
      if (drawdown > maxDrawdownPct) maxDrawdownPct = drawdown;
    }
    sum += s.portfolio_value_usd;
  }

  const first = series[0];
  const last = series[series.length - 1];
  const changeVsStart =
    first.portfolio_value_usd > 0
      ? ((last.portfolio_value_usd - first.portfolio_value_usd) / first.portfolio_value_usd) * 100
      : null;

  return {
    data_points: series.length,
    lookback_days: lookbackDays,
    period_start: first.date,
    period_end: last.date,
    peak: { date: peak.date, portfolio_value_usd: peak.portfolio_value_usd },
    trough: { date: trough.date, portfolio_value_usd: trough.portfolio_value_usd },
    max_drawdown_pct: Math.round(maxDrawdownPct * 100) / 100,
    average_portfolio_value_usd: Math.round((sum / series.length) * 100) / 100,
    change_vs_start_pct: changeVsStart === null ? null : Math.round(changeVsStart * 100) / 100,
  };
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
