import type { StonkFunClient, StonkToken } from '../sources/stonkfun';
import type { StonkIndexRow } from './stonk-index';
import { quoteStats, type QuoteStats } from './stonk-gems';

// Per-quote shelf statistics over the WHOLE StonkFun reward-coin population.
//
// The ten-minute index holds only coins that traded in the last 24h (~11,500 of ~86,000 on 2026-09-23), so any
// share computed over its rows (traded %, survival past day 3, launches, crowding, tax mix) is wrong. A separate
// job (`scripts/stonk-population.ts`, GitHub Actions every 6 hours) walks every page, computes the per-quote
// stats, and writes one summary to Redis. The API reads that summary: no extra RAM, no Railway cost, and no
// share of the StonkFun request budget that buyers' stonk-yield calls use. When the summary is missing or older
// than POPULATION_MAX_AGE_MS, stonk-gems skips its quote factor and stonk-launch-intel says its shelf stats are
// limited.

export const POPULATION_CACHE_KEY = 'stonk:population:v1';
export const POPULATION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const POPULATION_MAX_AGE_MS = 48 * 60 * 60 * 1000;
/** The job does not write a summary that read fewer pages than this share (it keeps the last good one). */
export const POPULATION_MIN_COVERAGE = 0.7;

export interface StonkPopulation {
  version: 1;
  generatedAt: string;
  /** Coins in the summary (unique mints read). */
  coins: number;
  /** StonkFun's own reward-coin count at walk time. */
  upstreamTotal: number;
  pagesRead: number;
  pagesTotal: number;
  quotes: QuoteStats[];
}

export interface PopulationStatus {
  generatedAt: string;
  ageHours: number;
  fresh: boolean;
  coins: number;
  upstreamTotal: number;
  pagesRead: number;
  pagesTotal: number;
}

/** Pure: the summary the job writes. `rows` = every coin read, built with the index's own `toRow`. */
export function buildPopulation(
  rows: StonkIndexRow[],
  now: number,
  walk: { upstreamTotal: number; pagesRead: number; pagesTotal: number },
): StonkPopulation {
  return {
    version: 1,
    generatedAt: new Date(now).toISOString(),
    coins: rows.length,
    upstreamTotal: walk.upstreamTotal,
    pagesRead: walk.pagesRead,
    pagesTotal: walk.pagesTotal,
    quotes: quoteStats(rows, now),
  };
}

/** Pure: status of a summary read from Redis, or null when there is none. */
export function populationStatus(p: StonkPopulation | null, now: number): PopulationStatus | null {
  if (!p || p.version !== 1 || !Array.isArray(p.quotes)) return null;
  const t = Date.parse(p.generatedAt);
  if (!Number.isFinite(t)) return null;
  const age = now - t;
  return {
    generatedAt: p.generatedAt,
    ageHours: Math.round((age / 3_600_000) * 10) / 10,
    fresh: age >= 0 && age <= POPULATION_MAX_AGE_MS,
    coins: p.coins,
    upstreamTotal: p.upstreamTotal,
    pagesRead: p.pagesRead,
    pagesTotal: p.pagesTotal,
  };
}

/**
 * Walks every reward-coin page (default sort) with a few requests in flight, a short timeout, and one retry
 * pass over the pages that failed. StonkFun is slow at random (~1 in 4 pages takes 4–20s), so a failed page is
 * skipped, not fatal. Page 1 is retried up to 5 times; it carries the page count.
 */
export async function walkAllRewardTokens(
  client: Pick<StonkFunClient, 'getTokens'>,
  opts: { concurrency?: number; timeoutMs?: number } = {},
): Promise<{ tokens: StonkToken[]; upstreamTotal: number; pagesRead: number; pagesTotal: number; failedPages: number[] }> {
  const concurrency = opts.concurrency ?? 3;
  const timeoutMs = opts.timeoutMs ?? 8_000;
  let first: Awaited<ReturnType<StonkFunClient['getTokens']>> | null = null;
  for (let i = 0; i < 5 && !first; i++) {
    first = await client.getTokens({ mode: 'reward', page: 1, pageSize: 100 }, timeoutMs).catch(() => null);
  }
  if (!first) throw new Error('page 1 failed 5 times');
  const pagesTotal = Math.max(1, first.pagination.totalPages ?? 1);
  const byMint = new Map<string, StonkToken>(first.tokens.map((t) => [t.mint, t]));
  let failed: number[] = [];
  const run = async (pages: number[]) => {
    const queue = [...pages];
    const worker = async () => {
      for (let p = queue.shift(); p !== undefined; p = queue.shift()) {
        try {
          const res = await client.getTokens({ mode: 'reward', page: p, pageSize: 100 }, timeoutMs);
          for (const t of res.tokens) byMint.set(t.mint, t);
        } catch {
          failed.push(p);
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  };
  await run(Array.from({ length: pagesTotal - 1 }, (_, i) => i + 2));
  const retry = failed;
  failed = [];
  await run(retry);
  failed.sort((a, b) => a - b);
  return {
    tokens: [...byMint.values()],
    upstreamTotal: first.pagination.total ?? byMint.size,
    pagesRead: pagesTotal - failed.length,
    pagesTotal,
    failedPages: failed,
  };
}
