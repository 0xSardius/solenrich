// Token-core data fidelity (audit 2026-11-14): missing data is null with a source, never a plausible fake value.
import { describe, expect, test, afterEach, beforeEach } from 'bun:test';
import { DexScreenerClient } from '../src/sources/dexscreener';
import { JupiterClient, jupiterLimiter } from '../src/sources/jupiter';
import { TokenAnalyzer } from '../src/enrichers/token-analyzer';
import { scoreTokenRisk } from '../src/enrichers/risk-scorer';
import { DueDiligenceAnalyzer } from '../src/enrichers/due-diligence';
import { formatDueDiligenceBriefing } from '../src/formatters/llm-due-diligence';

const noCache = { get: async () => null, set: async () => {}, mget: async (k: string[]) => k.map(() => null) } as any;
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });
beforeEach(() => jupiterLimiter.reset()); // mocked calls must not use up the real Free-plan budget model
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
function analyzer(o: { dex?: any; dexThrows?: boolean; jup?: any; jupThrows?: boolean; mintThrows?: boolean; mint?: any; largest?: any[]; lastMaxAge?: number }) {
  const dexscreener = { getTokenData: async () => { if (o.dexThrows) throw new Error('429'); return o.dex ?? null; } };
  const jupiter = {
    getTokenInfo: async () => { if (o.jupThrows) throw new Error('429'); return o.jup ?? null; },
    getSlippage: async (_m: string, maxAge: number) => { o.lastMaxAge = maxAge; return { estimates: [], age_s: null }; },
  };
  const rpc = {
    getMintInfo: async () => {
      if (o.mintThrows) throw new Error('rpc timeout');
      return o.mint ?? { decimals: 6, supply: 1_000_000_000_000, mintAuthority: null, freezeAuthority: null };
    },
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
  test('the HHI is labelled as a top-20 partial index (audit #40)', async () => {
    const t = await analyzer({ dex: dex(), jup: { verified: true }, largest: top20 }).enrich('M', true);
    expect(t.concentration?.herfindahl_scope).toBe('top_20_holders');
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
    jupiterLimiter.reset(); // 8 quotes exceed the 6-per-10 s quote share; this test is about cache age only
    const refetch = await j.getSlippage('M', 120); // fresh token: 200 s is too old
    expect(calls).toBe(8);
    expect(refetch.age_s).toBe(0);
  });
});

describe('Mint account unread → authorities unknown, not renounced (audit #28)', () => {
  test('mint info read: renounced authorities are known; supply set', async () => {
    const t = await analyzer({ dex: dex(), jup: { verified: true } }).enrich('M');
    expect(t.authorities_known).toBe(true);
    expect(t.mint_authority).toBeNull();
    expect(t.supply).toBe(1_000_000);
  });
  test('mint info failed → authorities_known false, supply null, degraded, no authority flags', async () => {
    const t = await analyzer({ dex: dex(), jup: { verified: true, decimals: 6 }, mintThrows: true, largest: top20 }).enrich('M', true);
    expect(t.authorities_known).toBe(false);
    expect(t.supply).toBeNull();
    expect(t.concentration).toBeUndefined();
    expect(t.data_quality.degraded).toBe(true);
    expect(t.data_quality.unavailable).toContain('mint_info');
  });
  test('scoreTokenRisk: unknown authorities are not scored but are named', () => {
    const r = scoreTokenRisk({ risk_flags_count: 0, verified: true, mint_authority_active: null, freeze_authority_active: null, liquidity: 100_000 });
    expect(r.score).toBe(0);
    expect(r.factors.some((f) => f.includes('not read'))).toBe(true);
  });
  test('due-diligence: unknown authorities withhold SAFE (CAUTION at most safe), short cache, LLM says unknown', async () => {
    const sets: Array<[string, number]> = [];
    const cache = { get: async () => null, set: async (k: string, _v: unknown, ttl: number) => { sets.push([k, ttl]); } } as any;
    const token = await analyzer({ dex: dex(), jup: { verified: true }, mintThrows: true }).enrich('M');
    const whales = { mint: 'M', threshold_usd: 10000, lookback_hours: 72, whales: [], program_accounts: [], total_whale_volume_usd: 0,
      net_flow_direction: 'neutral', whale_count: 0, holders_source: 'rpc', data_quality: { degraded: false, unavailable: [] }, last_updated: '' };
    const dd = await new DueDiligenceAnalyzer({ enrich: async () => token } as any, { enrich: async () => whales } as any, cache).enrich('M');
    expect(dd.recommendation).toBe('CAUTION');
    expect(sets[0][1]).toBeLessThanOrEqual(15);
    const brief = formatDueDiligenceBriefing(dd);
    expect(brief).toContain('could not be read');
  });
  test('due-diligence: whale-watch failed → LLM says not measured, not "no whale activity"; risk factor names it', async () => {
    const cache = { get: async () => null, set: async () => {} } as any;
    const token = await analyzer({ dex: dex(), jup: { verified: true } }).enrich('M');
    const dd = await new DueDiligenceAnalyzer({ enrich: async () => token } as any, { enrich: async () => { throw new Error('rpc'); } } as any, cache).enrich('M');
    const brief = formatDueDiligenceBriefing(dd);
    expect(brief).not.toContain('No significant whale activity detected');
    expect(brief).toContain('not measured');
    expect(dd.risk_factors.some((f) => f.toLowerCase().includes('whale') && f.includes('not measured'))).toBe(true);
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
