/**
 * Phoenix venue (2026-11-03): units, latest-point selection, quote mapping, client fallbacks.
 * Fixtures are real responses captured 2026-11-03 (test/fixtures/phoenix). Offline: fetch is replaced.
 * Run: bun test test/perps-phoenix.test.ts
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { buildPhoenixSnapshot, latestPoint, PhoenixPerpsClient, PHOENIX_RETRY_MS, type PhoenixMarketConfig } from '../src/sources/phoenix-perps';
import { phoenixQuote } from '../src/enrichers/perps-cross-venue';
import { NULL_CACHE } from '../src/lib/upstream-canary';

const fx = (f: string) => JSON.parse(readFileSync(`test/fixtures/phoenix/${f}`, 'utf8'));
const markets = fx('markets.json') as PhoenixMarketConfig[];
const cfg = (s: string) => markets.find((m) => m.symbol === s)!;
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('units and selection', () => {
  test('latestPoint picks the newest by time for ISO strings and unix seconds', () => {
    expect(latestPoint([{ timestamp: '2026-11-03T23:55:00Z' }, { timestamp: '2026-11-03T23:56:15Z' }, { timestamp: '2026-11-03T23:50:00Z' }])!.timestamp).toBe('2026-11-03T23:56:15Z');
    expect(latestPoint([{ timestamp: 1793746800 }, { timestamp: 1793739601 }])!.timestamp).toBe(1793746800);
    expect(latestPoint([])).toBeNull();
  });

  test('SOL snapshot from real fixtures: funding is %/hour, OI is base units × mark', () => {
    const stats = latestPoint(fx('stats-SOL.json').stats as any[])!;
    const funding = Number(latestPoint(fx('funding-SOL.json').rates as any[])!.fundingRatePercentage);
    const s = buildPhoenixSnapshot(cfg('SOL'), stats, funding);
    expect(funding).toBeCloseTo(0.001283, 6);
    // 0.01% per 8h baseline / 8 = 0.00125%/h → ~10.95% APR; the live value sits on that baseline.
    expect(s.funding_apr_pct).toBeGreaterThan(10);
    expect(s.funding_apr_pct).toBeLessThan(12);
    expect(s.open_interest_usd).toBe(Math.round(stats.open_interest * stats.mark_price));
    expect(s.taker_fee_pct).toBeCloseTo(0.035, 6);
    expect(s.oi_cap_usd).toBe(Math.round((Number(cfg('SOL').openInterestCapBaseLots) / 100) * stats.mark_price));
  });
});

describe('phoenixQuote', () => {
  const snap = buildPhoenixSnapshot(cfg('SOL'), latestPoint(fx('stats-SOL.json').stats as any[])!, 0.00125);

  test('available quote: signed funding like reference venues, funding-rate mechanism, Solana type', () => {
    const q = phoenixQuote('SOL', snap, 'ok');
    expect(q).toMatchObject({ venue: 'phoenix', available: true, type: 'solana-onchain', rate_mechanism: 'funding-rate', borrow_apr_long: 10.95, borrow_apr_short: -10.95 });
    expect(q.notes![0]).toContain('positive = longs pay shorts');
  });

  test('unavailable reasons: BONK not mapped, source down, slow or inactive', () => {
    expect(phoenixQuote('BONK', null, 'ok').unavailable_reason).toContain('kBONK');
    expect(phoenixQuote('SOL', null, 'unreachable').unavailable_reason).toContain('did not respond');
    expect(phoenixQuote('ETH', null, 'ok').unavailable_reason).toContain('did not load in time');
  });
});

describe('PhoenixPerpsClient', () => {
  const route = (handlers: Record<string, unknown>) => {
    const calls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      const path = url.replace('https://perp-api.phoenix.trade', '');
      calls.push(path);
      const key = Object.keys(handlers).find((k) => path.startsWith(k));
      if (!key) return new Response('{}', { status: 404 });
      const h = handlers[key];
      if (h === 'throw') throw new TypeError('fetch failed');
      return new Response(JSON.stringify(typeof h === 'function' ? (h as (p: string) => unknown)(path) : h));
    }) as unknown as typeof fetch;
    return calls;
  };

  test('builds a snapshot from config + stats + funding', async () => {
    route({ '/exchange/markets': markets, '/v1/market/SOL/stats': fx('stats-SOL.json'), '/v1/funding/SOL/rates': fx('funding-SOL.json') });
    const s = await new PhoenixPerpsClient(NULL_CACHE).getMarket('SOL');
    expect(s?.symbol).toBe('SOL');
    expect(s?.funding_hourly_pct).toBeCloseTo(0.001283, 6);
  });

  test('a quiet market with no points in 2 min widens the window to 60 min', async () => {
    let n = 0;
    const calls = route({ '/exchange/markets': markets, '/v1/market/SPY/stats': () => (n++ === 0 ? { stats: [] } : fx('stats-NVDA.json')), '/v1/funding/SPY/rates': fx('funding-SPY.json') });
    // SPY uses NVDA's stats point as the widened answer; only the call pattern matters here.
    expect(await new PhoenixPerpsClient(NULL_CACHE).getMarket('SPY')).not.toBeNull();
    expect(calls.filter((c) => c.startsWith('/v1/market/SPY/stats'))).toHaveLength(2);
  });

  test('an unlisted symbol returns null without marking the source down', async () => {
    route({ '/exchange/markets': markets });
    const c = new PhoenixPerpsClient(NULL_CACHE);
    expect(await c.getMarket('DOGE')).toBeNull();
    expect(c.sourceStatus()).toBe('ok');
  });

  test('a network failure marks the source unreachable for 5 min and skips calls meanwhile', async () => {
    const calls = route({ '/exchange/markets': 'throw' });
    const c = new PhoenixPerpsClient(NULL_CACHE);
    expect(await c.getMarket('SOL')).toBeNull();
    expect(c.sourceStatus()).toBe('unreachable');
    expect(await c.getMarket('BTC')).toBeNull();
    expect(calls).toHaveLength(1);
    expect(c.sourceStatus(Date.now() + PHOENIX_RETRY_MS + 1)).toBe('ok');
  });
});
