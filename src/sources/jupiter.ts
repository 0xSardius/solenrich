import { CONFIG, CACHE_TTL } from '../config';
import type { Cache } from '../cache';
import { drain } from '../utils/drain';
import { upstreamStats } from '../utils/upstream-stats';
import { SlidingLimiter, type Priority } from '../utils/sliding-limiter';

// --- Types ---

export interface JupiterToken {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  tags: string[];
  logoURI?: string;
  verified?: boolean;
  /** Holders, from Jupiter's token API (2026-10-08). Null when Jupiter does not report it. */
  holderCount?: number | null;
  /** USD price, liquidity and market cap from the token API. Null when absent. Jupiter reports these for
   *  pump.fun bonding-curve tokens too, which DexScreener does not (no `liquidity` on dexId "pumpfun"). */
  usdPrice?: number | null;
  liquidity?: number | null;
  mcap?: number | null;
  /** Launchpad name, e.g. "pump.fun". */
  launchpad?: string | null;
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

/**
 * One limiter for every keyed Jupiter call in the process (all JupiterClient instances), per ACCOUNT budget.
 * Measured 2026-11-15 on the Free plan: response headers report a limit of 10 (x-ratelimit-current /
 * -remaining); 10 simultaneous requests pass, 15 at 1/s pass, at 2/s the 11th fails — so it is ~10 requests per
 * ~10 s, NOT a burstable 60 per 60 s. We use the full 10 per 10 s with no reserve (tuned 2026-11-17): two full
 * token calls (1 lookup + 4 quotes each) need all 10 slots, and any reserve cut price-impact sizes at 1 call per
 * 6 s (measured: reserve 2 → every second call got 2 of 4 sizes). Priority works through waiting instead: when
 * the window is full, slippage quotes ('low') are skipped after 2 s; token lookups and single quotes ('high') wait
 * up to 8 s for the next slot. No spare slot: a canary probe or local run can cause an occasional 429, which the
 * client retries once.
 * On a paid plan (Developer = 10 RPS) re-measure the headers and raise these together.
 */
export const JUPITER_WINDOW_MS = 10_000;
export const JUPITER_BUDGET_PER_WINDOW = 10;
export const JUPITER_LOW_RESERVE = 0;
const LOW_MAX_WAIT_MS = 2_000;
// Core calls wait for a slot rather than go out into a known-full window (that always returns 429). 8 s stays
// inside token-analyzer's 15 s task timeout; getQuote's own 4 s abort still bounds single quotes.
const HIGH_MAX_WAIT_MS = 8_000;
export const jupiterLimiter = new SlidingLimiter({ windowMs: JUPITER_WINDOW_MS, capacity: JUPITER_BUDGET_PER_WINDOW, lowReserve: JUPITER_LOW_RESERVE });
/** Keyless price host (lite-api.jup.ag): its own bucket, measured at 5 requests per ~10 s. */
export const PRICE_WINDOW_MS = 10_000;
export const PRICE_BUDGET_PER_WINDOW = 5;
const PRICE_LOW_MAX_WAIT_MS = 30_000;
export const priceLimiter = new SlidingLimiter({ windowMs: PRICE_WINDOW_MS, capacity: PRICE_BUDGET_PER_WINDOW, lowReserve: 0 });
/** Lookups arriving within this window share one request (see JupiterClient.coalescedPrices). */
const PRICE_COALESCE_MS = 25;
const priceQueue: Array<{ mints: string[]; resolve: (r: Record<string, JupiterPrice>) => void; reject: (e: unknown) => void }> = [];
let priceTimer: ReturnType<typeof setTimeout> | null = null;

export class JupiterSlotSkipped extends Error {
  constructor() { super('Jupiter request skipped: Free-plan budget in use'); }
}

/** Slippage cache: 5 min by default; token-analyzer asks for 2 min on tokens younger than 24h. */
export const SLIPPAGE_MAX_AGE_S = 300;
export const SLIPPAGE_MAX_AGE_FRESH_S = 120;

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

    const fetched = await this.coalescedPrices(misses);
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
  async getPriceUncached(mints: string[], priority: Priority = 'low'): Promise<Record<string, JupiterPrice>> {
    return this.fetchPrices(mints, priority);
  }

  /**
   * Coalesce price lookups that arrive within PRICE_COALESCE_MS into one request of up to 50 mints (process-wide).
   * Measured 2026-11-17: 12 simultaneous single-mint lookups = 12 requests against a 5-per-10 s host → 7 failed.
   * Coalesced they cost 1 request. Each caller gets back only the mints it asked for.
   */
  private coalescedPrices(mints: string[]): Promise<Record<string, JupiterPrice>> {
    return new Promise((resolve, reject) => {
      priceQueue.push({ mints, resolve, reject });
      if (!priceTimer) priceTimer = setTimeout(() => { void this.flushPriceQueue(); }, PRICE_COALESCE_MS);
    });
  }

  private async flushPriceQueue(): Promise<void> {
    const waiters = priceQueue.splice(0);
    priceTimer = null;
    const all = [...new Set(waiters.flatMap((w) => w.mints))];
    const merged: Record<string, JupiterPrice> = {};
    let error: unknown = null;
    for (let i = 0; i < all.length; i += 50) {
      try {
        Object.assign(merged, await this.fetchPrices(all.slice(i, i + 50)));
      } catch (e) { error = e; }
    }
    for (const w of waiters) {
      const mine: Record<string, JupiterPrice> = {};
      for (const m of w.mints) if (merged[m]) mine[m] = merged[m];
      // A failed batch fails only the callers that got nothing back, as before.
      if (Object.keys(mine).length === 0 && error) w.reject(error); else w.resolve(mine);
    }
  }

  /**
   * Keyless price lookups. lite-api.jup.ag has its OWN limit, separate from the keyed account budget — measured
   * 2026-11-17: 5 requests per ~10 s (x-ratelimit headers), and 38% of prod price requests that day got 429
   * because callers sent bursts. All price calls go through priceLimiter: user-facing lookups ('high') wait up
   * to 8 s; background refreshes (the StonkFun index, 'low') wait up to 30 s. One retry on 429.
   */
  private async fetchPrices(mints: string[], priority: Priority = 'high'): Promise<Record<string, JupiterPrice>> {
    if (mints.length === 0) return {};
    const url = `https://lite-api.jup.ag/price/v3?ids=${mints.join(',')}`;
    const wait = priority === 'low' ? PRICE_LOW_MAX_WAIT_MS : HIGH_MAX_WAIT_MS;
    const take = async () => {
      const r = await priceLimiter.acquire('high', wait); // one class inside the bucket; priority sets the wait only
      if (r === 'waited' || r === 'forced') upstreamStats.inc('limiter_waited');
    };
    await take();
    upstreamStats.inc('jupiter_price_requests');
    let res = await fetch(url);
    if (res.status === 429) {
      upstreamStats.inc('jupiter_price_429'); // lite-api is being phased out with falling limits
      await drain(res);
      await new Promise((r) => setTimeout(r, 1_000));
      await take();
      upstreamStats.inc('jupiter_price_requests');
      res = await fetch(url);
      if (res.status === 429) upstreamStats.inc('jupiter_price_429_after_retry');
    }
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

    // Tokens API v2 (2026-10-08): the old tokens.jup.ag/token/{mint} host stopped answering, so every lookup failed
    // silently — no verified flag (every token got the 'unverified' risk flag) and no metadata. v2 search by mint
    // returns an array; take the exact id match. It also carries holderCount (BONK: 1,025,727).
    const res = await this.fetchWithKey(`https://api.jup.ag/tokens/v2/search?query=${encodeURIComponent(mint)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Jupiter Token HTTP ${res.status}: ${await res.text()}`);

    const list: any = await res.json();
    const raw = Array.isArray(list) ? list.find((t: any) => t?.id === mint) : null;
    if (!raw) return null;
    const token: JupiterToken = {
      address: raw.id ?? mint,
      name: raw.name ?? '',
      symbol: raw.symbol ?? '',
      decimals: raw.decimals ?? 0,
      tags: Array.isArray(raw.tags) ? raw.tags : [],
      logoURI: raw.icon,
      verified: raw.isVerified === true,
      holderCount: typeof raw.holderCount === 'number' ? raw.holderCount : null,
      usdPrice: typeof raw.usdPrice === 'number' && raw.usdPrice > 0 ? raw.usdPrice : null,
      liquidity: typeof raw.liquidity === 'number' && raw.liquidity >= 0 ? raw.liquidity : null,
      mcap: typeof raw.mcap === 'number' && raw.mcap > 0 ? raw.mcap : null,
      launchpad: typeof raw.launchpad === 'string' ? raw.launchpad : null,
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
  async getSlippageEstimates(mint: string, maxAgeSeconds = SLIPPAGE_MAX_AGE_S): Promise<SlippageEstimate[]> {
    return (await this.getSlippage(mint, maxAgeSeconds)).estimates;
  }

  /**
   * Slippage estimates plus their age. One cached entry (5 min TTL) serves every caller; `maxAgeSeconds` lets a
   * caller demand fresher data (fresh tokens move fast: token-analyzer asks for 2 min on tokens < 24h old).
   * The 4 quotes cost 4 of the Free plan's 60 requests/minute, so reuse matters (2026-11-15).
   */
  async getSlippage(mint: string, maxAgeSeconds = SLIPPAGE_MAX_AGE_S): Promise<{ estimates: SlippageEstimate[]; age_s: number | null }> {
    const cacheKey = `jupiter:slippage:v2:${mint}`;
    const cached = await this.cache.get<{ estimates: SlippageEstimate[]; fetched_at: number }>(cacheKey);
    if (cached && Array.isArray(cached.estimates)) {
      const age = Math.max(0, Math.round((Date.now() - cached.fetched_at) / 1000));
      if (age <= maxAgeSeconds) return { estimates: cached.estimates, age_s: age };
    }
    const estimates = await this.fetchSlippage(mint);
    if (estimates.length > 0) {
      await this.cache.set(cacheKey, { estimates, fetched_at: Date.now() }, SLIPPAGE_MAX_AGE_S);
      return { estimates, age_s: 0 };
    }
    return { estimates, age_s: null };
  }

  private async fetchSlippage(mint: string): Promise<SlippageEstimate[]> {
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
          // Low priority: slippage quotes yield to token lookups and single quotes, and are skipped (not sent)
          // when no slot frees within 2 s. A skipped size is simply absent; all skipped = jupiter_quote unavailable.
          const res = await this.fetchWithKey(url, controller.signal, 'low');
          if (!res.ok) { await drain(res); return null; }
          const quote: any = await res.json();
          // Jupiter's priceImpactPct is a FRACTION despite its name (0.909 = 90.9%): verified 2026-11-14 — a $100K
          // buy of a $34K-mcap token returned 0.909 and an output worth ~$9.7K. We report a percent.
          const priceImpact = parseFloat(quote.priceImpactPct);
          if (!Number.isFinite(priceImpact)) return null;
          const outAmount = Number(quote.outAmount ?? 0);
          return {
            size_usd: size.usd,
            price_impact_pct: Math.round(priceImpact * 100 * 10000) / 10000,
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

    return results;
  }

  /**
   * One Jupiter Quote v1 swap quote. `amount` is in raw base units of inputMint.
   * Returns the raw output amount, or null when Jupiter has no route or did not answer.
   * Cached for the price TTL: a quote at the same size is reused across calls.
   */
  async getQuote(inputMint: string, outputMint: string, amount: number): Promise<{ outAmount: number } | null> {
    const raw = Math.floor(amount);
    if (raw <= 0) return null;
    const cacheKey = `jupiter:quote:${inputMint}:${outputMint}:${raw}`;
    const cached = await this.cache.get<{ outAmount: number }>(cacheKey);
    if (cached) return cached;
    try {
      const url = `${this.baseUrl}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${raw}&slippageBps=50`;
      const res = await this.fetchWithKey(url, AbortSignal.timeout(4_000));
      if (!res.ok) { await drain(res); return null; }
      const quote: any = await res.json();
      const outAmount = Number(quote.outAmount ?? 0);
      if (!(outAmount > 0)) return null;
      const result = { outAmount };
      await this.cache.set(cacheKey, result, CACHE_TTL.jupiterPrice);
      return result;
    } catch {
      return null;
    }
  }

  /** One retry on 429 after a short wait. Under load Jupiter rate-limits bursts; before this, a 429 silently
   *  turned into "unverified", no holder count and no slippage (seen in prod 2026-11-14 on BONK). */
  private async fetchWithKey(url: string, signal?: AbortSignal, priority: Priority = 'high'): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (this.apiKey) headers['x-api-key'] = this.apiKey;
    const kind = url.includes('/tokens/') ? 'token' : 'quote';
    await this.takeSlot(priority);
    upstreamStats.inc(`jupiter_${kind}_requests`);
    const res = await fetch(url, { headers, signal });
    if (res.status !== 429 || signal?.aborted) return res;
    upstreamStats.inc(`jupiter_${kind}_429`);
    await drain(res);
    await new Promise((r) => setTimeout(r, 700));
    await this.takeSlot(priority);
    upstreamStats.inc(`jupiter_${kind}_requests`);
    const retry = await fetch(url, { headers, signal });
    if (retry.status === 429) upstreamStats.inc(`jupiter_${kind}_429_after_retry`);
    return retry;
  }

  /** Wait for a slot in the shared Free-plan budget. Throws JupiterSlotSkipped for a skipped low-priority call. */
  private async takeSlot(priority: Priority): Promise<void> {
    const r = await jupiterLimiter.acquire(priority, priority === 'low' ? LOW_MAX_WAIT_MS : HIGH_MAX_WAIT_MS);
    if (r === 'waited' || r === 'forced') upstreamStats.inc('limiter_waited');
    if (r === 'skip') { upstreamStats.inc('limiter_skipped'); throw new JupiterSlotSkipped(); }
  }
}
