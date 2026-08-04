import type { Cache } from '../cache';
import type { DexScreenerClient, DexPair } from '../sources/dexscreener';

export type SignalEntityType = 'token' | 'wallet';
export type SignalWindow = '1h' | '6h' | '24h';

export interface EntitySignal {
  address: string;
  queries: number;
  rank: number;          // 1 = most queried
  percentile: number;    // 0-100 (higher = more attention)
  rising: boolean;       // queries higher than prior window of equal size
  prior_window_queries: number;
  change_pct: number | null;
}

export interface TopEntityRow {
  address: string;
  queries: number;
  rising: boolean;
}

export interface ConsensusSignalResult {
  type: SignalEntityType;
  window: SignalWindow;
  window_start: string;
  window_end: string;
  entity: EntitySignal | null;
  top_n: TopEntityRow[];
  aggregate: {
    total_unique_entities: number;
    total_queries: number;
  };
  generated_at: string;
}

export type AttentionDirection = 'accelerating' | 'rising' | 'cooling' | 'flat';
export type Divergence =
  | 'early_signal'        // attention up, price hasn't moved yet
  | 'confirmed_momentum'  // attention up AND price up
  | 'distribution_risk'   // attention cooling while price pumps
  | 'fading'              // attention and price both cooling
  | 'neutral';

export interface MomentumEntry {
  address: string;
  symbol: string | null;
  name: string | null;
  /** Query counts over three consecutive windows, oldest → newest. */
  queries: { prior2: number; prior: number; current: number };
  /** current - prior: is attention growing at all? */
  velocity: number;
  /** (current - prior) - (prior - prior2): is attention growth speeding up? */
  acceleration: number;
  attention: AttentionDirection;
  price_usd: number | null;
  /** DexScreener price change over the SAME window (h1/h6/h24). Null if untradable/unknown. */
  price_change_pct: number | null;
  liquidity_usd: number | null;
  divergence: Divergence | null;
}

export interface AttentionMomentumResult {
  window: SignalWindow;
  window_start: string;
  window_end: string;
  entries: MomentumEntry[];
  aggregate: {
    total_unique_tokens: number;
    total_queries_current_window: number;
    sample_quality: 'low' | 'moderate' | 'ok';
  };
  note: string;
  generated_at: string;
}

const WINDOW_HOURS: Record<SignalWindow, number> = {
  '1h': 1,
  '6h': 6,
  '24h': 24,
};

/** Price move (in %) below which we call price "flat" for divergence classification. */
const PRICE_FLAT_THRESHOLD_PCT = 3;

/** YYYY-MM-DDTHH for a given Date */
function hourKey(d: Date): string {
  return d.toISOString().slice(0, 13);
}

/** List of hour keys covering the N hours ending at `endHour` (inclusive). */
function hourKeysBack(endHour: Date, hours: number): string[] {
  const keys: string[] = [];
  for (let i = 0; i < hours; i++) {
    const d = new Date(endHour.getTime() - i * 3_600_000);
    keys.push(hourKey(d));
  }
  return keys;
}

/**
 * Reads existing per-entity hourly counters and derives consensus signal.
 *
 * No new state — everything derives from counters the request middleware
 * is already writing on every paid call.
 */
export class SignalTracker {
  constructor(
    private cache: Cache,
    /** Optional — only needed for getMomentum's price overlay. */
    private dexscreener?: DexScreenerClient,
  ) {}

  async getSignal(
    type: SignalEntityType,
    address: string | undefined,
    window: SignalWindow,
    limit = 10,
  ): Promise<ConsensusSignalResult> {
    const now = new Date();
    const hours = WINDOW_HOURS[window];
    const windowStart = new Date(now.getTime() - hours * 3_600_000);
    const priorWindowStart = new Date(windowStart.getTime() - hours * 3_600_000);

    const currentKeys = hourKeysBack(now, hours);
    const priorKeys = hourKeysBack(windowStart, hours);

    // Scan all entity keys for current window. We use the first hour-key as
    // a probe pattern, then aggregate across the full window per entity.
    const totalsByAddress = await this.aggregateByAddress(type, currentKeys);
    const priorTotalsByAddress = await this.aggregateByAddress(type, priorKeys);

    // Sort and rank
    const ranked = Array.from(totalsByAddress.entries())
      .map(([addr, queries]) => ({ address: addr, queries }))
      .sort((a, b) => b.queries - a.queries);

    const totalUnique = ranked.length;
    const totalQueries = ranked.reduce((sum, r) => sum + r.queries, 0);

    let entity: EntitySignal | null = null;
    if (address) {
      const idx = ranked.findIndex((r) => r.address === address);
      const queries = totalsByAddress.get(address) ?? 0;
      const prior = priorTotalsByAddress.get(address) ?? 0;
      const rank = idx === -1 ? totalUnique + 1 : idx + 1;
      const percentile =
        totalUnique > 0
          ? Math.round(((totalUnique - rank + 1) / totalUnique) * 100)
          : 0;
      const changePct =
        prior > 0 ? ((queries - prior) / prior) * 100 : queries > 0 ? null : 0;
      entity = {
        address,
        queries,
        rank,
        percentile,
        rising: queries > prior,
        prior_window_queries: prior,
        change_pct: changePct,
      };
    }

    const topN: TopEntityRow[] = ranked.slice(0, limit).map((r) => ({
      address: r.address,
      queries: r.queries,
      rising: r.queries > (priorTotalsByAddress.get(r.address) ?? 0),
    }));

    return {
      type,
      window,
      window_start: windowStart.toISOString(),
      window_end: now.toISOString(),
      entity,
      top_n: topN,
      aggregate: {
        total_unique_entities: totalUnique,
        total_queries: totalQueries,
      },
      generated_at: now.toISOString(),
    };
  }

  /**
   * Attention momentum — tokens ranked by *acceleration* of agent attention
   * (change in query velocity across three consecutive windows), overlaid with
   * price change over the same window. The divergence field is the point:
   * attention accelerating while price is flat = agents researching before the
   * market moves; attention cooling while price pumps = distribution risk.
   *
   * Tokens only — the price overlay is what makes the signal actionable, and
   * wallets have no price. Needs 3×window of hourly buckets (HOURLY_TTL must
   * cover it — 96h retains 3×24h with margin).
   */
  async getMomentum(window: SignalWindow, limit = 10): Promise<AttentionMomentumResult> {
    const now = new Date();
    const hours = WINDOW_HOURS[window];
    const windowMs = hours * 3_600_000;
    const windowStart = new Date(now.getTime() - windowMs);

    // Three consecutive, non-overlapping windows: w0 = current, w1, w2 oldest.
    const [w0, w1, w2] = await Promise.all([
      this.aggregateByAddress('token', hourKeysBack(now, hours)),
      this.aggregateByAddress('token', hourKeysBack(windowStart, hours)),
      this.aggregateByAddress('token', hourKeysBack(new Date(now.getTime() - 2 * windowMs), hours)),
    ]);

    // Universe = anything seen in any of the three windows, so cooling tokens
    // (current=0 but prior>0) still surface for distribution-risk detection.
    const universe = new Set<string>([...w0.keys(), ...w1.keys(), ...w2.keys()]);

    const scored = Array.from(universe).map((address) => {
      const current = w0.get(address) ?? 0;
      const prior = w1.get(address) ?? 0;
      const prior2 = w2.get(address) ?? 0;
      const velocity = current - prior;
      const acceleration = velocity - (prior - prior2);
      const attention: AttentionDirection =
        velocity > 0 ? (acceleration > 0 ? 'accelerating' : 'rising')
        : velocity < 0 ? 'cooling'
        : 'flat';
      return { address, queries: { prior2, prior, current }, velocity, acceleration, attention };
    });

    scored.sort(
      (a, b) =>
        b.acceleration - a.acceleration ||
        b.velocity - a.velocity ||
        b.queries.current - a.queries.current,
    );
    const top = scored.slice(0, limit);

    // Price overlay — one DexScreener batch call for the ranked mints. Some
    // "token" addresses in the stream aren't tradable mints; those get nulls.
    const pairsByMint = new Map<string, DexPair>();
    if (this.dexscreener && top.length > 0) {
      try {
        const pairs = await this.dexscreener.getPairsBatch(top.map((t) => t.address));
        for (const p of pairs) {
          const mint = p.baseToken?.address;
          if (!mint) continue;
          const existing = pairsByMint.get(mint);
          if (!existing || (p.liquidity?.usd ?? 0) > (existing.liquidity?.usd ?? 0)) {
            pairsByMint.set(mint, p);
          }
        }
      } catch (err) {
        console.warn(`[signal-tracker] price overlay failed: ${err}`);
      }
    }

    const priceField = window === '1h' ? 'h1' : window === '6h' ? 'h6' : 'h24';
    const entries: MomentumEntry[] = top.map((t) => {
      const pair = pairsByMint.get(t.address);
      const priceChange = pair?.priceChange?.[priceField] ?? null;

      let divergence: Divergence | null = null;
      if (priceChange !== null) {
        const priceUp = priceChange > PRICE_FLAT_THRESHOLD_PCT;
        const attentionUp = t.attention === 'accelerating' || t.attention === 'rising';
        divergence =
          attentionUp && !priceUp ? 'early_signal'
          : attentionUp && priceUp ? 'confirmed_momentum'
          : t.attention === 'cooling' && priceUp ? 'distribution_risk'
          : t.attention === 'cooling' ? 'fading'
          : 'neutral';
      }

      return {
        address: t.address,
        symbol: pair?.baseToken?.symbol ?? null,
        name: pair?.baseToken?.name ?? null,
        queries: t.queries,
        velocity: t.velocity,
        acceleration: t.acceleration,
        attention: t.attention,
        price_usd: pair ? parseFloat(pair.priceUsd) || null : null,
        price_change_pct: priceChange,
        liquidity_usd: pair?.liquidity?.usd ?? null,
        divergence,
      };
    });

    const totalQueries = Array.from(w0.values()).reduce((s, n) => s + n, 0);
    const sampleQuality = totalQueries < 10 ? 'low' : totalQueries < 50 ? 'moderate' : 'ok';

    return {
      window,
      window_start: windowStart.toISOString(),
      window_end: now.toISOString(),
      entries,
      aggregate: {
        total_unique_tokens: universe.size,
        total_queries_current_window: totalQueries,
        sample_quality: sampleQuality,
      },
      note:
        'Derived from SolEnrich\'s own agent query stream — attention measured before it shows up in market volume. ' +
        'Signal density scales with platform traffic; treat low sample_quality as directional, not statistical.',
      generated_at: now.toISOString(),
    };
  }

  /**
   * Scan keys for the first hour-bucket to discover all entities seen in window,
   * then fetch counts for each entity across all hour-buckets in parallel.
   *
   * Cost: 1 SCAN per hour + N MGET-style reads. For typical traffic (<1000
   * distinct entities/day) this stays well under 100ms.
   */
  private async aggregateByAddress(
    type: SignalEntityType,
    hourKeys: string[],
  ): Promise<Map<string, number>> {
    const totals = new Map<string, number>();
    const seenAddresses = new Set<string>();

    // First pass — discover all addresses across all hour-buckets in this window
    await Promise.all(
      hourKeys.map(async (hk) => {
        const pattern = `metrics:${type}s:*:hour:${hk}`;
        const keys = await this.cache.keys(pattern);
        for (const k of keys) {
          // Key shape: metrics:{type}s:{addr}:hour:{YYYY-MM-DDTHH}
          const parts = k.split(':');
          const addr = parts[2];
          if (addr) seenAddresses.add(addr);
        }
      }),
    );

    // Second pass — read counter for every (address, hour) combination
    const reads: Array<Promise<void>> = [];
    for (const addr of seenAddresses) {
      for (const hk of hourKeys) {
        reads.push(
          this.cache.getRaw(`metrics:${type}s:${addr}:hour:${hk}`).then((raw) => {
            const n = raw ? parseInt(raw, 10) || 0 : 0;
            if (n > 0) totals.set(addr, (totals.get(addr) ?? 0) + n);
          }),
        );
      }
    }
    await Promise.all(reads);

    return totals;
  }
}
