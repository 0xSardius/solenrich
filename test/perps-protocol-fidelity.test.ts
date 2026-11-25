// Perps + protocol fidelity (audit 2026-11-17, step 8): pool-venue shorts pay the stablecoin custody's rate; the
// protocol activity rate is measured in seconds.
import { afterEach, describe, expect, test } from 'bun:test';
import { DefiLlamaClient } from '../src/sources/defi-llama';
import { HyperliquidAnalyzer, HyperliquidUnavailableError } from '../src/enrichers/hyperliquid-analyzer';
import { PerpsCrossVenueAnalyzer, findCarryOpportunities, phoenixQuote } from '../src/enrichers/perps-cross-venue';
import { venueFee, PerpsVenueComparator } from '../src/enrichers/perps-venue-comparison';
import { sampleActivity, tvlChainSum } from '../src/enrichers/protocol-analyzer';

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

describe('arbitrage = net carry of a long/short pair (audit #18)', () => {
  const v = (venue: string, type: string, long: number | null, short: number | null) =>
    ({ venue, type, available: true, borrow_apr_long: long, borrow_apr_short: short }) as any;
  test('two pool venues never qualify: both legs pay borrow (old code: Flash 9% vs Adrena 14.2% = "5.2pt arbitrage")', () => {
    expect(findCarryOpportunities([v('jupiter-perps', 'solana-onchain', 13.24, 1.8), v('adrena', 'solana-onchain', 14.2, 3.1), v('flash', 'solana-onchain', 9, null)])).toEqual([]);
  });
  test('long a pool venue + short a funding venue paying 20%: net 6.76%/yr, legs reported', () => {
    const [o] = findCarryOpportunities([v('jupiter-perps', 'solana-onchain', 13.24, 1.8), v('hyperliquid', 'reference', 20, -20)]);
    expect(o).toMatchObject({ type: 'cross_chain_basis', long_venue: 'jupiter-perps', short_venue: 'hyperliquid', spread_apr_pct: 6.76, long_leg_apr_pct: 13.24, short_leg_apr_pct: -20 });
  });
  test('Jupiter borrow above HL funding: no "short Jupiter / long HL" (that pays both)', () => {
    expect(findCarryOpportunities([v('jupiter-perps', 'solana-onchain', 13.24, 1.8), v('hyperliquid', 'reference', 3, -3)])).toEqual([]);
  });
  test('negative funding: shorts pay, longs earn → long the funding venue, short the pool', () => {
    const [o] = findCarryOpportunities([v('jupiter-perps', 'solana-onchain', 13.24, 1.8), v('hyperliquid', 'reference', -15, 15)]);
    expect(o).toMatchObject({ long_venue: 'hyperliquid', short_venue: 'jupiter-perps', spread_apr_pct: 13.2 });
  });
});

describe('venue fees (audit #19)', () => {
  test('Phoenix uses its live taker fee; Hyperliquid uses the 0.045% base tier; Adrena is marked assumed', () => {
    expect(venueFee({ venue: 'phoenix', taker_fee_pct: 0.04 } as any)).toEqual({ pct: 0.04, source: 'venue_data' });
    expect(venueFee({ venue: 'hyperliquid' } as any)).toEqual({ pct: 0.045, source: 'published_schedule' });
    expect(venueFee({ venue: 'adrena' } as any)).toEqual({ pct: 0.06, source: 'assumed' });
  });
  test('phoenixQuote carries the snapshot taker fee', () => {
    const q = phoenixQuote('SOL', { funding_apr_pct: 10, funding_hourly_pct: 0.001, taker_fee_pct: 0.035, open_interest_usd: 1, mark_price_usd: 150, index_price_usd: 150, oi_cap_usd: null } as any, 'ok');
    expect(q.taker_fee_pct).toBe(0.035);
  });
});

describe('venue comparison slippage is labelled a spot reference (audit #20)', () => {
  test('$5M on a $100K top tier → slippage_underestimate + row flag; every row says jupiter_spot_reference', async () => {
    const venues = [
      { venue: 'jupiter-perps', type: 'solana-onchain', available: true, borrow_apr_long: 13, borrow_apr_short: 2, open_interest_usd: 1, utilization_pct: 10, skew: 'balanced', mark_price_usd: 150 },
      { venue: 'hyperliquid', type: 'reference', available: true, borrow_apr_long: 10, borrow_apr_short: -10, open_interest_usd: 1, utilization_pct: null, skew: 'unknown', mark_price_usd: 150 },
    ];
    const cross = { analyze: async () => ({ market: 'SOL', venues, best_entry: {}, basis: {}, arbitrage_opportunities: [] }) } as any;
    const jupiter = { getSlippageEstimates: async () => [{ size_usd: 1000, price_impact_pct: 0.01 }, { size_usd: 100_000, price_impact_pct: 0.3 }] } as any;
    const r = await new PerpsVenueComparator(cross, jupiter, { getMarketStructure: async () => null }, noCache).compare('SOL', 5_000_000, 'long');
    expect(r.slippage_underestimate).toBe(true);
    expect(r.venues.every((v) => v.slippage_basis === 'jupiter_spot_reference')).toBe(true);
    expect(r.venues.every((v) => v.flags.includes('slippage_underestimate'))).toBe(true);
    expect(r.venues.find((v) => v.venue === 'hyperliquid')!.fee_pct).toBe(0.045);
    expect(r.recommendation.warnings).toContain('slippage_underestimate');
  });
});

describe('Hyperliquid: a failed read is an error, not a flat trader (audit #21)', () => {
  test('clearinghouseState null → analyzeTrader throws HyperliquidUnavailableError', async () => {
    const ref = { getHlTraderState: async () => null, getHlPnl: async () => null } as any;
    await expect(new HyperliquidAnalyzer(ref).analyzeTrader('0xabc')).rejects.toBeInstanceOf(HyperliquidUnavailableError);
  });
  test('a real flat account still reads as no_positions with its account value', async () => {
    const ref = { getHlTraderState: async () => ({ positions: [], account_value_usd: 1234, total_notional_usd: 0, margin_used_usd: 0, withdrawable_usd: 1234 }), getHlPnl: async () => null } as any;
    const p = await new HyperliquidAnalyzer(ref).analyzeTrader('0xabc');
    expect(p.profile).toBe('no_positions');
    expect(p.account.value_usd).toBe(1234);
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

describe('TVL chain sum', () => {
  test('per-chain category keys (Solana-staking) are not chains — Raydium reads 100% Solana', () => {
    expect(tvlChainSum({ Solana: 803_698_623, 'Solana-staking': 58_567_295, staking: 58_567_295 })).toBe(803_698_623);
    expect(tvlChainSum({ Solana: 10, Ethereum: 5, 'Ethereum-borrowed': 3, borrowed: 3 })).toBe(15);
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
