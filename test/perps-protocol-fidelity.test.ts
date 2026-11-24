// Perps + protocol fidelity (audit 2026-11-17, step 8): pool-venue shorts pay the stablecoin custody's rate; the
// protocol activity rate is measured in seconds.
import { afterEach, describe, expect, test } from 'bun:test';
import { DefiLlamaClient } from '../src/sources/defi-llama';
import { PerpsCrossVenueAnalyzer } from '../src/enrichers/perps-cross-venue';
import { sampleActivity } from '../src/enrichers/protocol-analyzer';

const noCache = { get: async () => null, set: async () => {} } as any;
const jupiterMarket = (shortApr: number | null) => ({
  symbol: 'SOL', custody: 'C', mark_price_usd: 150,
  open_interest: { long_usd: 10, short_usd: 5, total_usd: 15, long_pct: 66.7, short_pct: 33.3, net_skew: 'long' },
  utilization_pct: 10, borrow_rate: { hourly_pct: 0.0015, annualized_pct: 13.24, model: 'jump' },
  borrow_rate_short: shortApr == null ? null : { hourly_pct: shortApr / 8760, annualized_pct: shortApr, custody: 'USDC', usdt_annualized_pct: 10 },
  pool_assets: {}, limits: {},
});
const analyzer = (shortApr: number | null, adrenaStable: number | null) => new PerpsCrossVenueAnalyzer(
  { getMarketStructure: async () => ({ markets: [jupiterMarket(shortApr)] }) } as any,
  { getMarket: async () => ({ borrow_rate: { apr_pct: 14.2 }, open_interest: { total_usd: 1, long_pct: 50 }, utilization_pct: 5 }),
    getStableBorrowAprPct: async () => (adrenaStable == null ? null : { apr_pct: adrenaStable, utilization_pct: adrenaStable > 50 ? 100 : 40, last_update: '2026-10-20T05:48:19.000Z' }) } as any,
  { getBoth: async () => null } as any,
  { getMarket: async () => ({ borrow_apr_pct: 9, oi_long_usd: 1, oi_short_usd: 1, utilization_pct: 3 }), sourceStatus: () => 'ok' } as any,
  noCache,
);

describe('pool-venue short borrow rate', () => {
  test('Jupiter and Adrena shorts use the stablecoin custody rate, not the long rate (was 13.24 / 14.2 both sides)', async () => {
    const r = await analyzer(1.8, 3.1).analyze('SOL', false);
    const jup = r.venues.find((v) => v.venue === 'jupiter-perps')!;
    const adr = r.venues.find((v) => v.venue === 'adrena')!;
    expect(jup.borrow_apr_long).toBe(13.24);
    expect(jup.borrow_apr_short).toBe(1.8);
    expect(adr.borrow_apr_long).toBe(14.2);
    expect(adr.borrow_apr_short).toBe(3.1);
  });
  test('a fully utilized Adrena USDC custody carries a note that shorts may not fill (measured: 100%, 80.59%)', async () => {
    const r = await analyzer(1.25, 80.59).analyze('SOL', false);
    const adr = r.venues.find((v) => v.venue === 'adrena')!;
    expect(adr.borrow_apr_short).toBe(80.59);
    expect((adr.notes ?? []).some((n) => n.includes('100% utilized') && n.includes('may not fill'))).toBe(true);
  });
  test('stable rate unreadable → short null (unknown), never a copy of the long rate; Flash short is null', async () => {
    const r = await analyzer(null, null).analyze('SOL', false);
    expect(r.venues.find((v) => v.venue === 'jupiter-perps')!.borrow_apr_short).toBeNull();
    expect(r.venues.find((v) => v.venue === 'adrena')!.borrow_apr_short).toBeNull();
    expect(r.venues.find((v) => v.venue === 'flash')!.borrow_apr_short).toBeNull();
  });
});

describe('DeFi Llama TVL: a failed read is not $0 (audit #33)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const route = (h: (url: string) => Response) => { globalThis.fetch = (async (u: any) => h(String(u))) as any; };
  test('every read fails → throws (not cached as TVL 0 / micro)', async () => {
    route(() => new Response('err', { status: 500 }));
    await expect(new DefiLlamaClient(noCache).getProtocolTvl('raydium')).rejects.toThrow();
  });
  test('lightweight read only: total known, no Solana split; chain list carried', async () => {
    route((u) => u.includes('/tvl/') ? new Response('1500000000', { status: 200 })
      : u.endsWith('/protocols') ? new Response(JSON.stringify([{ name: 'Raydium', slug: 'raydium', tvl: 1.5e9, chains: ['Solana', 'Ethereum'], category: 'Dexes' }]), { status: 200 })
      : new Response('timeout', { status: 504 }));
    const d = await new DefiLlamaClient(noCache).getProtocolTvl('raydium');
    expect(d.chains).toEqual({ total: 1.5e9 });
    expect(d.chain_list).toEqual(['Solana', 'Ethereum']);
  });
});

describe('protocol activity rate', () => {
  test('200 signatures in 3 s → saturated, ≥ 6,000 tx/h, not 0 (old: 0-minute window → 0 → "low")', () => {
    const t = Array.from({ length: 200 }, (_, i) => 1_000_000 + Math.floor(i / 70));
    const a = sampleActivity(t);
    expect(a.sampleWindowSeconds).toBe(2);
    expect(a.sampleSaturated).toBe(true);
    expect(a.avgTxPerHour).toBe(360_000);
  });
  test('no ×60 jump between 59 s and 61 s windows', () => {
    const mk = (span: number) => [0, span, ...Array.from({ length: 98 }, () => span / 2)];
    const r59 = sampleActivity(mk(59)).avgTxPerHour, r61 = sampleActivity(mk(61)).avgTxPerHour;
    expect(r59 / r61).toBeLessThan(1.1);
  });
  test('a quiet program over an hour', () => {
    const a = sampleActivity(Array.from({ length: 50 }, (_, i) => i * 72));
    expect(a.sampleWindowMinutes).toBeCloseTo(58.8, 1);
    expect(a.sampleSaturated).toBe(false);
    expect(a.avgTxPerHour).toBe(51);
  });
});
