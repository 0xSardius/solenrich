// xStock basis — "Is there a paid basis trade between this xStock and its Phoenix perp, at my size?"
//
// The trade: buy the xStock (Backed SPL share token) on Jupiter and short the same stock's Phoenix perp.
// The position is delta-neutral and collects Phoenix funding while funding is positive (longs pay shorts).
// The reverse (short the xStock) is not offered: spot xStocks cannot be shorted without a borrow market.
//
// Costs are a real round trip at the requested size:
//   - xStock leg: Jupiter quote USDC → xStock, then a quote selling those tokens back to USDC.
//   - Perp leg: walk Phoenix's order book (sell into bids to open the short, buy from asks to close),
//     plus taker fee on both fills.
// Breakeven = round-trip cost / current daily funding. Current funding is not a forecast; it moves hourly.
// The entry gap (perp above xStock) is reported but not counted in breakeven, so breakeven is conservative.
//
// Buyers: delta-neutral yield agents, RWA / tokenized-equity agents, funding-rate arb bots.

import type { PhoenixPerpsClient, PhoenixSnapshot, PhoenixOrderbook, PhoenixMarketView } from '../sources/phoenix-perps';
import type { JupiterClient } from '../sources/jupiter';
import type { Cache } from '../cache';
import { XSTOCK_MINTS, XSTOCK_DECIMALS, type XstockSymbol } from '../schemas/xstock-basis';

// --- Constants ---

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_DECIMALS = 6;
/** Breakeven at or under this many days of current funding → TRADE. */
export const TRADE_MAX_BREAKEVEN_DAYS = 7;
/** Breakeven at or under this → MARGINAL; over it → NO_TRADE. */
export const MARGINAL_MAX_BREAKEVEN_DAYS = 30;
/** Earnings inside this many days raise a caution flag (gap risk between legs). */
export const EARNINGS_FLAG_DAYS = 7;
const RESULT_TTL_S = 30;

// --- Types ---

export type XstockBasisVerdict = 'TRADE' | 'MARGINAL' | 'NO_TRADE' | 'TOO_THIN' | 'UNAVAILABLE';

export interface XstockBasisResult {
  symbol: XstockSymbol;
  size_usd: number;
  verdict: XstockBasisVerdict;
  /** The only trade this endpoint prices. Null when funding does not pay it. */
  direction: 'long_xstock_short_perp' | null;
  xstock: {
    symbol: string;
    mint: string;
    price_usd: number | null;
    /** USD lost buying then selling size_usd on Jupiter (fees + impact both ways), in bps of size. */
    round_trip_cost_bps: number | null;
  };
  perp: {
    venue: 'phoenix';
    symbol: string;
    mark_price_usd: number | null;
    /** Phoenix index: the real-share price (external 24/5; book-priced after hours). */
    index_price_usd: number | null;
    book_mid_usd: number | null;
    funding_hourly_pct: number | null;
    funding_apr_pct: number | null;
    open_interest_usd: number | null;
    oi_cap_headroom_usd: number | null;
    taker_fee_pct: number | null;
    /** Average fill vs mid when selling size_usd into the bids (open the short). */
    entry_slippage_bps: number | null;
    /** Average fill vs mid when buying it back from the asks (close the short). */
    exit_slippage_bps: number | null;
    /** Entry + exit slippage + 2 × taker fee, in bps. */
    round_trip_cost_bps: number | null;
  };
  basis: {
    xstock_vs_index_bps: number | null;
    perp_vs_index_bps: number | null;
    /** Positive = the perp is above the xStock: favourable to open (not counted in breakeven). */
    perp_vs_xstock_bps: number | null;
  };
  economics: {
    round_trip_cost_bps: number | null;
    funding_daily_bps: number | null;
    breakeven_days: number | null;
    /** 7 days of current funding minus the round trip, in bps of size. */
    net_7d_bps: number | null;
  };
  session: {
    after_hours: boolean | null;
    phoenix_status: string | null;
    next_transition_utc: string | null;
    next_earnings: { date: string; time: string | null; days_until: number } | null;
  };
  codes: string[];
  reasoning: string;
  caveats: string[];
  fetched_at: string;
}

export interface XstockBasisInputs {
  symbol: XstockSymbol;
  size_usd: number;
  xstockPrice: number | null;
  /** Raw xStock units out of the USDC → xStock quote at size_usd. */
  buyOutRaw: number | null;
  /** Raw USDC units out of selling those tokens back. */
  sellBackRaw: number | null;
  snapshot: PhoenixSnapshot | null;
  book: PhoenixOrderbook | null;
  view: PhoenixMarketView | null;
  now: number;
}

// --- Pure helpers ---

const round = (n: number, dp = 1) => Math.round(n * 10 ** dp) / 10 ** dp;
const bps = (a: number, b: number) => round((a / b - 1) * 10_000);

/** Pure: fill `qty` base units against book levels in order. Null when the book cannot fill it. */
export function walkBook(levels: [number, number][], qty: number): { avg_price: number } | null {
  let left = qty;
  let cost = 0;
  for (const [price, size] of levels) {
    const take = Math.min(left, size);
    cost += take * price;
    left -= take;
    if (left <= 1e-12) return { avg_price: cost / qty };
  }
  return null;
}

/** Pure: the next earnings date on or after today (UTC), with whole days until it. */
export function nextEarnings(view: PhoenixMarketView | null, now: number): XstockBasisResult['session']['next_earnings'] {
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const future = (view?.metadata?.earningsDatesV2 ?? [])
    .map((e) => ({ ...e, t: Date.parse(`${e.date}T00:00:00Z`) }))
    .filter((e) => Number.isFinite(e.t) && e.t >= today)
    .sort((a, b) => a.t - b.t)[0];
  if (!future) return null;
  return { date: future.date, time: future.time ?? null, days_until: Math.round((future.t - today) / 86_400_000) };
}

/** Pure: assemble the result and the verdict from upstream reads. */
export function buildXstockBasis(i: XstockBasisInputs): XstockBasisResult {
  const mint = XSTOCK_MINTS[i.symbol];
  const snap = i.snapshot;
  const codes: string[] = [];
  const caveats = [
    'Funding is the current hourly rate, not a forecast. It changes every hour and can turn negative.',
    'xStocks are Backed share tokens: you hold issuer and redemption risk on top of the share price.',
    'Breakeven ignores the entry gap between the perp and the xStock, so it is conservative.',
  ];

  // xStock leg
  const tokens = i.buyOutRaw != null ? i.buyOutRaw / 10 ** XSTOCK_DECIMALS : null;
  const usdBack = i.sellBackRaw != null ? i.sellBackRaw / 10 ** USDC_DECIMALS : null;
  const xRoundTrip = tokens != null && usdBack != null ? round((1 - usdBack / i.size_usd) * 10_000) : null;
  // Jupiter's price API fails at times; the midpoint of the buy and sell fill prices is the fallback.
  const xPrice = i.xstockPrice ?? (tokens && usdBack != null ? round((i.size_usd / tokens + usdBack / tokens) / 2, 4) : null);

  // Perp leg
  const mid = i.book?.mid ?? (i.book?.bids[0] && i.book?.asks[0] ? (i.book.bids[0][0] + i.book.asks[0][0]) / 2 : null);
  const qty = mid ? i.size_usd / mid : null;
  const entry = i.book && qty ? walkBook(i.book.bids, qty) : null;
  const exit = i.book && qty ? walkBook(i.book.asks, qty) : null;
  const entrySlip = entry && mid ? round((1 - entry.avg_price / mid) * 10_000) : null;
  const exitSlip = exit && mid ? round((exit.avg_price / mid - 1) * 10_000) : null;
  const feeBps = snap ? snap.taker_fee_pct * 100 : null;
  const perpRoundTrip = entrySlip != null && exitSlip != null && feeBps != null ? round(entrySlip + exitSlip + 2 * feeBps) : null;
  const headroom = snap?.oi_cap_usd != null ? Math.max(0, snap.oi_cap_usd - snap.open_interest_usd) : null;

  const totalCost = xRoundTrip != null && perpRoundTrip != null ? round(xRoundTrip + perpRoundTrip) : null;
  const dailyBps = snap ? round(snap.funding_hourly_pct * 24 * 100, 2) : null;
  const breakeven = totalCost != null && dailyBps != null && dailyBps > 0 ? round(totalCost / dailyBps, 1) : null;
  const net7d = totalCost != null && dailyBps != null ? round(dailyBps * 7 - totalCost) : null;

  const afterHours = i.view?.commodityMetadata?.isAfterHours ?? null;
  const earnings = nextEarnings(i.view, i.now);
  if (afterHours) {
    codes.push('AFTER_HOURS');
    caveats.push('After hours, Phoenix prices its index from its own book, not the real share. Basis numbers are less reliable.');
  }
  if (earnings && earnings.days_until <= EARNINGS_FLAG_DAYS) codes.push('EARNINGS_SOON');

  // Verdict
  const size = `$${i.size_usd.toLocaleString('en-US')}`;
  let verdict: XstockBasisVerdict;
  let reasoning: string;
  if (!snap || !i.book) {
    verdict = 'UNAVAILABLE';
    codes.unshift('PHOENIX_UNAVAILABLE');
    reasoning = `Phoenix did not return ${i.symbol} market data. Try again in a minute.`;
  } else if (xPrice == null) {
    verdict = 'UNAVAILABLE';
    codes.unshift('XSTOCK_PRICE_UNAVAILABLE');
    reasoning = `Jupiter returned neither a ${i.symbol}x price nor a quote. Try again in a minute.`;
  } else if (xRoundTrip == null) {
    verdict = 'TOO_THIN';
    codes.unshift('XSTOCK_NO_ROUTE');
    reasoning = `Jupiter has no full round-trip route for ${i.symbol}x at ${size}. Try a smaller size.`;
  } else if (entry == null || exit == null) {
    verdict = 'TOO_THIN';
    codes.unshift('PERP_BOOK_TOO_THIN');
    reasoning = `The Phoenix ${i.symbol} book cannot fill ${size} on both sides. Try a smaller size.`;
  } else if (headroom != null && headroom < i.size_usd) {
    verdict = 'TOO_THIN';
    codes.unshift('OI_CAP');
    reasoning = `Phoenix ${i.symbol} has $${Math.round(headroom).toLocaleString('en-US')} of open-interest headroom, under the ${size} size.`;
  } else if (dailyBps == null || dailyBps <= 0) {
    verdict = 'NO_TRADE';
    codes.unshift('FUNDING_NOT_POSITIVE');
    reasoning = `Funding is ${snap.funding_apr_pct.toFixed(1)}% APR, so the short perp does not earn: long ${i.symbol}x / short perp costs carry. The reverse needs a short xStock, which spot does not offer.`;
  } else {
    const be = breakeven!;
    verdict = be <= TRADE_MAX_BREAKEVEN_DAYS ? 'TRADE' : be <= MARGINAL_MAX_BREAKEVEN_DAYS ? 'MARGINAL' : 'NO_TRADE';
    codes.unshift(verdict === 'TRADE' ? 'FUNDING_PAYS' : verdict === 'MARGINAL' ? 'SLOW_PAYBACK' : 'COST_EXCEEDS_CARRY');
    reasoning =
      `Long ${i.symbol}x / short Phoenix ${i.symbol}: funding ${snap.funding_apr_pct.toFixed(1)}% APR (${dailyBps} bps/day) ` +
      `against a ${totalCost} bps round trip at ${size} → breakeven in ${be} days at the current rate.`;
  }

  return {
    symbol: i.symbol,
    size_usd: i.size_usd,
    verdict,
    direction: dailyBps != null && dailyBps > 0 ? 'long_xstock_short_perp' : null,
    xstock: { symbol: `${i.symbol}x`, mint, price_usd: xPrice, round_trip_cost_bps: xRoundTrip },
    perp: {
      venue: 'phoenix',
      symbol: i.symbol,
      mark_price_usd: snap?.mark_price_usd ?? null,
      index_price_usd: snap?.index_price_usd ?? null,
      book_mid_usd: mid != null ? round(mid, 4) : null,
      funding_hourly_pct: snap?.funding_hourly_pct ?? null,
      funding_apr_pct: snap ? round(snap.funding_apr_pct, 2) : null,
      open_interest_usd: snap?.open_interest_usd ?? null,
      oi_cap_headroom_usd: headroom,
      taker_fee_pct: snap ? round(snap.taker_fee_pct, 4) : null,
      entry_slippage_bps: entrySlip,
      exit_slippage_bps: exitSlip,
      round_trip_cost_bps: perpRoundTrip,
    },
    basis: {
      xstock_vs_index_bps: xPrice != null && snap ? bps(xPrice, snap.index_price_usd) : null,
      perp_vs_index_bps: snap ? bps(snap.mark_price_usd, snap.index_price_usd) : null,
      perp_vs_xstock_bps: xPrice != null && snap ? bps(snap.mark_price_usd, xPrice) : null,
    },
    economics: { round_trip_cost_bps: totalCost, funding_daily_bps: dailyBps, breakeven_days: breakeven, net_7d_bps: net7d },
    session: {
      after_hours: afterHours,
      phoenix_status: i.view?.commodityMetadata?.status ?? i.view?.marketStatus ?? null,
      next_transition_utc: i.view?.metadata?.calendar?.nextMarketTransitionUtc ?? null,
      next_earnings: earnings,
    },
    codes,
    reasoning,
    caveats,
    fetched_at: new Date(i.now).toISOString(),
  };
}

// --- Analyzer ---

export class XstockBasisAnalyzer {
  constructor(
    private phoenix: PhoenixPerpsClient,
    private jupiter: JupiterClient,
    private cache: Cache,
  ) {}

  async analyze(symbol: XstockSymbol, sizeUsd: number): Promise<XstockBasisResult> {
    const key = `xstock-basis:${symbol}:${sizeUsd}`;
    const cached = await this.cache.get<XstockBasisResult>(key);
    if (cached) return cached;

    const mint = XSTOCK_MINTS[symbol];
    const [snapshot, book, view, price, buy] = await Promise.all([
      this.phoenix.getMarket(symbol),
      this.phoenix.getOrderbook(symbol),
      this.phoenix.getMarketView(symbol),
      this.jupiter.getPrice([mint]).then((p) => p[mint]?.price ?? null).catch(() => null),
      this.jupiter.getQuote(USDC, mint, sizeUsd * 10 ** USDC_DECIMALS),
    ]);
    const sell = buy ? await this.jupiter.getQuote(mint, USDC, buy.outAmount) : null;

    const result = buildXstockBasis({
      symbol,
      size_usd: sizeUsd,
      xstockPrice: price,
      buyOutRaw: buy?.outAmount ?? null,
      sellBackRaw: sell?.outAmount ?? null,
      snapshot,
      book,
      view,
      now: Date.now(),
    });
    // Do not cache a result that failed on a missing upstream read.
    if (result.verdict !== 'UNAVAILABLE') await this.cache.set(key, result, RESULT_TTL_S);
    return result;
  }
}
