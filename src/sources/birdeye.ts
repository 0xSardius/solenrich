import { CONFIG, CACHE_TTL } from '../config';
import type { Cache } from '../cache';

// --- Types ---

export interface TokenOverview {
  price: number;
  priceChange24h: number;
  volume24h: number;
  marketCap: number;
  holder: number;
  supply: number;
  decimals: number;
  symbol: string;
  name: string;
  liquidity: number;
  logoURI?: string;
}

export interface TokenSecurity {
  top10HolderPercent: number;
  freezeAuthority: string | null;
  mintAuthority: string | null;
  isToken2022: boolean;
  transferFeeEnable: boolean;
  nonTransferable: boolean;
  creatorAddress: string | null;
  creationTime: number | null;
}

export interface Holder {
  address: string;
  amount: number;
  percentage: number;
  uiAmount: number;
}

export interface WalletPortfolioItem {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  balance: number;
  uiAmount: number;
  valueUsd: number;
  priceUsd: number;
  priceChange24h: number;
}

export interface WalletPortfolio {
  items: WalletPortfolioItem[];
  totalUsd: number;
}

export interface OHLCV {
  unixTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// --- Client ---

export class BirdeyeClient {
  private apiKey: string;
  private baseUrl: string;
  private cache: Cache;

  constructor(cache: Cache) {
    this.apiKey = CONFIG.birdeye.apiKey;
    this.baseUrl = CONFIG.birdeye.baseUrl;
    this.cache = cache;
  }

  async getTokenPrice(mint: string): Promise<{ value: number; updateUnixTime: number }> {
    const cacheKey = `birdeye:price:${mint}`;
    const cached = await this.cache.get<{ value: number; updateUnixTime: number }>(cacheKey);
    if (cached) return cached;

    const data = await this.get<{ data: { value: number; updateUnixTime: number } }>(
      `/defi/price?address=${mint}`,
    );
    const result = data.data;
    await this.cache.set(cacheKey, result, CACHE_TTL.tokenPrice);
    return result;
  }

  async getTokenOverview(mint: string): Promise<TokenOverview> {
    const cacheKey = `birdeye:overview:${mint}`;
    const cached = await this.cache.get<TokenOverview>(cacheKey);
    if (cached) return cached;

    const data = await this.get<{ data: TokenOverview }>(`/defi/token_overview?address=${mint}`);
    await this.cache.set(cacheKey, data.data, CACHE_TTL.tokenPrice);
    return data.data;
  }

  async getTokenSecurity(mint: string): Promise<TokenSecurity> {
    const cacheKey = `birdeye:security:${mint}`;
    const cached = await this.cache.get<TokenSecurity>(cacheKey);
    if (cached) return cached;

    const data = await this.get<{ data: TokenSecurity }>(`/defi/token_security?address=${mint}`);
    await this.cache.set(cacheKey, data.data, CACHE_TTL.tokenMetadata);
    return data.data;
  }

  async getTokenHolders(mint: string, limit = 20): Promise<Holder[]> {
    const cacheKey = `birdeye:holders:${mint}`;
    const cached = await this.cache.get<Holder[]>(cacheKey);
    if (cached) return cached;

    const data = await this.get<{ data: { items: Holder[] } }>(
      `/defi/v3/token/holder?address=${mint}&limit=${limit}`,
    );
    const holders = data.data?.items ?? [];
    await this.cache.set(cacheKey, holders, CACHE_TTL.holderData);
    return holders;
  }

  async getWalletPortfolio(address: string): Promise<WalletPortfolio> {
    const cacheKey = `birdeye:portfolio:${address}`;
    const cached = await this.cache.get<WalletPortfolio>(cacheKey);
    if (cached) return cached;

    const data = await this.get<{ data: { items: WalletPortfolioItem[]; totalUsd: number } }>(
      `/v1/wallet/token_list?wallet=${address}`,
    );
    const portfolio: WalletPortfolio = {
      items: data.data?.items ?? [],
      totalUsd: data.data?.totalUsd ?? 0,
    };
    await this.cache.set(cacheKey, portfolio, CACHE_TTL.walletProfile);
    return portfolio;
  }

  async getOHLCV(mint: string, timeframe = '1H'): Promise<OHLCV[]> {
    const data = await this.get<{ data: { items: OHLCV[] } }>(
      `/defi/ohlcv?address=${mint}&type=${timeframe}`,
    );
    return data.data?.items ?? [];
  }

  // --- Internal ---

  private async get<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    for (let attempt = 0; attempt <= 1; attempt++) {
      const res = await fetch(url, {
        headers: {
          'X-API-KEY': this.apiKey,
          'x-chain': 'solana',
          'Accept': 'application/json',
        },
      });

      if (res.status === 429 && attempt === 0) {
        console.warn('[birdeye] Rate limited, retrying in 1s...');
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      if (!res.ok) {
        throw new Error(`Birdeye HTTP ${res.status}: ${await res.text()}`);
      }

      return res.json() as Promise<T>;
    }
    throw new Error('Birdeye: exhausted retries');
  }
}
