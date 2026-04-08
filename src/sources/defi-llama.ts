import { CONFIG, CACHE_TTL } from '../config';
import type { Cache } from '../cache';

// --- Types ---

export interface Protocol {
  name: string;
  slug: string;
  tvl: number;
  chain: string;
  chains: string[];
  category: string;
  logo?: string;
  url?: string;
}

export interface ProtocolDetail {
  tvl: number;
  chains: Record<string, number>;
  name: string;
  slug: string;
  category: string;
}

export interface YieldPool {
  pool: string;
  chain: string;
  project: string;
  symbol: string;
  tvlUsd: number;
  apy: number;
  apyBase?: number;
  apyReward?: number;
  underlyingTokens?: string[];
  rewardTokens?: string[];
}

// --- Client ---

export class DefiLlamaClient {
  private baseUrl: string;
  private yieldsUrl: string;
  private cache: Cache;

  constructor(cache: Cache) {
    this.baseUrl = CONFIG.defiLlama.baseUrl;
    this.yieldsUrl = CONFIG.defiLlama.yieldsUrl;
    this.cache = cache;
  }

  async getProtocolTvl(slug: string): Promise<ProtocolDetail> {
    const cacheKey = `defillama:protocol:${slug}`;
    const cached = await this.cache.get<ProtocolDetail>(cacheKey);
    if (cached) return cached;

    // Use lightweight /tvl endpoint + protocol list for metadata
    // The full /protocol/{slug} endpoint returns megabytes of historical data and times out
    const [tvlRes, protocols] = await Promise.all([
      fetch(`${this.baseUrl}/tvl/${slug}`).then((r) => r.ok ? r.text() : '0').catch(() => '0'),
      this.getSolanaProtocols().catch(() => [] as Protocol[]),
    ]);

    const totalTvl = parseFloat(tvlRes) || 0;
    const meta = protocols.find((p) => p.slug.toLowerCase() === slug.toLowerCase());

    // /tvl/ returns total TVL across all chains. Use protocol list's per-chain TVL if available.
    const result: ProtocolDetail = {
      tvl: meta?.tvl ?? totalTvl,
      chains: { total: totalTvl },
      name: meta?.name ?? slug,
      slug: meta?.slug ?? slug,
      category: meta?.category ?? 'Unknown',
    };

    // Try to get chain breakdown from full endpoint with a short timeout
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      const fullRes = await fetch(`${this.baseUrl}/protocol/${slug}`, { signal: controller.signal });
      clearTimeout(timer);
      if (fullRes.ok) {
        const raw: any = await fullRes.json();
        if (raw.currentChainTvls) result.chains = raw.currentChainTvls;
        if (raw.category) result.category = raw.category;
        if (raw.name) result.name = raw.name;
        // Prefer Solana-specific TVL if available
        if (raw.currentChainTvls?.Solana) result.tvl = raw.currentChainTvls.Solana;
      }
    } catch {
      // Full endpoint timed out — proceed with lightweight data
    }

    await this.cache.set(cacheKey, result, CACHE_TTL.defiProtocol);
    return result;
  }

  async getSolanaProtocols(): Promise<Protocol[]> {
    const cacheKey = 'defillama:protocols:solana';
    const cached = await this.cache.get<Protocol[]>(cacheKey);
    if (cached) return cached;

    const res = await fetch(`${this.baseUrl}/protocols`);
    if (!res.ok) throw new Error(`DeFi Llama HTTP ${res.status}: ${await res.text()}`);

    const raw: any[] = await res.json();
    const solana = raw
      .filter((p) => p.chains?.includes('Solana'))
      .map((p) => ({
        name: p.name,
        slug: p.slug,
        tvl: p.tvl ?? 0,
        chain: 'Solana',
        chains: p.chains ?? [],
        category: p.category ?? 'Unknown',
        logo: p.logo,
        url: p.url,
      }));

    // Cache aggressively — protocol list doesn't change often
    await this.cache.set(cacheKey, solana, 1800);
    return solana;
  }

  async getYields(): Promise<YieldPool[]> {
    const cacheKey = 'defillama:yields:solana';
    const cached = await this.cache.get<YieldPool[]>(cacheKey);
    if (cached) return cached;

    const res = await fetch(`${this.yieldsUrl}/pools`);
    if (!res.ok) throw new Error(`DeFi Llama Yields HTTP ${res.status}: ${await res.text()}`);

    const raw: any = await res.json();
    const pools: YieldPool[] = (raw.data ?? [])
      .filter((p: any) => p.chain === 'Solana')
      .map((p: any) => ({
        pool: p.pool,
        chain: p.chain,
        project: p.project,
        symbol: p.symbol,
        tvlUsd: p.tvlUsd ?? 0,
        apy: p.apy ?? 0,
        apyBase: p.apyBase,
        apyReward: p.apyReward,
        underlyingTokens: p.underlyingTokens,
        rewardTokens: p.rewardTokens,
      }));

    await this.cache.set(cacheKey, pools, CACHE_TTL.defiProtocol);
    return pools;
  }
}
