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
  test('the window slides: slots free after 60 s', async () => {
    const c = fakeClock(); const l = make(c);
    for (let i = 0; i < 3; i++) await l.acquire('low', 0);
    expect(await l.acquire('low', 0)).toBe('skip');
    c.advance(60_001);
    expect(await l.acquire('low', 0)).toBe('go');
    expect(l.used()).toBe(1);
  });
});
