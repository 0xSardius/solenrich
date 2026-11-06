/**
 * xstock-basis (2026-11-05): book walk, round-trip cost, breakeven verdicts, session flags, and the
 * Phoenix 429 retry. Pure functions plus a fake fetch. Offline.
 * Run: bun test test/xstock-basis.test.ts
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { buildXstockBasis, walkBook, nextEarnings, type XstockBasisInputs } from '../src/enrichers/xstock-basis';
import { PhoenixPerpsClient, retryAfterMs, type PhoenixSnapshot, type PhoenixOrderbook, type PhoenixMarketView } from '../src/sources/phoenix-perps';
import { NULL_CACHE } from '../src/lib/upstream-canary';

const NOW = Date.parse('2026-11-05T23:50:00Z');

// NVDA-like market: mid $180, levels of 5 shares 1 cent apart, taker fee 0.035%.
const book: PhoenixOrderbook = {
  symbol: 'NVDA',
  slot: 1,
  mid: 180,
  bids: [[179.99, 5], [179.98, 5], [179.97, 5]],
  asks: [[180.01, 5], [180.02, 5], [180.03, 5]],
};
const snap = (fundingHourlyPct: number, over: Partial<PhoenixSnapshot> = {}): PhoenixSnapshot => ({
  symbol: 'NVDA',
  mark_price_usd: 180.2,
  index_price_usd: 180,
  open_interest_base: 500,
  open_interest_usd: 90_000,
  funding_hourly_pct: fundingHourlyPct,
  funding_apr_pct: fundingHourlyPct * 8760,
  taker_fee_pct: 0.035,
  maker_fee_pct: 0.005,
  oi_cap_usd: 2_000_000,
  stats_at: '2026-11-05T23:49:00Z',
  ...over,
});
const view: PhoenixMarketView = {
  symbol: 'NVDA',
  marketStatus: 'active',
  commodityMetadata: { isAfterHours: false, status: 'active' },
  metadata: { earningsDatesV2: [{ date: '2026-08-26', time: 'amc' }, { date: '2026-11-17', time: 'amc' }], calendar: { nextMarketTransitionUtc: '2026-11-07T01:00:00Z' } },
};
// $1,000 buys 5.55 NVDAx (8 decimals) and sells back for $998.
const inputs = (over: Partial<XstockBasisInputs> = {}): XstockBasisInputs => ({
  symbol: 'NVDA',
  size_usd: 1000,
  xstockPrice: 179.9,
  buyOutRaw: 5.55e8,
  sellBackRaw: 998e6,
  snapshot: snap(0.002),
  book,
  view,
  now: NOW,
  ...over,
});

describe('walkBook', () => {
  test('fills across levels at the size-weighted price', () => {
    expect(walkBook(book.bids, 5)!.avg_price).toBeCloseTo(179.99, 6);
    expect(walkBook(book.bids, 10)!.avg_price).toBeCloseTo(179.985, 6);
  });
  test('returns null when the book cannot fill the size', () => {
    expect(walkBook(book.bids, 15.01)).toBeNull();
  });
});

describe('buildXstockBasis', () => {
  test('TRADE: round trip = xStock quotes + book walk + 2 × taker fee; breakeven from daily funding', () => {
    const r = buildXstockBasis(inputs());
    // xStock: $1,000 in, $998 back = 20 bps. Perp: 5.56 shares fill inside the first level both ways:
    // 0.6 bps in + 0.6 bps out + 2 × 3.5 bps fee = 8.2 bps.
    expect(r.xstock.round_trip_cost_bps).toBe(20);
    expect(r.perp.entry_slippage_bps).toBe(0.6);
    expect(r.perp.exit_slippage_bps).toBe(0.6);
    expect(r.perp.round_trip_cost_bps).toBe(8.2);
    expect(r.economics.round_trip_cost_bps).toBe(28.2);
    // 0.002 %/h × 24 × 100 = 4.8 bps/day → 28.2 / 4.8 = 5.9 days.
    expect(r.economics.funding_daily_bps).toBe(4.8);
    expect(r.economics.breakeven_days).toBe(5.9);
    expect(r.verdict).toBe('TRADE');
    expect(r.direction).toBe('long_xstock_short_perp');
    expect(r.codes[0]).toBe('FUNDING_PAYS');
    expect(r.basis.perp_vs_xstock_bps).toBeCloseTo(16.7, 1);
  });

  test('MARGINAL between 7 and 30 days, NO_TRADE above 30', () => {
    expect(buildXstockBasis(inputs({ snapshot: snap(0.001) })).verdict).toBe('MARGINAL'); // 11.8 days
    expect(buildXstockBasis(inputs({ snapshot: snap(0.0003) })).verdict).toBe('NO_TRADE'); // 39 days
    expect(buildXstockBasis(inputs({ snapshot: snap(0.0003) })).codes[0]).toBe('COST_EXCEEDS_CARRY');
  });

  test('negative funding: NO_TRADE with no direction (the reverse needs a short xStock)', () => {
    const r = buildXstockBasis(inputs({ snapshot: snap(-0.001) }));
    expect(r.verdict).toBe('NO_TRADE');
    expect(r.direction).toBeNull();
    expect(r.codes[0]).toBe('FUNDING_NOT_POSITIVE');
    expect(r.economics.breakeven_days).toBeNull();
  });

  test('TOO_THIN: no Jupiter round trip, a book that cannot fill, or OI cap headroom under size', () => {
    expect(buildXstockBasis(inputs({ sellBackRaw: null })).codes[0]).toBe('XSTOCK_NO_ROUTE');
    expect(buildXstockBasis(inputs({ size_usd: 5000 })).codes[0]).toBe('PERP_BOOK_TOO_THIN');
    const capped = buildXstockBasis(inputs({ snapshot: snap(0.002, { oi_cap_usd: 90_500 }) }));
    expect(capped.verdict).toBe('TOO_THIN');
    expect(capped.codes[0]).toBe('OI_CAP');
  });

  test('UNAVAILABLE when Phoenix or every Jupiter read is missing', () => {
    expect(buildXstockBasis(inputs({ snapshot: null })).codes[0]).toBe('PHOENIX_UNAVAILABLE');
    expect(buildXstockBasis(inputs({ book: null })).verdict).toBe('UNAVAILABLE');
    const noJup = buildXstockBasis(inputs({ xstockPrice: null, buyOutRaw: null, sellBackRaw: null }));
    expect(noJup.codes[0]).toBe('XSTOCK_PRICE_UNAVAILABLE');
  });

  test('the price API failing falls back to the midpoint of the quoted buy and sell prices', () => {
    const r = buildXstockBasis(inputs({ xstockPrice: null }));
    // buy 1000 / 5.55 = 180.18, sell 998 / 5.55 = 179.82 → 180.0
    expect(r.xstock.price_usd).toBeCloseTo(180, 2);
    expect(r.verdict).toBe('TRADE');
  });

  test('session flags: after hours, earnings within 7 days, next calendar change', () => {
    const ah = buildXstockBasis(inputs({ view: { ...view, commodityMetadata: { isAfterHours: true } } }));
    expect(ah.codes).toContain('AFTER_HOURS');
    expect(ah.session.after_hours).toBe(true);
    const soon = buildXstockBasis(inputs({ now: Date.parse('2026-11-12T12:00:00Z') }));
    expect(soon.codes).toContain('EARNINGS_SOON');
    expect(soon.session.next_earnings).toEqual({ date: '2026-11-17', time: 'amc', days_until: 5 });
    expect(buildXstockBasis(inputs()).codes).not.toContain('EARNINGS_SOON');
    expect(buildXstockBasis(inputs()).session.next_transition_utc).toBe('2026-11-07T01:00:00Z');
  });
});

describe('nextEarnings', () => {
  test('skips past dates, returns null when none are ahead', () => {
    expect(nextEarnings(view, NOW)?.date).toBe('2026-11-17');
    expect(nextEarnings(view, Date.parse('2026-12-01T00:00:00Z'))).toBeNull();
    expect(nextEarnings(null, NOW)).toBeNull();
  });
});

describe('Phoenix rate limit', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test('retryAfterMs: seconds → ms, clamped, default 10 s', () => {
    expect(retryAfterMs('2')).toBe(2000);
    expect(retryAfterMs('600')).toBe(60_000);
    expect(retryAfterMs(null)).toBe(10_000);
    expect(retryAfterMs('soon')).toBe(10_000);
  });

  test('a 429 with Retry-After ≤ 3 s waits and retries once; a second 429 fails only that request', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      if (calls <= 1) return new Response('{}', { status: 429, headers: { 'retry-after': '1' } });
      return new Response(JSON.stringify({ symbol: 'NVDA', slot: 1, bids: [[1, 1]], asks: [[2, 1]], mid: 1.5 }), { status: 200 });
    }) as unknown as typeof fetch;
    const c = new PhoenixPerpsClient(NULL_CACHE);
    const b = await c.getOrderbook('NVDA');
    expect(calls).toBe(2);
    expect(b?.mid).toBe(1.5);

    calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response('{}', { status: 429, headers: { 'retry-after': '1' } }); }) as unknown as typeof fetch;
    expect(await c.getOrderbook('TSLA')).toBeNull();
    expect(calls).toBe(2);
    // Not marked down: the next request goes out.
    expect(c.sourceStatus()).toBe('ok');
  });
});
