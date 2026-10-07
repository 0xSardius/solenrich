/**
 * stonk-market-pulse — is the StonkFun market rising or falling right now? (2026-10-06)
 *
 * Why: Moneta's paper test showed the market move outweighs every pick (the median scouted coin fell 4.5–24% a day
 * from 9/26 to 10/2). Scanners can gate on this, dashboards can show it, Moneta's market filter needs it.
 *
 * Inputs, all already in memory or cached: the live index (coins that traded in 24 h), the population summary
 * (every reward coin, 6-hourly), StonkFun's daily revenue history (1 h cache), and our own hourly breadth snapshots
 * (Redis, 8 days) — the trend line only we keep.
 *
 * Thresholds measured 2026-10-06 (local/scripts/measure-pulse.ts): breadth 40%, median −1.7%, volume-weighted
 * +14% over 2,503 live coins with a 24 h change. Provisional; tune from the snapshot history.
 */
import type { StonkFunClient } from '../sources/stonkfun';
import type { StonkIndex, StonkIndexRow } from './stonk-index';
import type { QuoteStats } from './stonk-gems';
import type { Cache } from '../cache';

export type PulseVerdict = 'RISK_ON' | 'NEUTRAL' | 'RISK_OFF';

export const PULSE_THRESHOLDS = {
  risk_off_median_pct: -5,
  risk_off_breadth_pct: 30,
  risk_on_median_pct: 2,
  risk_on_breadth_pct: 55,
  min_live_coins_per_shelf: 15,
};

const SNAPSHOT_KEY = (hour: string) => `stonk:pulse:${hour}`;
const SNAPSHOT_TTL = 8 * 86400;
const DAY_MS = 86_400_000;

export interface PulseSnapshot { t: string; breadth_pct: number; median_change_pct: number; volume_weighted_change_pct: number; live_coins: number }

export interface ShelfPulse { quote: string; live_coins: number; breadth_pct: number; median_change_pct: number; volume_24h_usd: number }

export interface PulseLive {
  coins: number;
  coins_with_change: number;
  breadth_pct: number;
  median_change_pct: number;
  p25_change_pct: number;
  p75_change_pct: number;
  volume_weighted_change_pct: number;
  volume_24h_usd: number;
  paying_24h_pct: number;
}

export interface PulseReport {
  verdict: PulseVerdict;
  live: PulseLive;
  population: { coins: number; launches_24h: number; launches_7d: number; traded_24h_pct: number | null; paying_24h_pct: number | null; survival_3d_pct: number | null; source: 'population' | 'index' } | null;
  revenue: { last_7d: { date: string; holders_usd: number; total_usd: number }[]; holders_7d_usd: number; holders_prior_7d_usd: number; holders_change_pct: number | null } | null;
  shelves: { strongest: ShelfPulse[]; weakest: ShelfPulse[] };
  trend: PulseSnapshot[];
  thresholds: typeof PULSE_THRESHOLDS;
  evidence: string[];
  caveats: string[];
  checked_at: string;
}

const pctOf = (n: number, d: number) => (d ? Math.round((1000 * n) / d) / 10 : 0);
function quantile(sorted: number[], p: number): number {
  return sorted.length ? sorted[Math.floor(p * (sorted.length - 1))] : 0;
}
const round1 = (x: number) => Math.round(x * 10) / 10;

/** Pure: breadth and moves over the live rows. */
export function livePulse(rows: StonkIndexRow[], now: number): PulseLive {
  const withChange = rows.filter((r) => r.volume24hUsd > 0 && r.priceChange24h != null && Number.isFinite(r.priceChange24h));
  const ch = withChange.map((r) => r.priceChange24h as number).sort((a, b) => a - b);
  const vol = withChange.reduce((s, r) => s + r.volume24hUsd, 0);
  const vw = vol ? withChange.reduce((s, r) => s + (r.priceChange24h as number) * r.volume24hUsd, 0) / vol : 0;
  const paying = rows.filter((r) => r.lastPayoutAt && now - Date.parse(r.lastPayoutAt) <= DAY_MS).length;
  return {
    coins: rows.length,
    coins_with_change: withChange.length,
    breadth_pct: pctOf(ch.filter((c) => c > 0).length, ch.length),
    median_change_pct: round1(quantile(ch, 0.5)),
    p25_change_pct: round1(quantile(ch, 0.25)),
    p75_change_pct: round1(quantile(ch, 0.75)),
    volume_weighted_change_pct: round1(vw),
    volume_24h_usd: Math.round(rows.reduce((s, r) => s + r.volume24hUsd, 0)),
    paying_24h_pct: pctOf(paying, rows.length),
  };
}

/** Pure: per-quote breadth among live coins; shelves with too few coins are left out. */
export function shelfPulse(rows: StonkIndexRow[]): { strongest: ShelfPulse[]; weakest: ShelfPulse[] } {
  const byQuote = new Map<string, StonkIndexRow[]>();
  for (const r of rows) {
    if (!(r.volume24hUsd > 0) || r.priceChange24h == null) continue;
    byQuote.set(r.quoteSymbol, [...(byQuote.get(r.quoteSymbol) ?? []), r]);
  }
  const shelves: ShelfPulse[] = [];
  for (const [quote, rs] of byQuote) {
    if (rs.length < PULSE_THRESHOLDS.min_live_coins_per_shelf) continue;
    const ch = rs.map((r) => r.priceChange24h as number).sort((a, b) => a - b);
    shelves.push({ quote, live_coins: rs.length, breadth_pct: pctOf(ch.filter((c) => c > 0).length, ch.length), median_change_pct: round1(quantile(ch, 0.5)), volume_24h_usd: Math.round(rs.reduce((s, r) => s + r.volume24hUsd, 0)) });
  }
  const sorted = shelves.sort((a, b) => b.median_change_pct - a.median_change_pct || b.breadth_pct - a.breadth_pct);
  return { strongest: sorted.slice(0, 5), weakest: sorted.slice(-5).reverse() };
}

/** Pure: the regime from breadth and the median move. */
export function pulseVerdict(live: PulseLive): PulseVerdict {
  const t = PULSE_THRESHOLDS;
  if (live.median_change_pct <= t.risk_off_median_pct || live.breadth_pct < t.risk_off_breadth_pct) return 'RISK_OFF';
  if (live.median_change_pct >= t.risk_on_median_pct && live.breadth_pct >= t.risk_on_breadth_pct) return 'RISK_ON';
  return 'NEUTRAL';
}

/** Pure: population totals from the per-quote summary. */
export function populationPulse(stats: QuoteStats[], source: 'population' | 'index'): PulseReport['population'] {
  if (!stats.length) return null;
  const sum = (f: (q: QuoteStats) => number) => stats.reduce((s, q) => s + f(q), 0);
  const coins = sum((q) => q.coins);
  const older = sum((q) => q.older_than_3d);
  const survived = stats.reduce((s, q) => s + (q.survival_3d != null ? q.survival_3d * q.older_than_3d : 0), 0);
  return {
    coins,
    launches_24h: sum((q) => q.launches_24h),
    launches_7d: sum((q) => q.launches_7d),
    traded_24h_pct: coins ? pctOf(sum((q) => q.traded_24h), coins) : null,
    paying_24h_pct: coins ? pctOf(sum((q) => q.paying_24h), coins) : null,
    survival_3d_pct: older ? round1((100 * survived) / older) : null,
    source,
  };
}

/** Pure: last 7 complete UTC days of holder revenue vs the 7 before. Today's partial day is left out. */
export function revenuePulse(days: { date: string; total_usd: number; holders_usd: number }[], now: number): PulseReport['revenue'] {
  const today = new Date(now).toISOString().slice(0, 10);
  const complete = days.filter((d) => d.date < today).sort((a, b) => a.date.localeCompare(b.date));
  if (complete.length < 7) return null;
  const last = complete.slice(-7);
  const prior = complete.slice(-14, -7);
  const h = (xs: typeof last) => xs.reduce((s, d) => s + d.holders_usd, 0);
  const holders7 = h(last);
  const holdersPrior = prior.length === 7 ? h(prior) : 0;
  return {
    last_7d: last.map((d) => ({ date: d.date, holders_usd: Math.round(d.holders_usd), total_usd: Math.round(d.total_usd) })),
    holders_7d_usd: Math.round(holders7),
    holders_prior_7d_usd: Math.round(holdersPrior),
    holders_change_pct: holdersPrior ? round1((100 * (holders7 - holdersPrior)) / holdersPrior) : null,
  };
}

export class StonkPulseAnalyzer {
  constructor(private stonkfun: StonkFunClient, private index: StonkIndex, private cache: Cache) {}

  /** Store this hour's breadth snapshot (idempotent per hour). Called on a timer; skipped while the index is empty. */
  async recordSnapshot(now = Date.now()): Promise<void> {
    const rows = this.index.allRows();
    if (!rows.length) return;
    const live = livePulse(rows, now);
    const hour = new Date(now).toISOString().slice(0, 13);
    const snap: PulseSnapshot = { t: `${hour}:00Z`, breadth_pct: live.breadth_pct, median_change_pct: live.median_change_pct, volume_weighted_change_pct: live.volume_weighted_change_pct, live_coins: live.coins };
    await this.cache.setIfAbsent(SNAPSHOT_KEY(hour), snap, SNAPSHOT_TTL);
  }

  /** One snapshot per day for the last 7 days (the latest hour stored on each day). */
  private async trend(now: number): Promise<PulseSnapshot[]> {
    const keys: string[] = [];
    for (let h = 0; h < 7 * 24; h++) keys.push(SNAPSHOT_KEY(new Date(now - h * 3_600_000).toISOString().slice(0, 13)));
    const got = (await this.cache.mget<PulseSnapshot>(keys)).filter((s): s is PulseSnapshot => Boolean(s));
    const perDay = new Map<string, PulseSnapshot>();
    for (const s of got) if (!perDay.has(s.t.slice(0, 10))) perDay.set(s.t.slice(0, 10), s); // newest first
    return [...perDay.values()].sort((a, b) => a.t.localeCompare(b.t));
  }

  async analyze(): Promise<PulseReport> {
    // One report per minute is enough; it saves the 168-key trend read on bursts (a scanner polling every few seconds).
    const cached = await this.cache.get<PulseReport>('stonk:pulse:report');
    if (cached) return cached;
    const report = await this.build();
    await this.cache.set('stonk:pulse:report', report, 60);
    return report;
  }

  private async build(): Promise<PulseReport> {
    const now = Date.now();
    const rows = this.index.allRows();
    const live = livePulse(rows, now);
    const verdict = pulseVerdict(live);
    // Population totals only from the fresh 6-hourly summary of every reward coin. The live-index fallback holds only
    // coins that traded, so "share trading" would read ~100% and mislead.
    const shelf = this.index.shelfStats();
    const population = shelf.source === 'population' ? populationPulse(shelf.stats, 'population') : null;
    const revenue = revenuePulse(await this.stonkfun.getRevenueHistory().catch(() => []), now);
    const shelves = shelfPulse(rows);
    const trend = await this.trend(now).catch(() => []);
    const status = this.index.status();

    const evidence: string[] = [];
    evidence.push(`${live.breadth_pct}% of ${live.coins_with_change} live coins are up over 24 h; the median coin moved ${live.median_change_pct}% (middle half ${live.p25_change_pct}% to ${live.p75_change_pct}%)`);
    evidence.push(`Volume-weighted 24 h move ${live.volume_weighted_change_pct}% on $${live.volume_24h_usd.toLocaleString('en-US')} volume${Math.abs(live.volume_weighted_change_pct - live.median_change_pct) >= 5 ? ' — the big coins and the typical coin are moving apart' : ''}`);
    if (population) evidence.push(`${population.launches_24h.toLocaleString('en-US')} launches in 24 h; ${population.traded_24h_pct}% of ${population.coins.toLocaleString('en-US')} reward coins traded and ${population.paying_24h_pct}% paid holders in 24 h; ${population.survival_3d_pct}% of coins older than 3 days still trade`);
    if (revenue?.holders_change_pct != null) evidence.push(`Holders were paid $${revenue.holders_7d_usd.toLocaleString('en-US')} over the last 7 days, ${revenue.holders_change_pct >= 0 ? '+' : ''}${revenue.holders_change_pct}% vs the 7 days before`);
    if (shelves.strongest[0]) evidence.push(`Strongest shelf: ${shelves.strongest[0].quote} (median ${shelves.strongest[0].median_change_pct}%); weakest: ${shelves.weakest[0]?.quote} (median ${shelves.weakest[0]?.median_change_pct}%)`);

    const caveats = [
      'Breadth and moves cover live coins only (traded in the last 24 h); dead coins drop out, so the true market is weaker than the median shown.',
      'Thresholds are provisional (set 2026-10-06 from one day of data); the trend line is our own hourly record and grows daily.',
    ];
    if (status.partial) caveats.push(`The live index was partial at check time (${status.partial.pages}/${status.partial.totalPages} pages).`);
    if (!population) caveats.push('Population totals (launches, share trading and paying, survival) are omitted: the 6-hourly summary of every reward coin is not fresh right now.');

    return { verdict, live, population, revenue, shelves, trend, thresholds: PULSE_THRESHOLDS, evidence, caveats, checked_at: new Date(now).toISOString() };
  }
}
