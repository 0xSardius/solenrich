// Token-core data fidelity (audit 2026-11-14): missing data is null with a source, never a plausible fake value.
import { describe, expect, test, afterEach } from 'bun:test';
import { DexScreenerClient } from '../src/sources/dexscreener';
import { JupiterClient } from '../src/sources/jupiter';
import { TokenAnalyzer } from '../src/enrichers/token-analyzer';
import { scoreTokenRisk } from '../src/enrichers/risk-scorer';

const noCache = { get: async () => null, set: async () => {}, mget: async (k: string[]) => k.map(() => null) } as any;
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
const mockFetch = (body: unknown, status = 200) => {
  globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as any;
};

const pair = (o: Record<string, unknown>) => ({
  chainId: 'solana', dexId: 'pumpswap', pairAddress: 'P', baseToken: { address: 'M', name: 'Tok', symbol: 'TOK' },
  quoteToken: { address: 'So11111111111111111111111111111111111111112', name: 'SOL', symbol: 'SOL' },
  volume: { h24: 1000, h6: 500, h1: 100 }, priceChange: { h1: 1, h6: 2, h24: 3 }, ...o,
});

describe('DexScreener: unknown is null, not 0', () => {
  test('bonding-curve pair without a liquidity object → liquidity null, bondingCurve true', async () => {
    mockFetch([pair({ dexId: 'pumpfun', priceUsd: '0.00003', marketCap: 30000 })]);
    const d = await new DexScreenerClient(noCache).getTokenData('M');
    expect(d!.liquidity).toBeNull();
    expect(d!.bondingCurve).toBe(true);
    expect(d!.price).toBe(0.00003);
  });
  test('pair with only priceNative → price null and marketCap null', async () => {
    mockFetch([pair({ priceNative: '0.00000001', liquidity: { usd: 5000, base: 1, quote: 1 } })]);
    const d = await new DexScreenerClient(noCache).getTokenData('M');
    expect(d!.price).toBeNull();
    expect(d!.marketCap).toBeNull();
    expect(d!.liquidity).toBe(5000);
  });
  test('price comes from a priced pair when the deepest pair has no priceUsd', async () => {
    mockFetch([pair({ liquidity: { usd: 9000, base: 1, quote: 1 } }), pair({ priceUsd: '0.5', liquidity: { usd: 100, base: 1, quote: 1 } })]);
    const d = await new DexScreenerClient(noCache).getTokenData('M');
    expect(d!.price).toBe(0.5);
    expect(d!.liquidity).toBe(9100);
  });
});

describe('Jupiter slippage is reported in percent', () => {
  test('priceImpactPct 0.909 (a fraction) → 90.9%', async () => {
    mockFetch({ priceImpactPct: '0.909', outAmount: '1' });
    const s = await new JupiterClient(noCache).getSlippageEstimates('M');
    expect(s.length).toBe(4);
    expect(s[0].price_impact_pct).toBeCloseTo(90.9, 5);
  });
  test('missing priceImpactPct → no estimate (not 0%)', async () => {
    mockFetch({ outAmount: '1' });
    const s = await new JupiterClient(noCache).getSlippageEstimates('M');
    expect(s.length).toBe(0);
  });
});

// TokenAnalyzer with stub sources
function analyzer(o: { dex?: any; dexThrows?: boolean; jup?: any; jupThrows?: boolean; largest?: any[]; lastMaxAge?: number }) {
  const dexscreener = { getTokenData: async () => { if (o.dexThrows) throw new Error('429'); return o.dex ?? null; } };
  const jupiter = {
    getTokenInfo: async () => { if (o.jupThrows) throw new Error('429'); return o.jup ?? null; },
    getSlippage: async (_m: string, maxAge: number) => { o.lastMaxAge = maxAge; return { estimates: [], age_s: null }; },
  };
  const rpc = {
    getMintInfo: async () => ({ decimals: 6, supply: 1_000_000_000_000, mintAuthority: null, freezeAuthority: null }),
    getTokenLargestAccounts: async () => o.largest ?? [],
    resolveTokenAccountOwners: async (a: string[]) => a.map((x) => ({ tokenAccount: x, owner: x })),
  };
  return new TokenAnalyzer({} as any, dexscreener as any, rpc as any, jupiter as any, noCache);
}
const dex = (o: Record<string, unknown> = {}) => ({ price: 0.001, priceChange1h: 1, priceChange6h: 5, priceChange24h: 10, volume24h: 5000,
  marketCap: 1_000_000, liquidity: 80_000, bondingCurve: false, symbol: 'TOK', name: 'Tok', pairs: [], pairCreatedAt: null, ...o });
const top20 = Array.from({ length: 20 }, (_, i) => ({ address: `acct${i}`, uiAmount: 1000 }));

describe('TokenAnalyzer: fidelity of core fields', () => {
  test('holder_count is never the top-20 list length', async () => {
    const t = await analyzer({ dex: dex(), jup: { verified: true, holderCount: null }, largest: top20 }).enrich('M', true);
    expect(t.holder_count).toBeNull();
    expect(t.holder_count_source).toBeNull();
    expect(t.top_holders!.length).toBe(20);
  });
  test('holder_count from Jupiter is tagged', async () => {
    const t = await analyzer({ dex: dex(), jup: { verified: true, holderCount: 1027528 } }).enrich('M');
    expect(t.holder_count).toBe(1027528);
    expect(t.holder_count_source).toBe('jupiter');
  });
  test('bonding curve: liquidity from Jupiter, not 0', async () => {
    const t = await analyzer({ dex: dex({ liquidity: null, bondingCurve: true }), jup: { verified: false, liquidity: 5712, holderCount: 99 } }).enrich('M');
    expect(t.liquidity).toBe(5712);
    expect(t.liquidity_source).toBe('jupiter');
    expect(t.bonding_curve).toBe(true);
    expect(t.risk_flags).toContain('low_liquidity');
  });
  test('no liquidity anywhere → null, and no low_liquidity flag', async () => {
    const t = await analyzer({ dex: dex({ liquidity: null }), jup: { verified: true } }).enrich('M');
    expect(t.liquidity).toBeNull();
    expect(t.risk_flags).not.toContain('low_liquidity');
  });
  test('priceNative-only pair → USD price from Jupiter', async () => {
    const t = await analyzer({ dex: dex({ price: null, marketCap: null }), jup: { verified: false, usdPrice: 0.0000069, mcap: 6101 } }).enrich('M');
    expect(t.price_usd).toBe(0.0000069);
    expect(t.price_source).toBe('jupiter');
    expect(t.market_cap).toBe(6101);
  });
  test('Jupiter down → verified null, no unverified flag, degraded', async () => {
    const t = await analyzer({ dex: dex(), jupThrows: true }).enrich('M');
    expect(t.verified).toBeNull();
    expect(t.risk_flags).not.toContain('unverified');
    expect(t.data_quality.degraded).toBe(true);
    expect(t.data_quality.unavailable).toContain('jupiter_token');
  });
  test('all core sources answer → not degraded', async () => {
    const t = await analyzer({ dex: dex(), jup: { verified: true, holderCount: 10 } }).enrich('M');
    expect(t.data_quality.degraded).toBe(false);
  });
  test('DexScreener-only volatility is labelled 24h; 7d fields are null', async () => {
    const t = await analyzer({ dex: dex(), jup: { verified: true } }).enrich('M');
    expect(t.volatility!.window).toBe('24h');
    expect(t.volatility!.daily_std_7d).toBeNull();
    expect(t.volatility!.high_7d).toBeNull();
    expect(t.volatility!.range_pct_24h).toBeGreaterThan(0);
  });
});

describe('Slippage cache age is tiered by token age', () => {
  test('token < 24h old (or unknown age) asks for quotes at most 120 s old; older tokens 300 s', async () => {
    const fresh: any = { dex: dex({ pairCreatedAt: Date.now() - 3 * 3_600_000 }), jup: { verified: true } };
    await analyzer(fresh).enrich('M');
    expect(fresh.lastMaxAge).toBe(120);
    const unknown: any = { dex: dex({ pairCreatedAt: null }), jup: { verified: true } };
    await analyzer(unknown).enrich('M');
    expect(unknown.lastMaxAge).toBe(120);
    const old: any = { dex: dex({ pairCreatedAt: Date.now() - 30 * 86_400_000 }), jup: { verified: true } };
    await analyzer(old).enrich('M');
    expect(old.lastMaxAge).toBe(300);
  });
  test('JupiterClient.getSlippage reuses a cached entry within maxAge and refetches when older', async () => {
    const store = new Map<string, any>();
    const cache = { get: async (k: string) => store.get(k) ?? null, set: async (k: string, v: any) => { store.set(k, v); } } as any;
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response(JSON.stringify({ priceImpactPct: '0.01', outAmount: '1' }), { status: 200 }); }) as any;
    const j = new JupiterClient(cache);
    const first = await j.getSlippage('M', 300);
    expect(first.age_s).toBe(0);
    expect(calls).toBe(4);
    store.get('jupiter:slippage:v2:M').fetched_at = Date.now() - 200_000; // 200 s old
    const reuse = await j.getSlippage('M', 300);
    expect(calls).toBe(4);
    expect(reuse.age_s).toBeGreaterThanOrEqual(199);
    const refetch = await j.getSlippage('M', 120); // fresh token: 200 s is too old
    expect(calls).toBe(8);
    expect(refetch.age_s).toBe(0);
  });
});

describe('scoreTokenRisk: unread values are not penalized', () => {
  const base = { risk_flags_count: 0, mint_authority_active: false, freeze_authority_active: false };
  test('null liquidity and null verified add nothing', () => {
    expect(scoreTokenRisk({ ...base, verified: null, liquidity: null }).score).toBe(0);
  });
  test('measured low liquidity and verified false still score', () => {
    expect(scoreTokenRisk({ ...base, verified: false, liquidity: 5000 }).score).toBeCloseTo(0.35, 5);
  });
});
