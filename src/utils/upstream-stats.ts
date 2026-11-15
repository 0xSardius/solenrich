// Upstream usage counters (2026-11-15). Measures the Jupiter Free-plan limit (1 RPS per account) so the
// Developer-plan decision rests on numbers: requests and 429s per kind, and how many token responses were
// degraded. Counted in process; deltas flush to Redis every 15 min (one INCRBY per changed counter), so a
// restart loses at most 15 min and 7-day history survives deploys.

import type { Cache } from '../cache';

export const UPSTREAM_COUNTERS = [
  'jupiter_token_requests', 'jupiter_token_429', 'jupiter_token_429_after_retry',
  'jupiter_quote_requests', 'jupiter_quote_429', 'jupiter_quote_429_after_retry',
  'jupiter_price_requests', 'jupiter_price_429',
  'token_responses', 'token_degraded',
  'limiter_waited', 'limiter_skipped',
] as const;
export type UpstreamCounter = (typeof UPSTREAM_COUNTERS)[number];

const KEY = (date: string, name: string) => `metrics:upstream:${date}:${name}`;
const TTL_SECONDS = 35 * 86400;
const day = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);

export class UpstreamStats {
  private today: Record<string, number> = {};
  private todayDate = day();
  /** Unflushed deltas, keyed "date|name" so a flush after midnight still lands on the right day. */
  private pending = new Map<string, number>();

  inc(name: UpstreamCounter, by = 1): void {
    const d = day();
    if (d !== this.todayDate) { this.todayDate = d; this.today = {}; }
    this.today[name] = (this.today[name] ?? 0) + by;
    const k = `${d}|${name}`;
    this.pending.set(k, (this.pending.get(k) ?? 0) + by);
  }

  /** In-process counts since the UTC day began (or since boot, if later). */
  snapshotToday(): Record<string, number> {
    if (day() !== this.todayDate) return {};
    return { ...this.today };
  }

  async flush(cache: Cache): Promise<void> {
    const batch = [...this.pending];
    this.pending.clear();
    for (const [k, n] of batch) {
      const [d, name] = k.split('|');
      const ok = await cache.incrby(KEY(d, name), n, TTL_SECONDS);
      if (ok === 0) this.pending.set(k, (this.pending.get(k) ?? 0) + n); // failed: retry next flush
    }
  }

  /** Persisted daily totals for the last `days` UTC days (today includes unflushed counts). */
  async history(cache: Cache, days = 7, now = Date.now()): Promise<Array<{ date: string } & Record<string, number | string>>> {
    const dates = Array.from({ length: days }, (_, i) => day(now - i * 86400_000));
    const keys = dates.flatMap((d) => UPSTREAM_COUNTERS.map((n) => KEY(d, n)));
    const vals = await cache.mget<number>(keys);
    return dates.map((d, di) => {
      const row: { date: string } & Record<string, number | string> = { date: d };
      UPSTREAM_COUNTERS.forEach((n, ni) => {
        const stored = Number(vals[di * UPSTREAM_COUNTERS.length + ni] ?? 0) || 0;
        const unflushed = this.pending.get(`${d}|${n}`) ?? 0;
        if (stored + unflushed > 0) row[n] = stored + unflushed;
      });
      const responses = Number(row.token_responses ?? 0);
      if (responses > 0) row.token_degraded_pct = Math.round((Number(row.token_degraded ?? 0) / responses) * 1000) / 10;
      return row;
    });
  }
}

export const upstreamStats = new UpstreamStats();
