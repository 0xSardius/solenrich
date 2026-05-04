import type { Cache } from '../cache';
import type { TrendingSignalsAnalyzer, TrendingSignalsResult } from './trending-signals';
import { CACHE_TTL } from '../config';
import { formatTimestamp } from '../utils/normalize';

const FEED_LATEST_CACHE_KEY = 'feed:latest:v1';

export interface FeedLatestResult {
  /** Source of this brief — useful for agents auditing freshness */
  source: 'cached' | 'fresh';
  /** When the cached brief was produced (ISO 8601). Null if no brief yet. */
  generated_at: string;
  /** True when the caller's `since` is newer than `generated_at` — payload is empty. */
  unchanged: boolean;
  /** The daily intelligence brief itself. Same shape as `trending-signals`
   *  output. Null when `unchanged: true`. */
  brief: TrendingSignalsResult | null;
  last_updated: string;
}

/**
 * Lazy-populated daily intelligence feed. The first caller after cache expiry
 * runs `trending-signals` inline (~5-15s) and writes the result to Redis with
 * a 24h TTL. Subsequent callers within 24h hit cache (~50ms).
 *
 * V1 design choice: no Railway scheduled job. Daily cadence is achieved by
 * the 24h TTL alone — first poll after expiry triggers the refresh. V2 will
 * add a real cron once polling volume justifies the predictability tradeoff.
 *
 * The `since` param lets agents avoid paying for stale repeats. If their
 * last-poll timestamp is newer than the cached `generated_at`, the response
 * sets `unchanged: true` and omits the payload — agent can short-circuit.
 */
export class FeedStore {
  // Default brief parameters — chosen to match what `trending-signals` emits
  // for "good signal density" (matches the threshold tune that activated
  // smart-money derivation in production).
  private static readonly DEFAULT_LIMIT = 10;
  private static readonly DEFAULT_MIN_LIQUIDITY = 15_000;
  private static readonly DEFAULT_MAX_RISK_SCORE = 0.7;
  private static readonly DEFAULT_INCLUDE_WHALE_WATCH = true;

  constructor(
    private trending: TrendingSignalsAnalyzer,
    private cache: Cache,
  ) {}

  async getLatest(since?: string): Promise<FeedLatestResult> {
    const cached = await this.cache.get<TrendingSignalsResult>(FEED_LATEST_CACHE_KEY);

    if (cached) {
      // Cache hit — check `since` to allow short-circuit
      if (since && cached.last_updated && new Date(cached.last_updated) <= new Date(since)) {
        return {
          source: 'cached',
          generated_at: cached.last_updated,
          unchanged: true,
          brief: null,
          last_updated: formatTimestamp(),
        };
      }
      return {
        source: 'cached',
        generated_at: cached.last_updated,
        unchanged: false,
        brief: cached,
        last_updated: formatTimestamp(),
      };
    }

    // Cache miss — generate a fresh brief inline. First caller after expiry
    // pays the ~5-15s latency; subsequent callers within 24h get instant.
    const fresh = await this.trending.enrich(
      FeedStore.DEFAULT_MIN_LIQUIDITY,
      FeedStore.DEFAULT_MAX_RISK_SCORE,
      FeedStore.DEFAULT_LIMIT,
      FeedStore.DEFAULT_INCLUDE_WHALE_WATCH,
    );
    await this.cache.set(FEED_LATEST_CACHE_KEY, fresh, CACHE_TTL.feedLatest);

    return {
      source: 'fresh',
      generated_at: fresh.last_updated,
      unchanged: false,
      brief: fresh,
      last_updated: formatTimestamp(),
    };
  }
}
