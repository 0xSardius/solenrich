import { CONFIG, CACHE_TTL } from '../config';
import type { Cache } from '../cache';

// --- Types ---

export interface HeliusAsset {
  id: string;
  interface: string;
  content?: {
    metadata?: { name?: string; symbol?: string; description?: string };
    links?: Record<string, string>;
    files?: Array<{ uri: string; mime?: string }>;
  };
  token_info?: {
    symbol?: string;
    balance?: number;
    supply?: number;
    decimals?: number;
    token_program?: string;
    price_info?: {
      price_per_token?: number;
      currency?: string;
      total_price?: number;
    };
    mint_authority?: string;
    freeze_authority?: string;
  };
  ownership: { owner: string; frozen: boolean; delegated: boolean };
  compression?: { compressed: boolean };
  grouping?: Array<{ group_key: string; group_value: string }>;
  creators?: Array<{ address: string; share: number; verified: boolean }>;
  burnt: boolean;
  mutable: boolean;
}

export interface HeliusAssetList {
  total: number;
  limit: number;
  page: number;
  items: HeliusAsset[];
  nativeBalance?: { lamports: number; price_per_sol?: number; total_price?: number };
}

export interface TokenAccount {
  address?: string;
  mint?: string;
  owner?: string;
  amount?: number;
  delegated_amount?: number;
  frozen?: boolean;
}

export interface EnhancedTransaction {
  description: string;
  type: string;
  source: string;
  fee: number;
  feePayer: string;
  signature: string;
  slot: number;
  timestamp: number;
  nativeTransfers: Array<{ fromUserAccount: string; toUserAccount: string; amount: number }> | null;
  tokenTransfers: Array<{
    fromUserAccount: string;
    toUserAccount: string;
    fromTokenAccount: string;
    toTokenAccount: string;
    tokenAmount: number;
    decimals: number;
    tokenStandard: string;
    mint: string;
  }> | null;
  accountData: Array<{
    account: string;
    nativeBalanceChange: number;
    tokenBalanceChanges: unknown[];
  }>;
  transactionError: unknown | null;
  instructions: unknown[];
  events: {
    nft: unknown | null;
    swap: unknown | null;
    compressed: unknown[] | null;
  };
}

// --- Client ---

export class HeliusClient {
  private apiKey: string;
  private baseUrl: string;
  private rpcUrl: string;
  private cache: Cache;

  constructor(cache: Cache) {
    this.apiKey = CONFIG.helius.apiKey;
    this.baseUrl = CONFIG.helius.baseUrl;
    this.rpcUrl = CONFIG.helius.rpcUrl;
    this.cache = cache;
  }

  /** DAS API: get all assets owned by a wallet */
  async getAssetsByOwner(address: string): Promise<HeliusAssetList> {
    const cacheKey = `helius:assets:${address}`;
    const cached = await this.cache.get<HeliusAssetList>(cacheKey);
    if (cached) return cached;

    const result = await this.dasRpc<HeliusAssetList>('getAssetsByOwner', {
      ownerAddress: address,
      page: 1,
      displayOptions: { showFungible: true, showNativeBalance: true },
    });

    await this.cache.set(cacheKey, result, CACHE_TTL.walletProfile);
    return result;
  }

  /** DAS API: get token accounts for a wallet */
  async getTokenAccounts(address: string): Promise<TokenAccount[]> {
    const cacheKey = `helius:tokens:${address}`;
    const cached = await this.cache.get<TokenAccount[]>(cacheKey);
    if (cached) return cached;

    const result = await this.dasRpc<{ token_accounts?: TokenAccount[] }>(
      'getTokenAccountsByOwner',
      { owner: address },
    );

    const accounts = result.token_accounts ?? [];
    await this.cache.set(cacheKey, accounts, CACHE_TTL.walletProfile);
    return accounts;
  }

  /** DAS API: search assets with flexible params */
  async searchAssets(params: Record<string, unknown>): Promise<HeliusAsset[]> {
    const result = await this.dasRpc<{ items: HeliusAsset[] }>('searchAssets', params);
    return result.items ?? [];
  }

  /** Enhanced transaction parsing (REST) — single */
  async getEnhancedTransaction(signature: string): Promise<EnhancedTransaction | null> {
    const cacheKey = `helius:tx:${signature}`;
    const cached = await this.cache.get<EnhancedTransaction>(cacheKey);
    if (cached) return cached;

    const txs = await this.getEnhancedTransactions([signature]);
    const tx = txs[0] ?? null;

    if (tx) {
      await this.cache.set(cacheKey, tx, CACHE_TTL.transaction);
    }
    return tx;
  }

  /** Enhanced transaction parsing (REST) — batch, max 100 */
  async getEnhancedTransactions(signatures: string[]): Promise<EnhancedTransaction[]> {
    const url = `${this.baseUrl}/transactions/?api-key=${this.apiKey}`;
    const res = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transactions: signatures }),
    });
    return res as EnhancedTransaction[];
  }

  /** Get recent transaction signatures for an address via Helius RPC */
  async getSignaturesForAddress(
    address: string,
    limit = 100,
  ): Promise<Array<{ signature: string; slot: number; blockTime: number | null }>> {
    const result = await this.dasRpc<
      Array<{ signature: string; slot: number; blockTime: number | null }>
    >('getSignaturesForAddress', [address, { limit }], true);
    return result;
  }

  // --- Internal helpers ---

  private async dasRpc<T>(method: string, params: unknown, isStandardRpc = false): Promise<T> {
    const body = {
      jsonrpc: '2.0',
      id: `solenrich-${Date.now()}`,
      method,
      params: isStandardRpc ? params : params,
    };

    const res = await this.fetchWithRetry(this.rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (res.error) {
      throw new Error(`Helius DAS ${method} error: ${JSON.stringify(res.error)}`);
    }
    return res.result as T;
  }

  private async fetchWithRetry(url: string, init: RequestInit, retries = 1): Promise<any> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const res = await fetch(url, init);

      if (res.status === 429 && attempt < retries) {
        console.warn('[helius] Rate limited, retrying in 1s...');
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      if (!res.ok) {
        throw new Error(`Helius HTTP ${res.status}: ${await res.text()}`);
      }

      return res.json();
    }
  }
}
