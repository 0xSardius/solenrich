// Trenches suite fidelity (audit 2026-11-17, step 6): unread DexScreener values are null, an empty whale block is
// not market data, unknown liquidity is flagged, not "low".
import { afterEach, describe, expect, test } from 'bun:test';
import { aggregatePairs, RunnerDetector } from '../src/enrichers/runner-detector';
import { DexScreenerClient } from '../src/sources/dexscreener';
import { ExitSignalAnalyzer } from '../src/enrichers/exit-analyzer';
import { DEFAULT_SMART_MONEY_SEEDS, usableSeeds, seedListKey } from '../src/enrichers/smart-money-seeds';
import { lookupEntity } from '../src/utils/entities';
import { isWalletAddress } from '../src/enrichers/whale-watch';
import { TrenchesSmartMoneyAnalyzer } from '../src/enrichers/trenches-smart-money';
import { TRENCHES_SMART_MONEY_SEEDS, TRENCHES_CONVICTION_HOLDERS, TRENCHES_SEED_EXCLUDED } from '../src/enrichers/trenches-smart-money-seeds';
import { assessExit } from '../src/enrichers/exit-score';
import { assessRunner } from '../src/enrichers/runner-score';

const W = (buys = 0, sells = 0) => ({ buys, sells });
const quiet = {
  txns: { m5: W(), h1: W(), h6: W(), h24: W() },
  volume: { m5: 0, h1: 0, h6: 0, h24: 0 },
  price_change: { m5: 0, h1: 0, h6: 0, h24: 0 },
  liquidity_usd: null,
  liquidity_change_pct: null,
  holder_growth_pct: null,
};
const emptyWhales = { net_flow_direction: 'neutral' as const, distributing_count: 0, accumulating_count: 0, whale_count: 10, total_sell_volume_usd: 0, total_buy_volume_usd: 0 };

describe('aggregatePairs', () => {
  const pair = (o: Record<string, unknown>) => ({ chainId: 'solana', dexId: 'pumpfun', pairAddress: 'P', baseToken: { address: 'M', name: 'T', symbol: 'T' },
    quoteToken: { address: 'S', name: 'SOL', symbol: 'SOL' }, volume: { h24: 100, h6: 50, h1: 10, m5: 1 }, priceChange: { h1: 1, h6: 2, h24: 3 }, ...o }) as any;
  test('a bonding-curve pair with no liquidity object → liquidity null (was 0)', () => {
    const [a] = aggregatePairs([pair({ priceUsd: '0.00003', marketCap: 30_000 })]);
    expect(a.liquidity_usd).toBeNull();
    expect(a.price_usd).toBe(0.00003);
    expect(a.market_cap_usd).toBe(30_000);
  });
  test('a pair with only priceNative → price and market cap null (was 0)', () => {
    const [a] = aggregatePairs([pair({ dexId: 'pumpswap', priceNative: '0.1', liquidity: { usd: 5000, base: 1, quote: 1 } })]);
    expect(a.price_usd).toBeNull();
    expect(a.market_cap_usd).toBeNull();
    expect(a.liquidity_usd).toBe(5000);
  });
});

describe('exit-signal verdict', () => {
  test('no trades + a whale block with $0 measured flow → INSUFFICIENT_DATA (was HOLD "momentum intact")', () => {
    expect(assessExit({ ...quiet, whale: emptyWhales }).verdict).toBe('INSUFFICIENT_DATA');
  });
  test('no trades + whale flow unknown (no price) → INSUFFICIENT_DATA', () => {
    expect(assessExit({ ...quiet, whale: { ...emptyWhales, net_flow_direction: 'unknown' } }).verdict).toBe('INSUFFICIENT_DATA');
  });
  test('no trades but real whale selling is still a read, not INSUFFICIENT_DATA', () => {
    const v = assessExit({ ...quiet, whale: { ...emptyWhales, net_flow_direction: 'distributing', distributing_count: 4, total_sell_volume_usd: 90_000, total_buy_volume_usd: 1000 } }).verdict;
    expect(v).not.toBe('INSUFFICIENT_DATA');
  });
  test('unknown liquidity does not raise thin_exit_liquidity', () => {
    expect(assessExit({ ...quiet, whale: null }).flags).not.toContain('thin_exit_liquidity');
    expect(assessExit({ ...quiet, liquidity_usd: 5000, whale: null }).flags).toContain('thin_exit_liquidity');
  });
});

describe('DexScreener batch errors are failures, not "no pairs" (audit #35)', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const noCache = { get: async () => null, set: async () => {} } as any;
  test('every chunk non-2xx → getPairsBatch throws (callers then say "unreachable", not "untradable")', async () => {
    globalThis.fetch = (async () => new Response('rate limited', { status: 429 })) as any;
    await expect(new DexScreenerClient(noCache).getPairsBatch(['M'])).rejects.toThrow();
  });
  test('one chunk answers, one fails → the answered pairs are returned', async () => {
    let n = 0;
    globalThis.fetch = (async () => (n++ === 0 ? new Response(JSON.stringify([{ baseToken: { address: 'A' } }]), { status: 200 }) : new Response('', { status: 500 }))) as any;
    const pairs = await new DexScreenerClient(noCache).getPairsBatch(Array.from({ length: 40 }, (_, i) => `m${i}`));
    expect(pairs.length).toBe(1);
  });
  test('no mints → [] without a request', async () => {
    globalThis.fetch = (async () => { throw new Error('must not fetch'); }) as any;
    expect(await new DexScreenerClient(noCache).getPairsBatch([])).toEqual([]);
  });
  test('runner-scan with DexScreener down → caveat says unreachable, result not cached', async () => {
    const sets: string[] = [];
    const cache = { get: async () => null, set: async (k: string) => { sets.push(k); } } as any;
    const dex = { getTrendingCandidates: async () => ['A', 'B'], getPairsBatch: async () => { throw new Error('429'); } } as any;
    const r = await new RunnerDetector(dex, cache).scan(24, 0, 0, 10);
    expect(r.runners).toEqual([]);
    expect(r.caveats.join(' ')).toContain('unreachable');
    expect(r.caveats.join(' ')).not.toContain('quiet trenches');
    expect(sets.filter((k) => k.startsWith('runner:scan:'))).toEqual([]);
  });
});

describe('exit-signal whale block (audit #36)', () => {
  const noCache = { get: async () => null, set: async () => {} } as any;
  const holder = (o: Record<string, unknown> = {}) => ({ address: 'w', flow_direction: 'neutral', buy_volume_usd: 0, sell_volume_usd: 0, transaction_count: 0, ...o });
  const run = async (whales: any) => {
    const dex = { getPairsBatch: async () => [] } as any;
    const ww = { enrich: async () => whales } as any;
    return new ExitSignalAnalyzer(dex, ww, noCache).analyze('M');
  };
  test('ten holders, no transfer over the floor → whales null + caveat, not "10 whales, all neutral"', async () => {
    const r = await run({ whales: Array(10).fill(0).map(() => holder()), whale_count: 10, net_flow_direction: 'neutral', holders_source: 'rpc' });
    expect(r.whales).toBeNull();
    expect(r.caveats.some((c) => c.includes('whale flow not measured'))).toBe(true);
  });
  test('measured selling still produces the block', async () => {
    const r = await run({ whales: [holder({ flow_direction: 'distributing', sell_volume_usd: 50_000 })], whale_count: 1, net_flow_direction: 'distributing', holders_source: 'rpc' });
    expect(r.whales?.distributing_count).toBe(1);
    expect(r.whales?.total_sell_volume_usd).toBe(50_000);
  });
});

describe('smart-money-flow seeds and cache key (audit #42, #43)', () => {
  test('no fallback seed is a labelled entity (CEX, protocol) or a program address', () => {
    for (const s of usableSeeds(DEFAULT_SMART_MONEY_SEEDS)) {
      expect(lookupEntity(s)).toBeNull();
      expect(isWalletAddress(s)).toBe(true);
    }
    expect(DEFAULT_SMART_MONEY_SEEDS).not.toContain('5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1'); // Raydium v4 authority
    expect(DEFAULT_SMART_MONEY_SEEDS).not.toContain('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'); // Binance hot wallet
    expect(usableSeeds(['5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg'])).toEqual(['vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg']);
  });
  test('two wallet lists that share the first three addresses get different cache keys; order does not matter', () => {
    expect(seedListKey(['A', 'B', 'C', 'D'])).not.toBe(seedListKey(['A', 'B', 'C', 'E']));
    expect(seedListKey(['D', 'C', 'B', 'A'])).toBe(seedListKey(['A', 'B', 'C', 'D']));
  });
});

describe('smart-money-trenches failures and full-aggregate lookup (audit #39, #44)', () => {
  const now = Math.floor(Date.now() / 1000);
  const seeds = TRENCHES_SMART_MONEY_SEEDS.map((s) => s.address);
  const build = () => {
    // Low cadence for every seed (5 txs over 10 h); the first seed's read fails.
    const helius = { getSignaturesForAddress: async (addr: string) => {
      if (addr === seeds[0]) throw new Error('helius 429');
      return Array.from({ length: 5 }, (_, i) => ({ signature: `${addr}${i}`, blockTime: now - i * 7200 }));
    } } as any;
    // The second seed bought 30 distinct fresh tokens; the third bought token #29 too, so it ranks first.
    const buysFor = (addr: string) => addr === seeds[1]
      ? Array.from({ length: 30 }, (_, i) => ({ mint: `MINT${i}`, timestamp: now - 600 - i, spent_usd: 10 }))
      : addr === seeds[2] ? [{ mint: 'MINT29', timestamp: now - 60, spent_usd: 5 }] : [];
    const copyTrade = { getRecentBuys: async (addr: string) => buysFor(addr) } as any;
    // MINT7's lookup fails (429); everything else is a 2-hour-old token.
    const dex = { getTokenData: async (m: string) => {
      if (m === 'MINT7') throw new Error('dexscreener 429');
      return { pairCreatedAt: Date.now() - 2 * 3_600_000, symbol: m, liquidity: 5000, marketCap: 50_000, price: 0.001 };
    } } as any;
    const cache = { get: async () => null, set: async () => {} } as any;
    return new TrenchesSmartMoneyAnalyzer(helius, dex, copyTrade, cache);
  };
  test('a failed seed read is counted, not scanned; a failed token lookup is not "unknown age"; degraded', async () => {
    const r = await build().enrich(12, 72, 1, 25);
    expect(r.seeds_failed).toBe(1);
    expect(r.seeds_scanned).toBe(TRENCHES_SMART_MONEY_SEEDS.length + TRENCHES_CONVICTION_HOLDERS.length - 1 - r.seeds_skipped_bot_cadence.length);
    expect(r.token_lookups_failed).toBe(1);
    expect(r.buys_lookup_failed).toBe(1);
    expect(r.buys_unknown_age).toBe(0);
    expect(r.data_quality.degraded).toBe(true);
    expect(r.signals.length).toBe(25);
  });
  test('lookup() finds a token outside the top-25 slice', async () => {
    const a = build();
    const top = await a.enrich(12, 72, 1, 25);
    const outside = Array.from({ length: 30 }, (_, i) => `MINT${i}`).find((m) => m !== 'MINT7' && !top.signals.some((s) => s.mint === m))!;
    expect(outside).toBeDefined();
    const { signal } = await a.lookup(outside, 12, 72);
    expect(signal?.mint).toBe(outside);
  });
});

describe('runner score', () => {
  test('unknown liquidity is flagged liquidity_unknown, not low_liquidity', () => {
    const r = assessRunner({ ...quiet, age_hours: 2 });
    expect(r.flags).toContain('liquidity_unknown');
    expect(r.flags).not.toContain('low_liquidity');
  });
});

describe('trenches seed exclusions', () => {
  test('no excluded wallet is in the live seed set', () => {
    const live = new Set([...TRENCHES_SMART_MONEY_SEEDS.map((s) => s.address), ...TRENCHES_CONVICTION_HOLDERS.map((s) => s.address)]);
    expect(Object.keys(TRENCHES_SEED_EXCLUDED).filter((a) => live.has(a))).toEqual([]);
  });
});
