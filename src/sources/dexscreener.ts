import type { Cache } from '../cache';
import { CACHE_TTL } from '../config';

// --- Types ---

export interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd: string;
  volume: { h24: number; h6: number; h1: number };
  priceChange: { h1: number; h6: number; h24: number };
  liquidity: { usd: number; base: number; quote: number };
  fdv: number;
  marketCap: number;
}

export interface DexTokenData {
  price: number;
  priceChange24h: number;
  volume24h: number;
  marketCap: number;
  liquidity: number;
  symbol: string;
  name: string;
  pairs: DexPair[];
}

// --- Client ---

export class DexScreenerClient {
  private baseUrl = 'https://api.dexscreener.com';
  private cache: Cache;

  constructor(cache: Cache) {
    this.cache = cache;
  }

  /** Get aggregated token data from all DEX pairs */
  async getTokenData(mint: string): Promise<DexTokenData | null> {
    const cacheKey = `dexscreener:token:${mint}`;
    const cached = await this.cache.get<DexTokenData>(cacheKey);
    if (cached) return cached;

    const res = await fetch(`${this.baseUrl}/tokens/v1/solana/${mint}`, {
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) {
      if (res.status === 404) return null;
      throw new Error(`DexScreener HTTP ${res.status}: ${await res.text()}`);
    }

    const pairs: DexPair[] = await res.json();
    if (!pairs || pairs.length === 0) return null;

    // Use the highest-liquidity pair as the primary source
    const sorted = [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const primary = sorted[0];

    // Aggregate liquidity across all pairs
    const totalLiquidity = pairs.reduce((sum, p) => sum + (p.liquidity?.usd ?? 0), 0);
    const totalVolume24h = pairs.reduce((sum, p) => sum + (p.volume?.h24 ?? 0), 0);

    const data: DexTokenData = {
      price: parseFloat(primary.priceUsd) || 0,
      priceChange24h: primary.priceChange?.h24 ?? 0,
      volume24h: totalVolume24h,
      marketCap: primary.marketCap ?? primary.fdv ?? 0,
      liquidity: totalLiquidity,
      symbol: primary.baseToken.symbol,
      name: primary.baseToken.name,
      pairs: sorted.slice(0, 5),
    };

    await this.cache.set(cacheKey, data, CACHE_TTL.tokenPrice);
    return data;
  }

  /** Get just the price for a token (lightweight) */
  async getTokenPrice(mint: string): Promise<number> {
    const data = await this.getTokenData(mint);
    return data?.price ?? 0;
  }
}
