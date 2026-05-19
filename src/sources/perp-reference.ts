// Cross-chain perps reference rates — Hyperliquid + dYdX v4.
// Public APIs, no auth, no geo-blocks (CEXes Binance/Bybit are US-restricted).
// Used as reference benchmarks in perps-cross-venue-funding alongside
// Solana-native venues (Jupiter Perps, Adrena).

import { CACHE_TTL } from '../config';
import type { Cache } from '../cache';

export type ReferenceVenue = 'hyperliquid' | 'dydx-v4';
export type ReferenceMarket = 'SOL' | 'BTC' | 'ETH' | 'BONK';

/** Standardized output across reference venues. */
export interface PerpReferenceSnapshot {
  venue: ReferenceVenue;
  symbol: string;
  /** Per-hour funding rate as percent (0.01 = 1bp = 0.01%/hr). */
  funding_hourly_pct: number;
  /** Annualized: hourly_pct * 24 * 365. */
  annualized_pct: number;
  mark_price_usd: number | null;
  oracle_price_usd: number | null;
  open_interest_usd: number | null;
  fetched_at: number;
}

const HL_SYMBOL: Record<ReferenceMarket, string | null> = {
  SOL: 'SOL',
  BTC: 'BTC',
  ETH: 'ETH',
  BONK: 'kBONK',  // Hyperliquid uses thousand-unit kBONK
};

const DYDX_SYMBOL: Record<ReferenceMarket, string | null> = {
  SOL: 'SOL-USD',
  BTC: 'BTC-USD',
  ETH: 'ETH-USD',
  BONK: null,  // dYdX v4 doesn't list BONK
};

const REQ_TIMEOUT_MS = 4000;

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), REQ_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

export class PerpReferenceClient {
  constructor(private cache: Cache) {}

  /** Hyperliquid /info metaAndAssetCtxs — one request returns all markets. */
  private async fetchHyperliquidAll(): Promise<Map<string, {
    funding: number;
    markPx: number;
    oraclePx: number;
    openInterest: number;
  }> | null> {
    const cacheKey = `cex:hyperliquid:all`;
    const cached = await this.cache.get<Array<[string, {
      funding: number; markPx: number; oraclePx: number; openInterest: number;
    }]>>(cacheKey);
    if (cached) return new Map(cached);

    try {
      const res = await fetchWithTimeout('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'metaAndAssetCtxs' }),
      });
      if (!res.ok) return null;
      const data = await res.json() as [
        { universe: Array<{ name: string }> },
        Array<{
          funding: string;
          markPx: string;
          oraclePx: string;
          openInterest: string;
        }>,
      ];
      const [meta, ctxs] = data;
      const map = new Map<string, { funding: number; markPx: number; oraclePx: number; openInterest: number }>();
      for (let i = 0; i < meta.universe.length; i++) {
        const name = meta.universe[i].name;
        const ctx = ctxs[i];
        if (!ctx) continue;
        map.set(name, {
          funding: Number(ctx.funding),
          markPx: Number(ctx.markPx),
          oraclePx: Number(ctx.oraclePx),
          openInterest: Number(ctx.openInterest),
        });
      }
      // Cache as entries array for JSON serialization
      await this.cache.set(cacheKey, Array.from(map.entries()), CACHE_TTL.jupiterPrice);
      return map;
    } catch (err) {
      console.warn(`[perp-ref:hyperliquid] fetch failed:`, (err as Error).message);
      return null;
    }
  }

  async getHyperliquid(market: ReferenceMarket): Promise<PerpReferenceSnapshot | null> {
    const symbol = HL_SYMBOL[market];
    if (!symbol) return null;
    const all = await this.fetchHyperliquidAll();
    if (!all) return null;
    const ctx = all.get(symbol);
    if (!ctx) return null;

    const fundingHourlyPct = ctx.funding * 100;
    const annualizedPct = fundingHourlyPct * 24 * 365;
    // Hyperliquid openInterest is in tokens — convert to USD via oraclePx.
    const oiUsd = ctx.openInterest * ctx.oraclePx;

    return {
      venue: 'hyperliquid',
      symbol,
      funding_hourly_pct: fundingHourlyPct,
      annualized_pct: annualizedPct,
      mark_price_usd: Number.isFinite(ctx.markPx) ? ctx.markPx : null,
      oracle_price_usd: Number.isFinite(ctx.oraclePx) ? ctx.oraclePx : null,
      open_interest_usd: Number.isFinite(oiUsd) ? oiUsd : null,
      fetched_at: Date.now(),
    };
  }

  /** dYdX v4 perpetualMarkets — one request returns all markets keyed by ticker. */
  private async fetchDydxAll(): Promise<Map<string, {
    oraclePrice: number;
    nextFundingRate: number;
    openInterest: number;
  }> | null> {
    const cacheKey = `cex:dydx:all`;
    const cached = await this.cache.get<Array<[string, {
      oraclePrice: number; nextFundingRate: number; openInterest: number;
    }]>>(cacheKey);
    if (cached) return new Map(cached);

    try {
      const res = await fetchWithTimeout('https://indexer.dydx.trade/v4/perpetualMarkets');
      if (!res.ok) return null;
      const data = await res.json() as {
        markets: Record<string, {
          ticker: string;
          oraclePrice: string;
          nextFundingRate: string;
          openInterest: string;
        }>;
      };
      const map = new Map<string, { oraclePrice: number; nextFundingRate: number; openInterest: number }>();
      for (const [ticker, m] of Object.entries(data.markets)) {
        map.set(ticker, {
          oraclePrice: Number(m.oraclePrice),
          nextFundingRate: Number(m.nextFundingRate),
          openInterest: Number(m.openInterest),
        });
      }
      await this.cache.set(cacheKey, Array.from(map.entries()), CACHE_TTL.jupiterPrice);
      return map;
    } catch (err) {
      console.warn(`[perp-ref:dydx] fetch failed:`, (err as Error).message);
      return null;
    }
  }

  async getDydx(market: ReferenceMarket): Promise<PerpReferenceSnapshot | null> {
    const symbol = DYDX_SYMBOL[market];
    if (!symbol) return null;
    const all = await this.fetchDydxAll();
    if (!all) return null;
    const m = all.get(symbol);
    if (!m) return null;

    // dYdX v4 nextFundingRate is hourly decimal (e.g. -0.0000041875)
    const fundingHourlyPct = m.nextFundingRate * 100;
    const annualizedPct = fundingHourlyPct * 24 * 365;
    // openInterest is in tokens — convert to USD via oracle price.
    const oiUsd = m.openInterest * m.oraclePrice;

    return {
      venue: 'dydx-v4',
      symbol,
      funding_hourly_pct: fundingHourlyPct,
      annualized_pct: annualizedPct,
      mark_price_usd: Number.isFinite(m.oraclePrice) ? m.oraclePrice : null,
      oracle_price_usd: Number.isFinite(m.oraclePrice) ? m.oraclePrice : null,
      open_interest_usd: Number.isFinite(oiUsd) ? oiUsd : null,
      fetched_at: Date.now(),
    };
  }

  /** Fetch both reference venues for a market in parallel. */
  async getBoth(market: ReferenceMarket): Promise<{
    hyperliquid: PerpReferenceSnapshot | null;
    dydx: PerpReferenceSnapshot | null;
  }> {
    const [hyperliquid, dydx] = await Promise.all([
      this.getHyperliquid(market),
      this.getDydx(market),
    ]);
    return { hyperliquid, dydx };
  }
}
