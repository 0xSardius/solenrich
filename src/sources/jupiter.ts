import { CONFIG, CACHE_TTL } from '../config';
import type { Cache } from '../cache';

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

  /** Batch price lookup — up to 50 mints per call */
  async getPrice(mints: string[]): Promise<Record<string, JupiterPrice>> {
    const result: Record<string, JupiterPrice> = {};
    const misses: string[] = [];

    for (const mint of mints) {
      const cached = await this.cache.get<JupiterPrice>(`jupiter:price:${mint}`);
      if (cached) {
        result[mint] = cached;
      } else {
        misses.push(mint);
      }
    }

    if (misses.length === 0) return result;

    const url = `${this.baseUrl}/price/v2?ids=${misses.join(',')}`;
    const res = await this.fetchWithKey(url);
    if (!res.ok) throw new Error(`Jupiter Price HTTP ${res.status}: ${await res.text()}`);

    const raw: { data: Record<string, any> } = await res.json();

    for (const [mint, entry] of Object.entries(raw.data ?? {})) {
      if (!entry) continue;
      const price: JupiterPrice = {
        id: entry.id ?? mint,
        mintSymbol: entry.mintSymbol ?? '',
        vsToken: entry.vsToken ?? '',
        vsTokenSymbol: entry.vsTokenSymbol ?? 'USDC',
        price: Number(entry.price ?? 0),
      };
      result[mint] = price;
      await this.cache.set(`jupiter:price:${mint}`, price, CACHE_TTL.jupiterPrice);
    }

    return result;
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

  private fetchWithKey(url: string): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    return fetch(url, { headers });
  }
}
