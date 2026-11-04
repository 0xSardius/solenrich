// Phoenix perps client (order-book perps on Solana, perp-api.phoenix.trade). Public REST, no key needed today
// (the docs mark some routes as bearer-auth; the canary probe catches it if that becomes enforced).
//
// Units, verified 2026-11-03 against Phoenix's docs and live data (Phase 0):
//   - Funding: `fundingRatePercentage` is percent PER HOUR (Phoenix quotes an 8h rate F and settles F/8 hourly;
//     SOL at the zero-premium baseline read 0.00123 = 0.01% / 8). APR = pct × 24 × 365. Positive = longs pay shorts.
//   - Open interest: base-asset units (SOL, shares) → × mark for USD. Matches statsSnapshot.openInterestBaseLots / 10^baseLotsDecimals.
//   - stats `spot_price` is Phoenix's index price. For equities it is externally sourced 24/5 (Sun 8pm – Fri 8pm ET)
//     and order-book "impact" priced outside that window.
//   - Stats points are written only on change: a quiet market can return no points in a short window.

import { CACHE_TTL } from '../config';
import type { Cache } from '../cache';
import { drain } from '../utils/drain';

const BASE = 'https://perp-api.phoenix.trade';
const TIMEOUT_MS = 5000;
/** After a failed request, skip Phoenix for this long instead of waiting on it each call. */
export const PHOENIX_RETRY_MS = 5 * 60_000;
const CONFIG_TTL_S = 3600;

export type PhoenixMarket = 'SOL' | 'BTC' | 'ETH';

export interface PhoenixMarketConfig {
  symbol: string;
  marketStatus: string;
  baseLotsDecimals: number;
  takerFee: number;
  makerFee: number;
  openInterestCapBaseLots?: string | number;
  fundingIntervalSeconds?: number;
  commodityMetadata?: { isCommodity?: boolean; isAfterHours?: boolean } | null;
}

export interface PhoenixStatsPoint {
  timestamp: string;
  mark_price: number;
  spot_price: number;
  open_interest: number;
}

export interface PhoenixSnapshot {
  symbol: string;
  mark_price_usd: number;
  /** Phoenix index ("spot") price. */
  index_price_usd: number;
  open_interest_base: number;
  open_interest_usd: number;
  /** Percent per hour, signed (positive = longs pay). */
  funding_hourly_pct: number;
  /** funding_hourly_pct × 24 × 365. */
  funding_apr_pct: number;
  taker_fee_pct: number;
  maker_fee_pct: number;
  /** OI cap in USD at the current mark; null when the config has none. */
  oi_cap_usd: number | null;
  stats_at: string;
}

/** Pure: the newest point by timestamp (Phoenix does not document the sort order). */
export function latestPoint<T extends { timestamp: string | number }>(points: T[] | undefined): T | null {
  if (!points?.length) return null;
  // Stats use ISO strings, funding uses unix seconds.
  const t = (p: T) => (typeof p.timestamp === 'number' ? p.timestamp * 1000 : Date.parse(p.timestamp));
  return points.reduce((a, b) => (t(b) > t(a) ? b : a));
}

/** Pure: combine config + latest stats point + latest hourly funding into a snapshot. */
export function buildPhoenixSnapshot(cfg: PhoenixMarketConfig, stats: PhoenixStatsPoint, fundingHourlyPct: number): PhoenixSnapshot {
  const mark = stats.mark_price;
  const capBase = cfg.openInterestCapBaseLots != null ? Number(cfg.openInterestCapBaseLots) / 10 ** cfg.baseLotsDecimals : null;
  return {
    symbol: cfg.symbol,
    mark_price_usd: mark,
    index_price_usd: stats.spot_price,
    open_interest_base: stats.open_interest,
    open_interest_usd: Math.round(stats.open_interest * mark),
    funding_hourly_pct: fundingHourlyPct,
    funding_apr_pct: fundingHourlyPct * 24 * 365,
    taker_fee_pct: cfg.takerFee * 100,
    maker_fee_pct: cfg.makerFee * 100,
    oi_cap_usd: capBase != null && Number.isFinite(capBase) ? Math.round(capBase * mark) : null,
    stats_at: stats.timestamp,
  };
}

export class PhoenixPerpsClient {
  private downUntil = 0;
  constructor(private cache: Cache) {}

  /** 'unreachable' for PHOENIX_RETRY_MS after a failed request. */
  sourceStatus(now = Date.now()): 'ok' | 'unreachable' {
    return now < this.downUntil ? 'unreachable' : 'ok';
  }

  private async get<T>(path: string): Promise<T | null> {
    if (this.sourceStatus() === 'unreachable') return null;
    try {
      const res = await fetch(BASE + path, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) {
        await drain(res);
        // A 404 for one symbol is not an outage; anything else is.
        if (res.status !== 404) this.downUntil = Date.now() + PHOENIX_RETRY_MS;
        return null;
      }
      const body = (await res.json()) as T;
      this.downUntil = 0;
      return body;
    } catch (err) {
      console.warn('[phoenix] request failed:', path, (err as Error).message);
      this.downUntil = Date.now() + PHOENIX_RETRY_MS;
      return null;
    }
  }

  async getConfigs(): Promise<PhoenixMarketConfig[] | null> {
    const key = 'phoenix:markets';
    const cached = await this.cache.get<PhoenixMarketConfig[]>(key);
    if (cached) return cached;
    const list = await this.get<PhoenixMarketConfig[] | { markets: PhoenixMarketConfig[] }>('/exchange/markets');
    const markets = Array.isArray(list) ? list : list?.markets;
    if (!markets?.length) return null;
    await this.cache.set(key, markets, CONFIG_TTL_S);
    return markets;
  }

  private async latestStats(symbol: string): Promise<PhoenixStatsPoint | null> {
    // Points are written on change, so widen the window when a quiet market returns none.
    for (const minutes of [2, 60]) {
      const start = new Date(Date.now() - minutes * 60_000).toISOString();
      const body = await this.get<{ stats?: PhoenixStatsPoint[] }>(`/v1/market/${symbol}/stats?start_time=${encodeURIComponent(start)}`);
      if (!body) return null;
      const p = latestPoint(body.stats);
      if (p) return p;
    }
    return null;
  }

  private async latestFundingPct(symbol: string): Promise<number | null> {
    const body = await this.get<{ rates?: { timestamp: number; fundingRatePercentage: string }[] }>(`/v1/funding/${symbol}/rates?limit=2`);
    const p = latestPoint(body?.rates);
    const v = p ? Number(p.fundingRatePercentage) : NaN;
    return Number.isFinite(v) ? v : null;
  }

  /** Live snapshot for one symbol, or null when Phoenix does not list it or did not answer. */
  async getMarket(symbol: string): Promise<PhoenixSnapshot | null> {
    const key = `phoenix:market:${symbol}`;
    const cached = await this.cache.get<PhoenixSnapshot>(key);
    if (cached) return cached;
    const configs = await this.getConfigs();
    const cfg = configs?.find((m) => m.symbol === symbol && m.marketStatus === 'active');
    if (!cfg) return null;
    const [stats, funding] = await Promise.all([this.latestStats(symbol), this.latestFundingPct(symbol)]);
    if (!stats || funding == null) return null;
    const snap = buildPhoenixSnapshot(cfg, stats, funding);
    await this.cache.set(key, snap, CACHE_TTL.perpsMarket);
    return snap;
  }
}
