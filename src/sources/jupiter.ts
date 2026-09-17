import { CONFIG, CACHE_TTL } from '../config';
import type { Cache } from '../cache';
import { drain } from '../utils/drain';

// --- Types ---

export interface JupiterToken {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  tags: string[];
  logoURI?: string;
  verified?: boolean;
}

export interface JupiterPrice {
  id: string;
  mintSymbol: string;
  vsToken: string;
  vsTokenSymbol: string;
  price: number;
}

export interface SlippageEstimate {
  size_usd: number;
  price_impact_pct: number;
  output_amount: number;
  input_amount: number;
}

// USDC mint on Solana mainnet
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

// --- Client ---

export class JupiterClient {
  private apiKey: string;
  private baseUrl: string;
  private cache: Cache;

  constructor(cache: Cache) {
    this.apiKey = CONFIG.jupiter.apiKey;
    this.baseUrl = CONFIG.jupiter.baseUrl;
    this.cache = cache;
  }

  /**
   * Batch price lookup — up to 50 mints per call.
   *
   * Uses Jupiter Price v3 at lite-api.jup.ag because:
   *   - api.jup.ag/price/v2 returns 404 (deprecated, verified 2026-05-27)
   *   - lite-api has no API key requirement and works for all SPL mints
   *
   * v3 response shape: `{ "<mint>": { usdPrice, liquidity, decimals, priceChange24h, ... } }`
   * Mapped to our JupiterPrice contract so callers don't see the schema change.
   */
  async getPrice(mints: string[]): Promise<Record<string, JupiterPrice>> {
    const result: Record<string, JupiterPrice> = {};
    const misses: string[] = [];

    // One multi-get instead of one get per mint. The per-mint loop cost N Redis
    // commands per call; with 257 quote mints refreshed every 10 minutes by the
    // StonkFun index, that plus the per-miss sets was ~520 commands per refresh
    // (~2.2M/month) and is what exhausted the Upstash free tier on 2026-09-16.
    const cached = await this.cache.mget<JupiterPrice>(mints.map((m) => `jupiter:price:${m}`));
    mints.forEach((mint, i) => {
      const hit = cached[i];
      if (hit) result[mint] = hit;
      else misses.push(mint);
    });

    if (misses.length === 0) return result;

    const fetched = await this.fetchPrices(misses);
    for (const [mint, price] of Object.entries(fetched)) {
      result[mint] = price;
      await this.cache.set(`jupiter:price:${mint}`, price, CACHE_TTL.jupiterPrice);
    }

    return result;
  }

  /**
   * Prices with NO cache reads or writes. For callers that keep their own
   * price table and refresh on a schedule (the StonkFun index): the 60s price
   * TTL guarantees a miss on every 10-minute refresh, so caching only spends
   * Redis commands. Upstream cost is identical (one Jupiter request per ≤50
   * mints either way).
   */
  async getPriceUncached(mints: string[]): Promise<Record<string, JupiterPrice>> {
    return this.fetchPrices(mints);
  }

  private async fetchPrices(mints: string[]): Promise<Record<string, JupiterPrice>> {
    if (mints.length === 0) return {};
    const url = `https://lite-api.jup.ag/price/v3?ids=${mints.join(',')}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Jupiter Price HTTP ${res.status}: ${await res.text()}`);
    const raw: Record<string, { usdPrice?: number; decimals?: number } | null> = await res.json();
    const out: Record<string, JupiterPrice> = {};
    for (const [mint, entry] of Object.entries(raw ?? {})) {
      if (!entry || typeof entry.usdPrice !== 'number') continue;
      out[mint] = { id: mint, mintSymbol: '', vsToken: '', vsTokenSymbol: 'USDC', price: entry.usdPrice };
    }
    return out;
  }

  /** Get token metadata by mint address */
  async getTokenInfo(mint: string): Promise<JupiterToken | null> {
    const cacheKey = `jupiter:token:${mint}`;
    const cached = await this.cache.get<JupiterToken>(cacheKey);
    if (cached) return cached;

    const res = await this.fetchWithKey(`https://tokens.jup.ag/token/${mint}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Jupiter Token HTTP ${res.status}: ${await res.text()}`);

    const raw: any = await res.json();
    const token: JupiterToken = {
      address: raw.address ?? mint,
      name: raw.name ?? '',
      symbol: raw.symbol ?? '',
      decimals: raw.decimals ?? 0,
      tags: raw.tags ?? [],
      logoURI: raw.logoURI,
      verified: raw.verified,
    };

    await this.cache.set(cacheKey, token, CACHE_TTL.tokenMetadata);
    return token;
  }

  /**
   * Get slippage estimates at multiple position sizes by querying Jupiter Quote API.
   * Swaps USDC → token to measure price impact at $100, $1K, $10K, $100K.
   * Queries run in parallel with a per-call abort timeout so a single slow
   * Jupiter response cannot starve the rest. Partial results are still cached.
   */
  async getSlippageEstimates(mint: string): Promise<SlippageEstimate[]> {
    const cacheKey = `jupiter:slippage:${mint}`;
    const cached = await this.cache.get<SlippageEstimate[]>(cacheKey);
    if (cached) return cached;

    const sizes = [
      { usd: 100, amount: 100_000_000 },
      { usd: 1_000, amount: 1_000_000_000 },
      { usd: 10_000, amount: 10_000_000_000 },
      { usd: 100_000, amount: 100_000_000_000 },
    ];

    const PER_CALL_TIMEOUT_MS = 4_000;

    const settled = await Promise.allSettled(
      sizes.map(async (size): Promise<SlippageEstimate | null> => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PER_CALL_TIMEOUT_MS);
        try {
          const url = `${this.baseUrl}/swap/v1/quote?inputMint=${USDC_MINT}&outputMint=${mint}&amount=${size.amount}&slippageBps=50`;
          const res = await this.fetchWithKey(url, controller.signal);
          if (!res.ok) { await drain(res); return null; }
          const quote: any = await res.json();
          const priceImpact = parseFloat(quote.priceImpactPct ?? '0');
          const outAmount = Number(quote.outAmount ?? 0);
          return {
            size_usd: size.usd,
            price_impact_pct: Math.round(priceImpact * 10000) / 10000,
            output_amount: outAmount,
            input_amount: size.amount,
          };
        } catch {
          return null;
        } finally {
          clearTimeout(timer);
        }
      }),
    );

    const results: SlippageEstimate[] = settled
      .map((s) => (s.status === 'fulfilled' ? s.value : null))
      .filter((r): r is SlippageEstimate => r !== null);

    if (results.length > 0) {
      await this.cache.set(cacheKey, results, CACHE_TTL.jupiterPrice);
    }

    return results;
  }

  private fetchWithKey(url: string, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    return fetch(url, { headers, signal });
  }
}
