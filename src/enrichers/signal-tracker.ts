import type { Cache } from '../cache';

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

const WINDOW_HOURS: Record<SignalWindow, number> = {
  '1h': 1,
  '6h': 6,
  '24h': 24,
};

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
  constructor(private cache: Cache) {}

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
