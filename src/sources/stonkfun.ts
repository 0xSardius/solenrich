import { CACHE_TTL } from '../config';
import type { Cache } from '../cache';
import { drain } from '../utils/drain';

// StonkFun public API — quote-paired coin launches on Solana (stonkfun.xyz).
// Base: https://www.stonkfun.xyz/api/public/v1 (OpenAPI at /openapi.json).
// No API key. Reads are rate-limited to 300 calls/min per IP; a 429 carries
// Retry-After. Errors come back as `{ error: { code, message } }`.
//
// Every StonkFun coin is priced against a quote asset (xStocks, Backpack
// pre-stocks, currencies, custom mints). Two launch modes:
//   standard — creator earns a share of every trade (claimable via /fees)
//   reward   — a Token-2022 transfer tax (100 or 300 bps) is paid to holders
//              in the quote token; no creator fee. ("V3" reward tokens carry
//              `transferFee.bps`; the earliest reward launches — early Aug 2026 —
//              were classic SPL mints with a fee-share mechanism instead.)

export const STONKFUN_BASE_URL = 'https://www.stonkfun.xyz/api/public/v1';

/** Per-request ceiling. The full rewards ledger (~1.4MB) takes ~9s upstream. */
const DEFAULT_TIMEOUT_MS = 15_000;
const LEDGER_TIMEOUT_MS = 40_000;
const MAX_RETRY_AFTER_MS = 5_000;

export type StonkMode = 'standard' | 'reward';
export type StonkLaunchpad = 'raydium' | 'launchlab' | 'pump' | string;

export interface StonkPair {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  logoUrl?: string;
  category: string;
  categoryLabel: string;
  tokenProgram: string;
  /** StonkFun's own rule (retired categories/mints are false). */
  launchable: boolean;
  symbolAmbiguous?: boolean;
  /** Raydium has created the on-chain GlobalConfig a LaunchLab launch needs. Absent = unknown. */
  launchLabReady?: boolean;
}

export interface StonkQuoteRef {
  mint: string;
  symbol: string;
  name?: string;
  logoUrl?: string;
  category?: string;
  categoryLabel?: string;
  decimals?: number;
}

export interface StonkMarket {
  priceUsd: number;
  marketCapUsd: number;
  fdvUsd?: number;
  volume24hUsd: number;
  priceChange24h?: number;
  peakMarketCapUsd?: number;
}

export interface StonkToken {
  mint: string;
  pool: string;
  name: string;
  symbol: string;
  quote: StonkQuoteRef;
  launchpad: StonkLaunchpad;
  mode: StonkMode;
  quoteOnlyFees?: boolean;
  /** Present on V3 reward tokens only. */
  transferFee?: { bps: number } | null;
  /** Present while the token sits in the buyback rankings. */
  flywheel?: { active: boolean } | null;
  imageUrl?: string;
  metadataUri?: string;
  market: StonkMarket;
  status: 'graduated' | 'aboutToGraduate' | 'active' | string;
  graduationProgress?: number;
  graduatedAt?: string | null;
  createdAt: string;
}

export interface StonkLaunch {
  mint: string;
  pool: string;
  name: string;
  symbol: string;
  creator: string;
  quote: { mint: string; symbol: string };
  launchpad: StonkLaunchpad;
  mode: StonkMode;
  transferFee?: { bps: number } | null;
  logoUrl?: string;
  startMarketCapUsd?: number;
  targetMarketCapUsd?: number;
  createdAt: string;
}

export interface StonkRewardTotals {
  distributedRaw: string;
  distributedTokens: number;
  undistributedRaw?: string;
  undistributedTokens?: number;
  payoutCount: number;
  holderCount: number;
  lastPayoutAt: string | null;
}

export interface StonkTokenRewards {
  mint: string;
  mode: StonkMode;
  quote: { mint: string; symbol: string; decimals: number };
  /** Null for standard-mode launches. */
  rewards: StonkRewardTotals | null;
}

export interface StonkRewardsLedgerEntry {
  mint: string;
  quote: { mint: string; symbol: string; decimals: number };
  distributedRaw: string;
  distributedTokens: number;
  payoutCount: number;
  holderCount: number;
  lastPayoutAt: string | null;
}

export interface StonkLaunchLabPricing {
  quote: { mint: string; symbol: string; decimals: number; tokenProgram: string };
  raise: { raw: string; units: number; minimumRaw: string; basis: string };
  marketCap: {
    startUsd: number;
    graduationUsd: number;
    startQuote: number;
    graduationQuote: number;
    graduationMultiple: number;
  };
  prices: { solUsd: number; quoteUsd: number; observedAt: string };
  curve: {
    programId: string;
    configId: string;
    curveType: 'ConstantCurve' | 'FixedCurve' | 'LinearCurve' | string;
    migrateType: 'cpmm' | 'amm' | string;
    baseDecimals: number;
    supply: string;
    totalSellA: string;
    totalSupplyTokens: number;
    vesting: { totalLockedAmount: string; cliffPeriod: string; unlockPeriod: string };
    cpmmCreatorFeeOn: number;
    migrateFeeRaw: string;
    derived?: { virtualA: string; virtualB: string };
  };
  platform: { standard: string; reward: string };
  curveRule: { standard: string; reward: string; derivation?: string; note?: string };
  modes: {
    standard: { transferFee: null; note?: string };
    reward: {
      transferFeeBps: number[];
      baseTokenProgram: string;
      withdrawWithheldAuthority: string;
      note?: string;
    };
  };
}

export interface StonkStats {
  network: string;
  tokens: {
    poolsAvailable: boolean;
    total: number;
    graduated: number;
    aboutToGraduate: number;
    rewardLaunches: number;
    totalMarketCapUsd: number;
    totalVolume24hUsd: number;
  };
  revenue?: { totalRevenueUsd: number; totalBuybackUsd: number };
  burns?: { totalValueUsdAtBurn: number; burnCount: number };
  config: Record<string, number | boolean>;
}

export interface StonkTokensPage {
  tokens: StonkToken[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
}

export interface StonkTokensQuery {
  q?: string;
  sort?: string;
  mode?: StonkMode;
  status?: string;
  quoteMint?: string;
  category?: string;
  page?: number;
  /** Upstream caps this at 100 (measured 2026-09-06: pageSize=500 → 100). */
  pageSize?: number;
}

export class StonkFunError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, code: string, message: string) {
    super(`stonkfun ${status} ${code}: ${message}`);
    this.name = 'StonkFunError';
    this.code = code;
    this.status = status;
  }
}

type Envelope<T> = { data: T; meta?: { generatedAt?: string } };

export class StonkFunClient {
  private cache: Cache;
  private baseUrl: string;

  constructor(cache: Cache, baseUrl: string = STONKFUN_BASE_URL) {
    this.cache = cache;
    this.baseUrl = baseUrl;
  }

  // --- reads ---------------------------------------------------------------

  /** Quote assets a launch can be paired against. Cached 5 minutes. */
  async getPairs(): Promise<StonkPair[]> {
    const cacheKey = 'stonk:pairs';
    const cached = await this.cache.get<StonkPair[]>(cacheKey);
    if (cached) return cached;
    const data = await this.request<{ pairs: StonkPair[] }>('/pairs');
    const pairs = Array.isArray(data.pairs) ? data.pairs : [];
    await this.cache.set(cacheKey, pairs, CACHE_TTL.stonkPairs);
    return pairs;
  }

  /** One page of tokens. Not cached — the index ingests these in bulk. */
  async getTokens(query: StonkTokensQuery = {}): Promise<StonkTokensPage> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
    }
    const qs = params.toString();
    const data = await this.request<StonkTokensPage>(`/tokens${qs ? `?${qs}` : ''}`);
    return {
      tokens: Array.isArray(data.tokens) ? data.tokens : [],
      pagination: data.pagination ?? { page: query.page ?? 1, pageSize: data.tokens?.length ?? 0, total: data.tokens?.length ?? 0, totalPages: 1 },
    };
  }

  /** One token with its launch record. Null when StonkFun does not know the mint. */
  async getToken(mint: string): Promise<{ token: StonkToken; launch: StonkLaunch | null } | null> {
    const cacheKey = `stonk:token:${mint}`;
    const cached = await this.cache.get<{ token: StonkToken; launch: StonkLaunch | null } | { missing: true }>(cacheKey);
    if (cached) return 'missing' in cached ? null : cached;
    try {
      const data = await this.request<{ token: StonkToken; launch?: StonkLaunch | null }>(`/tokens/${mint}`);
      const result = { token: data.token, launch: data.launch ?? null };
      await this.cache.set(cacheKey, result, CACHE_TTL.stonkToken);
      return result;
    } catch (err) {
      if (err instanceof StonkFunError && err.status === 404) {
        await this.cache.set(cacheKey, { missing: true }, CACHE_TTL.stonkToken);
        return null;
      }
      throw err;
    }
  }

  /** Distribution totals for a reward coin. Null when the mint is unknown. */
  async getTokenRewards(mint: string): Promise<StonkTokenRewards | null> {
    const cacheKey = `stonk:token-rewards:${mint}`;
    const cached = await this.cache.get<StonkTokenRewards | { missing: true }>(cacheKey);
    if (cached) return 'missing' in cached ? null : cached;
    try {
      const data = await this.request<StonkTokenRewards>(`/tokens/${mint}/rewards`);
      await this.cache.set(cacheKey, data, CACHE_TTL.stonkToken);
      return data;
    } catch (err) {
      if (err instanceof StonkFunError && err.status === 404) {
        await this.cache.set(cacheKey, { missing: true }, CACHE_TTL.stonkToken);
        return null;
      }
      throw err;
    }
  }

  /** Lifetime payout totals for every reward coin (one ~1.4MB call). Not cached. */
  async getRewardsLedger(limit = 10_000): Promise<StonkRewardsLedgerEntry[]> {
    const data = await this.request<{ launches: StonkRewardsLedgerEntry[] }>(`/rewards?limit=${limit}`, LEDGER_TIMEOUT_MS);
    return Array.isArray(data.launches) ? data.launches : [];
  }

  /** Exact curve constants for a self-built LaunchLab launch against this quote. Cached 1 minute. */
  async getLaunchLabPricing(quoteMint: string): Promise<StonkLaunchLabPricing> {
    const cacheKey = `stonk:launchlab-pricing:${quoteMint}`;
    const cached = await this.cache.get<StonkLaunchLabPricing>(cacheKey);
    if (cached) return cached;
    const data = await this.request<StonkLaunchLabPricing>(`/launchlab/pricing?quoteMint=${encodeURIComponent(quoteMint)}`);
    await this.cache.set(cacheKey, data, CACHE_TTL.stonkPricing);
    return data;
  }

  /** Platform totals + config switches. Cached 5 minutes. */
  async getStats(): Promise<StonkStats> {
    const cacheKey = 'stonk:stats';
    const cached = await this.cache.get<StonkStats>(cacheKey);
    if (cached) return cached;
    const data = await this.request<StonkStats>('/stats');
    await this.cache.set(cacheKey, data, CACHE_TTL.stonkPairs);
    return data;
  }

  // --- transport -----------------------------------------------------------

  private async request<T>(path: string, timeoutMs = DEFAULT_TIMEOUT_MS, attempt = 0): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        headers: { Accept: 'application/json', 'User-Agent': 'SolEnrich/1.0 (+https://www.solenrich.com)' },
        signal: controller.signal,
      });

      if (res.status === 429 && attempt === 0) {
        const retryAfter = Number(res.headers.get('retry-after') ?? '1');
        await drain(res);
        const waitMs = Math.min(Math.max(retryAfter, 0.5) * 1000, MAX_RETRY_AFTER_MS);
        await new Promise((r) => setTimeout(r, waitMs));
        clearTimeout(timer);
        return this.request<T>(path, timeoutMs, 1);
      }

      if (!res.ok) {
        let code = 'http_error';
        let message = `HTTP ${res.status}`;
        try {
          const body = (await res.json()) as { error?: { code?: string; message?: string } };
          if (body?.error) {
            code = body.error.code ?? code;
            message = body.error.message ?? message;
          }
        } catch {
          await drain(res);
        }
        throw new StonkFunError(res.status, code, message);
      }

      const body = (await res.json()) as Envelope<T>;
      if (!body || typeof body !== 'object' || !('data' in body)) {
        throw new StonkFunError(res.status, 'bad_envelope', `unexpected response shape for ${path}`);
      }
      return body.data;
    } finally {
      clearTimeout(timer);
    }
  }
}
