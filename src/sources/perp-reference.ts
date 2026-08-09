// Cross-chain perps reference rates — Hyperliquid + dYdX v4.
// Public APIs, no auth, no geo-blocks (CEXes Binance/Bybit are US-restricted).
// Used as reference benchmarks in perps-cross-venue-funding alongside
// Solana-native venues (Jupiter Perps, Adrena).

import { CACHE_TTL } from '../config';
import type { Cache } from '../cache';
import { drain } from '../utils/drain';

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

/** One normalized Hyperliquid open position (from clearinghouseState). */
export interface HlPositionRaw {
  coin: string;
  dir: 'long' | 'short';
  size_tokens: number;
  notional_usd: number;
  entry_px: number;
  current_px: number;
  unrealized_pnl_usd: number;
  pnl_pct: number;            // returnOnEquity * 100 (uPnL on margin used)
  leverage: number;
  liquidation_px: number | null;
  distance_to_liq_pct: number | null;
  margin_used_usd: number;
}
/** A Hyperliquid trader's account snapshot. */
export interface HlTraderState {
  address: string;
  account_value_usd: number;
  total_notional_usd: number;
  margin_used_usd: number;
  withdrawable_usd: number;
  positions: HlPositionRaw[];
}
/** Realized+unrealized trading PnL over rolling windows (from portfolio). */
export interface HlPnl {
  week_usd: number | null;
  month_usd: number | null;
  all_time_usd: number | null;
}

/** A filtered, copyable-candidate leaderboard row (MM/dust already excluded). */
export interface HlLeaderboardCandidate {
  address: string;
  account_value_usd: number;
  month_roi: number;
  week_roi: number;
  month_vlm: number;
  turnover: number;          // month_vlm / account_value (MM/HFT signature)
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
      if (!res.ok) { await drain(res); return null; }
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

    // Some Hyperliquid contracts are scaled (k-prefix = 1000-unit contract).
    // Normalize back to per-token price so basis comparisons against spot
    // (which prices the bare token) match units. OI is computed in USD via
    // the contract-unit price × contract-unit OI count, so it's unaffected.
    const isScaled = symbol.startsWith('k');
    const contractMultiplier = isScaled ? 1000 : 1;
    const normalizedMark = ctx.markPx / contractMultiplier;
    const normalizedOracle = ctx.oraclePx / contractMultiplier;
    // OI USD = (contract-unit OI count) × (contract-unit price)
    // = (token count / multiplier) × (token price × multiplier) — multiplier cancels.
    const oiUsd = ctx.openInterest * ctx.oraclePx;

    return {
      venue: 'hyperliquid',
      symbol,
      funding_hourly_pct: fundingHourlyPct,
      annualized_pct: annualizedPct,
      mark_price_usd: Number.isFinite(normalizedMark) ? normalizedMark : null,
      oracle_price_usd: Number.isFinite(normalizedOracle) ? normalizedOracle : null,
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
      if (!res.ok) { await drain(res); return null; }
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

  /**
   * Hyperliquid clearinghouseState — a trader's live perp positions + margin summary.
   * Public by EVM address; no auth. This is the transparency that makes HL smart-money
   * tracking possible (every position is on-chain and readable).
   */
  async getHlTraderState(address: string): Promise<HlTraderState | null> {
    const cacheKey = `hl:state:${address}`;
    const cached = await this.cache.get<HlTraderState>(cacheKey);
    if (cached) return cached;
    try {
      const res = await fetchWithTimeout('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'clearinghouseState', user: address }),
      });
      if (!res.ok) { await drain(res); return null; }
      const data = (await res.json()) as any;
      const ms = data?.marginSummary ?? {};
      const positions: HlPositionRaw[] = [];
      for (const ap of data?.assetPositions ?? []) {
        const p = ap?.position;
        if (!p) continue;
        const szi = Number(p.szi);
        if (!szi) continue;
        const notional = Math.abs(Number(p.positionValue));
        const size = Math.abs(szi);
        const currentPx = size > 0 ? notional / size : 0;
        const liqPx = p.liquidationPx != null ? Number(p.liquidationPx) : null;
        const distToLiq =
          liqPx && currentPx > 0 ? (Math.abs(currentPx - liqPx) / currentPx) * 100 : null;
        positions.push({
          coin: p.coin,
          dir: szi > 0 ? 'long' : 'short',
          size_tokens: size,
          notional_usd: notional,
          entry_px: Number(p.entryPx),
          current_px: currentPx,
          unrealized_pnl_usd: Number(p.unrealizedPnl),
          pnl_pct: Number(p.returnOnEquity) * 100,
          leverage: Number(p.leverage?.value ?? 0),
          liquidation_px: liqPx,
          distance_to_liq_pct: distToLiq,
          margin_used_usd: Number(p.marginUsed ?? 0),
        });
      }
      const state: HlTraderState = {
        address,
        account_value_usd: Number(ms.accountValue ?? 0),
        total_notional_usd: Number(ms.totalNtlPos ?? 0),
        margin_used_usd: Number(ms.totalMarginUsed ?? 0),
        withdrawable_usd: Number(data?.withdrawable ?? 0),
        positions,
      };
      await this.cache.set(cacheKey, state, CACHE_TTL.perpsTrader);
      return state;
    } catch (err) {
      console.warn(`[perp-ref:hyperliquid] state fetch failed:`, (err as Error).message);
      return null;
    }
  }

  /** Hyperliquid portfolio — trading PnL over rolling windows (pnlHistory tail). */
  async getHlPnl(address: string): Promise<HlPnl | null> {
    const cacheKey = `hl:pnl:${address}`;
    const cached = await this.cache.get<HlPnl>(cacheKey);
    if (cached) return cached;
    try {
      const res = await fetchWithTimeout('https://api.hyperliquid.xyz/info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'portfolio', user: address }),
      });
      if (!res.ok) { await drain(res); return null; }
      const data = (await res.json()) as Array<[string, { pnlHistory?: Array<[number, string]> }]>;
      const lastPnl = (window: string): number | null => {
        const row = data?.find?.((d) => d[0] === window);
        const hist = row?.[1]?.pnlHistory;
        if (!hist?.length) return null;
        const v = Number(hist[hist.length - 1][1]);
        return Number.isFinite(v) ? v : null;
      };
      const pnl: HlPnl = {
        week_usd: lastPnl('week'),
        month_usd: lastPnl('month'),
        all_time_usd: lastPnl('allTime'),
      };
      await this.cache.set(cacheKey, pnl, CACHE_TTL.perpsTrader);
      return pnl;
    } catch (err) {
      console.warn(`[perp-ref:hyperliquid] portfolio fetch failed:`, (err as Error).message);
      return null;
    }
  }

  /**
   * Hyperliquid public leaderboard, pre-filtered to copyable directional candidates:
   * account-value band (exclude dust + mega-funds) + turnover MM/HFT filter + positive
   * month ROI, sorted by month ROI. This is the validated funnel (see
   * test/hl-copy-edge-validation.ts) — ranking by absolute PnL surfaces market-makers,
   * so we band + turnover-filter instead. Returns top 100 candidates (consistency is
   * checked per-trader downstream via portfolio PnL). Cached.
   */
  async getHlLeaderboard(opts?: {
    minAcct?: number;
    maxAcct?: number;
    maxTurnover?: number;
  }): Promise<HlLeaderboardCandidate[] | null> {
    const minAcct = opts?.minAcct ?? 100_000;
    const maxAcct = opts?.maxAcct ?? 20_000_000;
    const maxTurnover = opts?.maxTurnover ?? 40;
    const cacheKey = `hl:leaderboard:${minAcct}:${maxAcct}:${maxTurnover}`;
    const cached = await this.cache.get<HlLeaderboardCandidate[]>(cacheKey);
    if (cached) return cached;

    // The leaderboard is a multi-MB payload — give it a longer timeout than the
    // per-market reference calls.
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 9000);
    try {
      const res = await fetch('https://stats-data.hyperliquid.xyz/Mainnet/leaderboard', {
        signal: controller.signal,
      });
      if (!res.ok) { await drain(res); return null; }
      const data = (await res.json()) as any;
      const rows: any[] = data?.leaderboardRows ?? [];
      const out: HlLeaderboardCandidate[] = [];
      for (const r of rows) {
        const acct = Number(r.accountValue);
        if (!Number.isFinite(acct) || acct < minAcct || acct > maxAcct) continue;
        const perfs: Array<[string, any]> = r.windowPerformances;
        const monthRow = perfs?.find?.((p) => p[0] === 'month');
        if (!monthRow) continue;
        const monthVlm = Number(monthRow[1].vlm);
        const monthRoi = Number(monthRow[1].roi);
        if (!(monthVlm > 0) || !(monthRoi > 0)) continue;
        const turnover = monthVlm / acct;
        if (turnover > maxTurnover) continue; // MM/HFT
        const weekRow = perfs?.find?.((p) => p[0] === 'week');
        out.push({
          address: r.ethAddress,
          account_value_usd: acct,
          month_roi: monthRoi,
          week_roi: weekRow ? Number(weekRow[1].roi) : 0,
          month_vlm: monthVlm,
          turnover,
        });
      }
      out.sort((a, b) => b.month_roi - a.month_roi);
      const top = out.slice(0, 100);
      await this.cache.set(cacheKey, top, CACHE_TTL.hlSmartMoney);
      return top;
    } catch (err) {
      console.warn(`[perp-ref:hyperliquid] leaderboard fetch failed:`, (err as Error).message);
      return null;
    } finally {
      clearTimeout(t);
    }
  }
}
