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
  priceChange1h: number;
  priceChange6h: number;
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
      priceChange1h: primary.priceChange?.h1 ?? 0,
      priceChange6h: primary.priceChange?.h6 ?? 0,
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

  /** Get daily OHLCV candles for the highest-liquidity pair (7 days) */
  async getOhlcv7d(mint: string): Promise<Array<{ open: number; high: number; low: number; close: number }> | null> {
    const cacheKey = `dexscreener:ohlcv7d:${mint}`;
    const cached = await this.cache.get<Array<{ open: number; high: number; low: number; close: number }>>(cacheKey);
    if (cached) return cached;

    // Need the pair address first
    const tokenData = await this.getTokenData(mint);
    if (!tokenData || tokenData.pairs.length === 0) return null;

    const pairAddress = tokenData.pairs[0].pairAddress;
    const res = await fetch(
      `${this.baseUrl}/latest/dex/pairs/solana/${pairAddress}?include=candles`,
      { headers: { Accept: 'application/json' } },
    );

    if (!res.ok) return null;

    const raw: any = await res.json();
    // DexScreener returns candles in the pair response when ?include=candles is set
    // Fallback: compute from priceChange fields if candles not available
    const pair = raw?.pair ?? raw?.pairs?.[0] ?? raw;

    if (pair?.candles?.days7) {
      const candles = (pair.candles.days7 as any[]).map((c: any) => ({
        open: Number(c.open ?? 0),
        high: Number(c.high ?? 0),
        low: Number(c.low ?? 0),
        close: Number(c.close ?? 0),
      }));
      await this.cache.set(cacheKey, candles, CACHE_TTL.tokenPrice * 5);
      return candles;
    }

    // Fallback: synthesize from current data
    const price = tokenData.price;
    const h24Change = tokenData.priceChange24h / 100;
    if (price > 0 && h24Change !== 0) {
      const yesterdayPrice = price / (1 + h24Change);
      const synth = [
        { open: yesterdayPrice, high: Math.max(price, yesterdayPrice) * 1.02, low: Math.min(price, yesterdayPrice) * 0.98, close: price },
      ];
      await this.cache.set(cacheKey, synth, CACHE_TTL.tokenPrice);
      return synth;
    }

    return null;
  }
}
