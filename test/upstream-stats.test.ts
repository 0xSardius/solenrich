// Upstream usage counters (2026-11-15): in-process counts, batched flush, 7-day history, Jupiter 429 accounting.
import { describe, expect, test, afterEach } from 'bun:test';
import { UpstreamStats, upstreamStats } from '../src/utils/upstream-stats';
import { JupiterClient } from '../src/sources/jupiter';

/** In-memory stand-in for Cache.incrby / Cache.mget. */
function memCache() {
  const m = new Map<string, number>();
  let failNext = false;
  return {
    m,
    failOnce() { failNext = true; },
    incrby: async (k: string, by: number) => { if (failNext) { failNext = false; return 0; } const v = (m.get(k) ?? 0) + by; m.set(k, v); return v; },
    mget: async (ks: string[]) => ks.map((k) => m.get(k) ?? null),
  } as any;
}

describe('UpstreamStats', () => {
  test('counts in process and flushes deltas once', async () => {
    const s = new UpstreamStats(); const c = memCache();
    s.inc('token_responses'); s.inc('token_responses'); s.inc('token_degraded');
    expect(s.snapshotToday()).toEqual({ token_responses: 2, token_degraded: 1 });
    await s.flush(c);
    await s.flush(c); // nothing pending: no double count
    const today = new Date().toISOString().slice(0, 10);
    expect(c.m.get(`metrics:upstream:${today}:token_responses`)).toBe(2);
  });
  test('history adds unflushed counts and computes degraded %', async () => {
    const s = new UpstreamStats(); const c = memCache();
    for (let i = 0; i < 20; i++) s.inc('token_responses');
    s.inc('token_degraded');
    await s.flush(c);
    s.inc('token_responses', 0); // no-op
    for (let i = 0; i < 20; i++) s.inc('token_responses');
    s.inc('token_degraded');
    const [today] = await s.history(c, 7);
    expect(today.token_responses).toBe(40);
    expect(today.token_degraded_pct).toBe(5);
  });
  test('a failed write is retried on the next flush', async () => {
    const s = new UpstreamStats(); const c = memCache();
    s.inc('jupiter_quote_429', 3);
    c.failOnce();
    await s.flush(c);
    await s.flush(c);
    const today = new Date().toISOString().slice(0, 10);
    expect(c.m.get(`metrics:upstream:${today}:jupiter_quote_429`)).toBe(3);
  });
  test('history returns one row per day, newest first', async () => {
    const rows = await new UpstreamStats().history(memCache(), 7, Date.parse('2026-11-15T12:00:00Z'));
    expect(rows.map((r) => r.date)).toEqual(['2026-11-15', '2026-11-14', '2026-11-13', '2026-11-12', '2026-11-11', '2026-11-10', '2026-11-09']);
  });
});

describe('JupiterClient counts requests and 429s', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const noCache = { get: async () => null, set: async () => {} } as any;
  test('429 then 200 on a token lookup: 2 requests, one 429, none after retry', async () => {
    const before = upstreamStats.snapshotToday();
    let n = 0;
    globalThis.fetch = (async () => (n++ === 0 ? new Response('busy', { status: 429 })
      : new Response(JSON.stringify([{ id: 'M', isVerified: true }]), { status: 200 }))) as any;
    const t = await new JupiterClient(noCache).getTokenInfo('M');
    expect(t?.verified).toBe(true);
    const after = upstreamStats.snapshotToday();
    const d = (k: string) => (after[k] ?? 0) - (before[k] ?? 0);
    expect(d('jupiter_token_requests')).toBe(2);
    expect(d('jupiter_token_429')).toBe(1);
    expect(d('jupiter_token_429_after_retry')).toBe(0);
  });
});
