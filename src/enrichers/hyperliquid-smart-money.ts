// Hyperliquid smart-money aggregator. Productizes the validated copy-edge funnel
// (test/hl-copy-edge-validation.ts): scan the HL leaderboard, exclude market-makers
// and dust (band + turnover filter — done in PerpReferenceClient.getHlLeaderboard),
// keep only consistent directional traders (week+month PnL > 0, not a systematic
// book), then AGGREGATE their positions into a "where is smart money positioned"
// consensus signal — plus a per-trader drill-down ranked by robust absolute PnL.
//
// Positioning-first by design: individual ROI is noisy/survivorship-flattered, so the
// defensible product is the cross-trader consensus, not "copy this one genius."

import type { PerpReferenceClient } from '../sources/perp-reference';
import type { HyperliquidAnalyzer, HyperliquidTraderProfile } from './hyperliquid-analyzer';
import type { Cache } from '../cache';
import { CACHE_TTL } from '../config';

const CANDIDATE_POOL = 35;       // top-by-ROI candidates to inspect (bounds latency/cost)
const CONCURRENCY = 5;
const MAX_POSITIONS = 15;        // > this = systematic/MM book, not directional
const STRONG_MIN_TRADERS = 4;    // one-sided with >= this many = strong conviction
const CONSENSUS_MIN_TRADERS = 3; // surface as consensus only with >= this many traders

export type Conviction = 'strong' | 'moderate' | 'mixed';

export interface CoinPositioning {
  coin: string;
  long_traders: number;
  short_traders: number;
  net_notional_usd: number;
  gross_notional_usd: number;
  bias: 'long' | 'short' | 'balanced';
  conviction: Conviction;
}

export interface SmartTrader {
  address: string;
  account_value_usd: number;
  month_roi: number;
  week_roi: number;
  month_pnl_usd: number | null;
  profile: HyperliquidTraderProfile['profile'];
  directional_bias: 'long' | 'short' | 'neutral';
  top_positions: Array<{ coin: string; dir: 'long' | 'short'; leverage: number; notional_usd: number; pnl_pct: number }>;
}

export interface HyperliquidSmartMoney {
  generated_at: number;
  market: string | null;
  trader_universe: {
    leaderboard_candidates: number; // after band + MM filter
    inspected: number;              // candidate pool actually pulled
    qualified: number;              // consistent + directional (the signal set)
  };
  positioning: CoinPositioning[];
  consensus_longs: string[];
  consensus_shorts: string[];
  top_traders: SmartTrader[];
  summary: string;
}

function convictionFor(long: number, short: number): Conviction {
  const total = long + short;
  const dom = Math.max(long, short);
  if (total >= STRONG_MIN_TRADERS && dom === total) return 'strong';
  if (total >= CONSENSUS_MIN_TRADERS && dom / total >= 0.7) return 'moderate';
  return 'mixed';
}

async function mapPool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}

export class HyperliquidSmartMoneyAnalyzer {
  constructor(
    private ref: PerpReferenceClient,
    private trader: HyperliquidAnalyzer,
    private cache: Cache,
  ) {}

  /** Compute the full model once (cached); read-side filters (market/topN) apply on top. */
  private async computeFull(): Promise<HyperliquidSmartMoney> {
    const now = Date.now();
    const empty: HyperliquidSmartMoney = {
      generated_at: now,
      market: null,
      trader_universe: { leaderboard_candidates: 0, inspected: 0, qualified: 0 },
      positioning: [],
      consensus_longs: [],
      consensus_shorts: [],
      top_traders: [],
      summary: 'Hyperliquid leaderboard unavailable.',
    };

    const candidates = await this.ref.getHlLeaderboard();
    if (!candidates || candidates.length === 0) return empty;

    const pool = candidates.slice(0, CANDIDATE_POOL);
    const profiles = await mapPool(pool, CONCURRENCY, async (c) => ({
      c,
      p: await this.trader.analyzeTrader(c.address),
    }));

    // Qualified = consistent (week+month PnL > 0) AND directional (1–15 positions)
    const qualified = profiles.filter(
      ({ p }) =>
        p.has_positions &&
        p.positions.length >= 1 &&
        p.positions.length <= MAX_POSITIONS &&
        p.pnl !== null &&
        (p.pnl.week_usd ?? 0) > 0 &&
        (p.pnl.month_usd ?? 0) > 0,
    );

    // Aggregate positioning per coin
    const byCoin = new Map<string, { long: number; short: number; net: number; gross: number }>();
    for (const { p } of qualified) {
      for (const pos of p.positions) {
        const c = byCoin.get(pos.coin) ?? { long: 0, short: 0, net: 0, gross: 0 };
        if (pos.dir === 'long') c.long++;
        else c.short++;
        c.net += pos.dir === 'long' ? pos.notional_usd : -pos.notional_usd;
        c.gross += pos.notional_usd;
        byCoin.set(pos.coin, c);
      }
    }
    const positioning: CoinPositioning[] = [...byCoin.entries()]
      .map(([coin, c]) => ({
        coin,
        long_traders: c.long,
        short_traders: c.short,
        net_notional_usd: Math.round(c.net),
        gross_notional_usd: Math.round(c.gross),
        bias: c.net > 0 ? ('long' as const) : c.net < 0 ? ('short' as const) : ('balanced' as const),
        conviction: convictionFor(c.long, c.short),
      }))
      .sort((a, b) => b.long_traders + b.short_traders - (a.long_traders + a.short_traders));

    const consensus_longs = positioning
      .filter((p) => p.bias === 'long' && p.conviction !== 'mixed' && p.long_traders + p.short_traders >= CONSENSUS_MIN_TRADERS)
      .map((p) => p.coin);
    const consensus_shorts = positioning
      .filter((p) => p.bias === 'short' && p.conviction !== 'mixed' && p.long_traders + p.short_traders >= CONSENSUS_MIN_TRADERS)
      .map((p) => p.coin);

    // Top traders — ranked by robust absolute month PnL (NOT raw ROI; small-denominator
    // ROI blows up, per the validation).
    const top_traders: SmartTrader[] = qualified
      .map(({ c, p }) => ({
        address: c.address,
        account_value_usd: Math.round(p.account.value_usd),
        month_roi: c.month_roi,
        week_roi: c.week_roi,
        month_pnl_usd: p.pnl?.month_usd ?? null,
        profile: p.profile,
        directional_bias: p.directional_bias,
        top_positions: [...p.positions]
          .sort((a, b) => b.notional_usd - a.notional_usd)
          .slice(0, 5)
          .map((x) => ({
            coin: x.coin,
            dir: x.dir,
            leverage: x.leverage,
            notional_usd: Math.round(x.notional_usd),
            pnl_pct: Math.round(x.pnl_pct * 10) / 10,
          })),
      }))
      .sort((a, b) => (b.month_pnl_usd ?? 0) - (a.month_pnl_usd ?? 0));

    const summary = buildSummary(positioning, qualified.length);

    return {
      generated_at: now,
      market: null,
      trader_universe: {
        leaderboard_candidates: candidates.length,
        inspected: pool.length,
        qualified: qualified.length,
      },
      positioning,
      consensus_longs,
      consensus_shorts,
      top_traders,
      summary,
    };
  }

  async analyze(opts?: { market?: string; topTraders?: number }): Promise<HyperliquidSmartMoney> {
    const market = opts?.market?.toUpperCase().trim() || null;
    const topN = Math.min(Math.max(opts?.topTraders ?? 10, 1), 25);

    const cacheKey = 'hl:smartmoney:full';
    let full = await this.cache.get<HyperliquidSmartMoney>(cacheKey);
    if (!full) {
      full = await this.computeFull();
      await this.cache.set(cacheKey, full, CACHE_TTL.hlSmartMoney);
    }

    // Read-side filters: optional single-market focus + top-trader slice
    const positioning = market ? full.positioning.filter((p) => p.coin === market) : full.positioning;
    const top_traders = market
      ? full.top_traders.filter((t) => t.top_positions.some((p) => p.coin === market)).slice(0, topN)
      : full.top_traders.slice(0, topN);

    return {
      ...full,
      market,
      positioning,
      top_traders,
      summary: market
        ? buildMarketSummary(market, positioning)
        : full.summary,
    };
  }
}

function biasWord(p: CoinPositioning): string {
  return `${p.bias === 'long' ? 'net long' : p.bias === 'short' ? 'net short' : 'balanced'}`;
}

function buildSummary(positioning: CoinPositioning[], qualified: number): string {
  if (qualified === 0 || positioning.length === 0) {
    return 'No consistent directional Hyperliquid traders currently hold positions.';
  }
  const top = positioning.slice(0, 3).map((p) => `${p.coin} ${p.long_traders}L/${p.short_traders}S (${biasWord(p)})`);
  return `${qualified} consistently-profitable HL traders tracked. Strongest positioning: ${top.join(', ')}.`;
}

function buildMarketSummary(market: string, positioning: CoinPositioning[]): string {
  const p = positioning[0];
  if (!p) return `No consistent HL smart-money positioning in ${market} right now.`;
  return `HL smart money on ${market}: ${p.long_traders} long / ${p.short_traders} short — ${biasWord(p)} (${p.conviction} conviction).`;
}
