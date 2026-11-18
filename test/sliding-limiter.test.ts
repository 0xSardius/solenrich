// Shared Jupiter limiter (2026-11-15): two priorities over a sliding window, with a fake clock.
import { describe, expect, test } from 'bun:test';
import { SlidingLimiter } from '../src/utils/sliding-limiter';

function fakeClock() {
  let t = 1_000_000;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, advance: (ms: number) => { t += ms; } };
}
const make = (c: ReturnType<typeof fakeClock>) => new SlidingLimiter({ windowMs: 60_000, capacity: 5, lowReserve: 2, now: c.now, sleep: c.sleep });

describe('SlidingLimiter', () => {
  test('low priority uses at most capacity - reserve, then skips within maxWait', async () => {
    const c = fakeClock(); const l = make(c);
    for (let i = 0; i < 3; i++) expect(await l.acquire('low', 2000)).toBe('go');
    expect(await l.acquire('low', 2000)).toBe('skip');
    expect(l.used()).toBe(3);
  });
  test('high priority can use the reserved slots that low cannot', async () => {
    const c = fakeClock(); const l = make(c);
    for (let i = 0; i < 3; i++) await l.acquire('low', 2000);
    expect(await l.acquire('high', 3000)).toBe('go');
    expect(await l.acquire('high', 3000)).toBe('go');
    expect(l.used()).toBe(5);
  });
  test('high priority with a full window and no slot in time is forced through, not dropped', async () => {
    const c = fakeClock(); const l = make(c);
    for (let i = 0; i < 5; i++) await l.acquire('high', 3000);
    expect(await l.acquire('high', 3000)).toBe('forced');
  });
  test('a call waits when a slot frees within maxWait', async () => {
    const c = fakeClock(); const l = make(c);
    await l.acquire('high', 0);                // t0
    c.advance(59_000);
    for (let i = 0; i < 4; i++) await l.acquire('high', 0);
    expect(l.used()).toBe(5);
    expect(await l.acquire('high', 3000)).toBe('waited'); // t0 stamp expires 1 s later
  });
  test('JupiterClient: two full token calls (lookup + 4 quotes) fit one window; a third call\'s quotes are skipped', async () => {
    const { JupiterClient, jupiterLimiter } = await import('../src/sources/jupiter');
    const realFetch = globalThis.fetch;
    jupiterLimiter.reset();
    let sent = 0;
    globalThis.fetch = (async (url: string) => {
      sent++;
      return new Response(String(url).includes('/tokens/') ? JSON.stringify([{ id: 'M', isVerified: true }])
        : JSON.stringify({ priceImpactPct: '0.01', outAmount: '1' }), { status: 200 });
    }) as any;
    try {
      const j = new JupiterClient({ get: async () => null, set: async () => {} } as any);
      for (const mint of ['A', 'B']) {          // one token call = 1 lookup + 4 quotes
        expect((await j.getTokenInfo('M'))?.verified).toBe(true);
        expect((await j.getSlippage(mint)).estimates.length).toBe(4);
      }
      expect(sent).toBe(10);
      const third = await j.getSlippage('C');   // window full, no slot within 2 s: skipped, nothing sent
      expect(third.estimates.length).toBe(0);
      expect(sent).toBe(10);
    } finally {
      globalThis.fetch = realFetch;
      jupiterLimiter.reset();
    }
  });
  test('JupiterClient prices: every keyless call takes a slot in the 5-per-10 s bucket; a 429 is retried once', async () => {
    const { JupiterClient, priceLimiter } = await import('../src/sources/jupiter');
    const { upstreamStats } = await import('../src/utils/upstream-stats');
    const realFetch = globalThis.fetch;
    priceLimiter.reset();
    const before = upstreamStats.snapshotToday();
    let n = 0;
    globalThis.fetch = (async () => (n++ === 0 ? new Response('busy', { status: 429 })
      : new Response(JSON.stringify({ M: { usdPrice: 2 } }), { status: 200 }))) as any;
    try {
      const j = new JupiterClient({ get: async () => null, set: async () => {}, mget: async (k: string[]) => k.map(() => null) } as any);
      const p = await j.getPriceUncached(['M'], 'high');
      expect(p.M.price).toBe(2);
      expect(priceLimiter.used()).toBe(2);           // first try + retry
      const after = upstreamStats.snapshotToday();
      expect((after.jupiter_price_429 ?? 0) - (before.jupiter_price_429 ?? 0)).toBe(1);
      expect((after.jupiter_price_429_after_retry ?? 0) - (before.jupiter_price_429_after_retry ?? 0)).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
      priceLimiter.reset();
    }
  });
  test('JupiterClient.getPrice coalesces simultaneous lookups into one request; each caller gets its own mints', async () => {
    const { JupiterClient, priceLimiter } = await import('../src/sources/jupiter');
    const realFetch = globalThis.fetch;
    priceLimiter.reset();
    const urls: string[] = [];
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url));
      const ids = new URL(String(url)).searchParams.get('ids')!.split(',');
      return new Response(JSON.stringify(Object.fromEntries(ids.map((m, i) => [m, { usdPrice: i + 1 }]))), { status: 200 });
    }) as any;
    try {
      const j = new JupiterClient({ get: async () => null, set: async () => {}, mget: async (k: string[]) => k.map(() => null) } as any);
      const out = await Promise.all(['A', 'B', 'C', 'A'].map((m) => j.getPrice([m])));
      expect(urls.length).toBe(1);
      expect(new URL(urls[0]).searchParams.get('ids')).toBe('A,B,C');
      expect(Object.keys(out[1])).toEqual(['B']);
      expect(out[0].A.price).toBe(out[3].A.price);
    } finally {
      globalThis.fetch = realFetch;
      priceLimiter.reset();
    }
  });
  test('StonkFunClient: walk pages and single-token reads share one budget; walks cannot use the user reserve', async () => {
    const { StonkFunClient, stonkLimiter, STONK_BUDGET_PER_MIN, STONK_HIGH_RESERVE } = await import('../src/sources/stonkfun');
    const realFetch = globalThis.fetch;
    stonkLimiter.reset();
    globalThis.fetch = (async (url: string) => new Response(JSON.stringify({ data: String(url).includes('/tokens/')
      ? { token: { mint: 'M' } } : { tokens: [], pagination: { page: 1, pageSize: 0, total: 0, totalPages: 1 } } }), { status: 200 })) as any;
    try {
      const c = new StonkFunClient({ get: async () => null, set: async () => {} } as any);
      await c.getTokens({ mode: 'reward', page: 1 });   // background
      await c.getToken('M');                           // user-facing
      expect(stonkLimiter.used()).toBe(2);
      expect(STONK_BUDGET_PER_MIN - STONK_HIGH_RESERVE).toBeLessThan(300); // walks alone stay under StonkFun's 300/min
      expect(STONK_BUDGET_PER_MIN).toBeLessThan(300);
    } finally {
      globalThis.fetch = realFetch;
      stonkLimiter.reset();
    }
  });
  test('the window slides: slots free after 60 s', async () => {
    const c = fakeClock(); const l = make(c);
    for (let i = 0; i < 3; i++) await l.acquire('low', 0);
    expect(await l.acquire('low', 0)).toBe('skip');
    c.advance(60_001);
    expect(await l.acquire('low', 0)).toBe('go');
    expect(l.used()).toBe(1);
  });
});
