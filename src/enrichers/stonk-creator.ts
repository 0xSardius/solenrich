/**
 * stonk-creator — a StonkFun creator's track record (2026-10-05).
 *
 * Measured before building (local/scripts/measure-creators.ts, launches of 10/1–10/2): 65% of launches come from
 * creators who launch more than once a day, and coins from one-time creators still traded 3 days later 19% of the
 * time vs 5–6% for repeat launchers. "Ever paid" is NOT a quality signal (serial launchers scored higher: a
 * launch-day burst pays a few tiny payouts, then the coin dies), so the report uses "still trading" and "paid in
 * the last 24 h".
 *
 * Data: the creator's launch ledger (StonkFun `/launches?creator=`, capped) and the stonk index, which holds the
 * coins that traded in the last 24 h — a coin in the index is alive. No paid upstream reads.
 */
import type { StonkFunClient, StonkLaunch } from '../sources/stonkfun';
import type { StonkIndex, StonkIndexRow } from './stonk-index';
import type { Cache } from '../cache';
import { CACHE_TTL } from '../config';

const MAX_PAGES = 5;
const PAGE_SIZE = 100;
const MATURE_HOURS = 72;
const DAY_MS = 86_400_000;

export type CreatorVerdict = 'ESTABLISHED' | 'MIXED' | 'SERIAL_LAUNCHER' | 'NEW';

export interface CreatorCoin {
  mint: string;
  symbol: string;
  quote: string;
  created_at: string;
  alive: boolean;
  paying_24h: boolean;
  market_cap_usd: number | null;
  volume_24h_usd: number | null;
  holders: number | null;
  graduated: boolean;
}

export interface CreatorReport {
  creator: string;
  verdict: CreatorVerdict;
  launches: { total: number; last_24h: number; last_7d: number; read: number; complete: boolean };
  /** Coins older than 3 days, the ones old enough to judge. */
  matured: { count: number; still_trading: number; still_trading_pct: number | null; paying_24h: number };
  living: { count: number; best_market_cap_usd: number | null; graduated: number; holders_total: number };
  quotes: { symbol: string; launches: number }[];
  /** Up to 10 coins: the living ones first (by market cap), then the newest. */
  coins: CreatorCoin[];
  baseline: { one_time_creator_survival_pct: number; serial_launcher_survival_pct: number; note: string };
  evidence: string[];
  coverage: { index_partial: string | null };
  checked_at: string;
}

const BASELINE = {
  one_time_creator_survival_pct: 19,
  serial_launcher_survival_pct: 5,
  note: 'Share of coins still trading 3 days after launch, by creator type (StonkFun launches of 2026-10-01/02, 120-coin samples).',
};

/** Pure: the report from a creator's launches and the index rows of their coins. */
export function buildCreatorReport(
  creator: string,
  launches: StonkLaunch[],
  total: number,
  rows: Map<string, StonkIndexRow>,
  now: number,
  indexPartial: string | null = null,
): CreatorReport {
  const age = (l: StonkLaunch) => now - Date.parse(l.createdAt);
  const coins: CreatorCoin[] = launches.map((l) => {
    const r = rows.get(l.mint);
    const paying = r?.lastPayoutAt ? now - Date.parse(r.lastPayoutAt) <= DAY_MS : false;
    return {
      mint: l.mint,
      symbol: l.symbol,
      quote: l.quote?.symbol ?? '?',
      created_at: l.createdAt,
      alive: Boolean(r && r.volume24hUsd > 0),
      paying_24h: paying,
      market_cap_usd: r ? r.marketCapUsd : null,
      volume_24h_usd: r ? r.volume24hUsd : null,
      holders: r ? r.holderCount : null,
      graduated: r?.status === 'graduated',
    };
  });
  const last24 = launches.filter((l) => age(l) <= DAY_MS).length;
  const last7 = launches.filter((l) => age(l) <= 7 * DAY_MS).length;
  const matured = coins.filter((c) => now - Date.parse(c.created_at) >= MATURE_HOURS * 3_600_000);
  const survivors = matured.filter((c) => c.alive).length;
  const survivalPct = matured.length ? Math.round((100 * survivors) / matured.length) : null;
  const living = coins.filter((c) => c.alive);
  const bestCap = living.length ? Math.max(...living.map((c) => c.market_cap_usd ?? 0)) : null;

  const quoteCounts = new Map<string, number>();
  for (const c of coins) quoteCounts.set(c.quote, (quoteCounts.get(c.quote) ?? 0) + 1);

  // Verdict. Thresholds sit against the measured baselines: serial launchers ~5% survival, one-time creators ~19%.
  const serialVolume = last24 >= 5 || last7 >= 20;
  let verdict: CreatorVerdict;
  // NEW = too little history to judge: fewer than 2 coins old enough, and not launching at serial volume.
  if (matured.length < 2 && !serialVolume) verdict = 'NEW';
  else if (matured.length === 0) verdict = 'SERIAL_LAUNCHER';
  else if (serialVolume && (survivalPct ?? 0) < 10) verdict = 'SERIAL_LAUNCHER';
  else if (survivors >= 2 && (survivalPct ?? 0) >= 30) verdict = 'ESTABLISHED';
  else if (matured.length >= 1 && survivors === 0 && launches.length >= 5) verdict = 'SERIAL_LAUNCHER';
  else verdict = 'MIXED';

  const evidence: string[] = [];
  evidence.push(`${total} launch(es) all-time; ${last24} in the last 24 h, ${last7} in the last 7 days`);
  if (matured.length) evidence.push(`${survivors} of ${matured.length} coins older than 3 days still trade (${survivalPct}%; baseline 19% one-time creators, 5% serial launchers)`);
  else evidence.push('No coin is older than 3 days yet, so survival cannot be judged');
  const payingNow = matured.filter((c) => c.paying_24h).length;
  if (matured.length) evidence.push(`${payingNow} matured coin(s) paid holders in the last 24 h`);
  if (living.length) evidence.push(`${living.length} coin(s) traded in the last 24 h; best market cap now $${Math.round(bestCap ?? 0).toLocaleString('en-US')}`);
  if (launches.length < total) evidence.push(`Read the newest ${launches.length} of ${total} launches`);
  if (indexPartial) evidence.push(`The live-coin index was partial at check time (${indexPartial}); survival may read low`);

  const shown = [
    ...living.sort((a, b) => (b.market_cap_usd ?? 0) - (a.market_cap_usd ?? 0)),
    ...coins.filter((c) => !c.alive),
  ].slice(0, 10);

  return {
    creator,
    verdict,
    launches: { total, last_24h: last24, last_7d: last7, read: launches.length, complete: launches.length >= total },
    matured: { count: matured.length, still_trading: survivors, still_trading_pct: survivalPct, paying_24h: payingNow },
    living: { count: living.length, best_market_cap_usd: bestCap, graduated: living.filter((c) => c.graduated).length, holders_total: living.reduce((s, c) => s + (c.holders ?? 0), 0) },
    quotes: [...quoteCounts].map(([symbol, n]) => ({ symbol, launches: n })).sort((a, b) => b.launches - a.launches).slice(0, 8),
    coins: shown,
    baseline: BASELINE,
    evidence,
    coverage: { index_partial: indexPartial },
    checked_at: new Date(now).toISOString(),
  };
}

export class StonkCreatorAnalyzer {
  constructor(private stonkfun: StonkFunClient, private index: StonkIndex, private cache: Cache) {}

  /** `creator` wins when both are given; a mint is resolved to its creator through the launch record. */
  async analyze(input: { creator?: string; mint?: string }): Promise<CreatorReport | { error: string }> {
    let creator = input.creator;
    if (!creator && input.mint) {
      const t = await this.stonkfun.getToken(input.mint);
      creator = t?.launch?.creator;
      if (!creator) return { error: `No StonkFun launch record (and so no creator) for mint ${input.mint}` };
    }
    if (!creator) return { error: 'Provide creator or mint' };

    const cacheKey = `stonk:creator-report:${creator}`;
    const cached = await this.cache.get<CreatorReport>(cacheKey);
    if (cached) return cached;

    const launches: StonkLaunch[] = [];
    let total = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const p = await this.stonkfun.getCreatorLaunches(creator, page, PAGE_SIZE);
      total = p.total;
      launches.push(...p.launches);
      if (page >= p.totalPages || p.launches.length < PAGE_SIZE) break;
    }
    const rows = new Map<string, StonkIndexRow>();
    for (const l of launches) {
      const r = this.index.getRow(l.mint);
      if (r) rows.set(l.mint, r);
    }
    const status = this.index.status();
    const partial = status.partial ? `${status.partial.pages}/${status.partial.totalPages} pages` : null;
    const report = buildCreatorReport(creator, launches, total, rows, Date.now(), partial);
    await this.cache.set(cacheKey, report, CACHE_TTL.stonkCreator);
    return report;
  }
}
