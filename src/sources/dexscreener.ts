import type { Cache } from '../cache';
import { CACHE_TTL } from '../config';
import { drain } from '../utils/drain';

// --- Types ---

/** Buy/sell transaction counts for one time window. */
export interface TxnCounts {
  buys: number;
  sells: number;
}

/**
 * Per-window transaction counts. DexScreener returns this on every pair; it is
 * the raw input to buy-rate acceleration and buy-pressure (see runner-score.ts).
 */
export interface DexTxns {
  m5: TxnCounts;
  h1: TxnCounts;
  h6: TxnCounts;
  h24: TxnCounts;
}

export interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; name: string; symbol: string };
  quoteToken: { address: string; name: string; symbol: string };
  priceUsd: string;
  volume: { h24: number; h6: number; h1: number; m5?: number };
  priceChange: { h1: number; h6: number; h24: number; m5?: number };
  liquidity: { usd: number; base: number; quote: number };
  fdv: number;
  marketCap: number;
  /** Unix ms when the pair was created on-chain (DexScreener field). Absent on some pairs. */
  pairCreatedAt?: number;
  /** Per-window buy/sell counts. Absent on some pairs (treated as zeroes downstream). */
  txns?: DexTxns;
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
  /** Earliest pair-creation time (Unix ms) across all pairs = launch-time proxy. Null if unknown. */
  pairCreatedAt: number | null;
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
      // 404 is the common case for unknown/too-fresh mints — drain before bailing.
      if (res.status === 404) { await drain(res); return null; }
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

    // Earliest pair creation across all pairs = launch-time proxy (original LP is oldest).
    const createdTimes = pairs.map((p) => p.pairCreatedAt).filter((t): t is number => typeof t === 'number' && t > 0);
    const pairCreatedAt = createdTimes.length > 0 ? Math.min(...createdTimes) : null;

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
      pairCreatedAt,
    };

    await this.cache.set(cacheKey, data, CACHE_TTL.tokenPrice);
    return data;
  }

  /** Get just the price for a token (lightweight) */
  async getTokenPrice(mint: string): Promise<number> {
    const data = await this.getTokenData(mint);
    return data?.price ?? 0;
  }

  /**
   * Token age in hours since its earliest pair was created (launch-time proxy).
   * Returns null when DexScreener exposes no `pairCreatedAt` for any pair.
   */
  async getTokenAgeHours(mint: string): Promise<number | null> {
    const data = await this.getTokenData(mint);
    if (!data || data.pairCreatedAt == null) return null;
    return (Date.now() - data.pairCreatedAt) / 3_600_000;
  }

  /** Get latest token profiles from DexScreener (recently created/boosted) */
  async getLatestProfiles(): Promise<Array<{ mint: string; chainId: string; description?: string; links?: any[] }>> {
    const cacheKey = 'dexscreener:latest-profiles';
    const cached = await this.cache.get<Array<{ mint: string; chainId: string }>>(cacheKey);
    if (cached) return cached;

    const res = await fetch(`${this.baseUrl}/token-profiles/latest/v1`, {
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) { await drain(res); return []; }

    const raw: any[] = await res.json();
    // Filter to Solana only
    const solana = raw
      .filter((p: any) => p.chainId === 'solana' && p.tokenAddress)
      .map((p: any) => ({
        mint: p.tokenAddress,
        chainId: p.chainId,
        description: p.description,
        links: p.links,
      }));

    await this.cache.set(cacheKey, solana, 300); // 5 min cache
    return solana;
  }

  /**
   * Candidate universe for velocity scanning: the union of DexScreener's three
   * public discovery surfaces (latest profiles + latest boosts + top boosts),
   * Solana only, deduped.
   *
   * HONEST LIMITATION: all three surfaces are pay-to-appear (a dev buys a profile
   * or a boost), so this is a promoted-token universe, not every fresh launch.
   * DexScreener exposes no public "all new pairs" feed. It is nonetheless the
   * right v1 pool — promoted tokens are where retail flow actually lands — and
   * `runner-scan` reports the bias in its output so consumers can weight it.
   */
  async getTrendingCandidates(): Promise<string[]> {
    const cacheKey = 'dexscreener:trending-candidates';
    const cached = await this.cache.get<string[]>(cacheKey);
    if (cached) return cached;

    const paths = ['token-profiles/latest/v1', 'token-boosts/latest/v1', 'token-boosts/top/v1'];
    const settled = await Promise.allSettled(
      paths.map((p) => fetch(`${this.baseUrl}/${p}`, { headers: { Accept: 'application/json' } })),
    );

    const mints = new Set<string>();
    for (const r of settled) {
      if (r.status !== 'fulfilled' || !r.value.ok) continue;
      let raw: any;
      try {
        raw = await r.value.json();
      } catch {
        continue;
      }
      if (!Array.isArray(raw)) continue;
      for (const item of raw) {
        if (item?.chainId === 'solana' && typeof item?.tokenAddress === 'string') {
          mints.add(item.tokenAddress);
        }
      }
    }

    const list = [...mints];
    await this.cache.set(cacheKey, list, 120); // 2 min — candidate churn is fast
    return list;
  }

  /**
   * Batch pair lookup — `tokens/v1/solana/{mint1,mint2,...}` accepts up to 30
   * comma-separated addresses per call, so a 45-token scan costs 2 requests
   * instead of 45. Returns the raw pairs; callers group by `baseToken.address`.
   */
  async getPairsBatch(mints: string[]): Promise<DexPair[]> {
    const out: DexPair[] = [];
    for (let i = 0; i < mints.length; i += 30) {
      const chunk = mints.slice(i, i + 30);
      try {
        const res = await fetch(`${this.baseUrl}/tokens/v1/solana/${chunk.join(',')}`, {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) { await drain(res); continue; }
        const pairs: unknown = await res.json();
        if (Array.isArray(pairs)) out.push(...(pairs as DexPair[]));
      } catch (err) {
        console.warn(`[dexscreener] batch chunk failed: ${err}`);
      }
    }
    return out;
  }

  /** Search DexScreener for tokens matching a query */
  async search(query: string): Promise<DexPair[]> {
    const res = await fetch(`${this.baseUrl}/latest/dex/search?q=${encodeURIComponent(query)}`, {
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) { await drain(res); return []; }
    const raw: any = await res.json();
    return (raw.pairs ?? []).filter((p: any) => p.chainId === 'solana');
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

    if (!res.ok) { await drain(res); return null; }

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
