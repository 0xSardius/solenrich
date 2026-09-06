import type { Cache } from '../cache';
import type { JupiterClient } from '../sources/jupiter';
import type { StonkFunClient, StonkToken, StonkRewardsLedgerEntry } from '../sources/stonkfun';

// StonkFun reward-coin index. A scheduled ingest (every 10 minutes) pulls
// every reward-mode token (market data, paginated at 100/page) plus the
// lifetime rewards ledger (one call) and keeps them in memory for the
// screener. Because StonkFun exposes no per-window distribution history
// (its /rewards "recentDistributions" is capped at the last 100 payouts),
// the ingest also records one point per coin per day — distributed total,
// market cap, holder count — so trailing 7d/30d yields can be computed as
// deltas. The series is persisted to Redis in daily chunks and reloaded on
// boot; the rows are not (they are rebuilt by the first refresh).
//
// Budget (measured 2026-09-06): ~6,300 reward tokens → 64 pages + 1 ledger
// call per refresh ≈ 65 upstream calls per 10 minutes, well under the
// 300/min limit. Redis: ≤ ~5 writes per refresh, ~120 reads on boot.

export const STONK_INGEST_INTERVAL_MS = 10 * 60 * 1000;
const SERIES_DAYS = 31;
const SNAPSHOT_TTL_SECONDS = 35 * 24 * 60 * 60;
const SNAPSHOT_CHUNK = 1500;
const PAGE_SIZE = 100;
const PAGE_GAP_MS = 60;
const MAX_PAGES = 200;
const MIN_WINDOW_MS = 60 * 60 * 1000;

/** Normalized quote category. StonkFun's raw label is kept alongside. */
export type StonkCategory = 'xstock' | 'prestock' | 'currency' | 'leverage' | 'solana' | 'collectible' | 'custom';

export function normalizeCategory(raw: string | undefined | null): StonkCategory {
  switch ((raw ?? '').toLowerCase()) {
    case 'xstock': return 'xstock';
    case 'tessera': return 'xstock';      // tokenized equities, different issuer
    case 'prestock': return 'prestock';
    case 'backpack': return 'prestock';   // Backpack pre-market stocks
    case 'currency': return 'currency';
    case 'leverage': return 'leverage';
    case 'solana': return 'solana';
    case 'collectible': return 'collectible';
    default: return 'custom';
  }
}

export interface StonkIndexRow {
  mint: string;
  symbol: string;
  name: string;
  quoteMint: string;
  quoteSymbol: string;
  quoteDecimals: number | null;
  quoteCategory: StonkCategory;
  quoteCategoryRaw: string;
  launchpad: string;
  mode: string;
  bps: number | null;
  flywheelActive: boolean;
  priceUsd: number;
  marketCapUsd: number;
  volume24hUsd: number;
  priceChange24h: number | null;
  status: string;
  createdAt: string;
  graduatedAt: string | null;
  distributedTokens: number;
  distributedRaw: string | null;
  payoutCount: number;
  holderCount: number;
  lastPayoutAt: string | null;
}

/** One observation per coin per day. `t` = epoch ms of the observation. */
export interface DayPoint {
  t: number;
  /** Distributed rewards to date, in quote tokens. */
  dist: number;
  marketCapUsd: number;
  holders: number;
}

export interface StonkScreenerFilters {
  quoteMint?: string;
  category?: StonkCategory;
  minHolders?: number;
  minAgeDays?: number;
  sort?: 'yield7d' | 'yield30d' | 'rewardsUsd' | 'volume24h';
  limit?: number;
}

export interface StonkScreenerRow extends StonkIndexRow {
  quoteUsd: number | null;
  rewardsUsd: number | null;
  ageDays: number;
  /** Trailing yields in %, null until the series covers the window start. */
  yield7dPct: number | null;
  yield30dPct: number | null;
  /** Days of history behind each yield figure (< window = partial). */
  window7dActualDays: number | null;
  window30dActualDays: number | null;
}

export interface StonkIndexStatus {
  rows: number;
  lastRefreshAt: string | null;
  lastRefreshMs: number | null;
  lastError: string | null;
  refreshing: boolean;
  seriesCoins: number;
  seriesDays: number;
  oldestPointAt: string | null;
  quotePrices: number;
}

type SnapshotTuple = [mint: string, t: number, dist: number, mcap: number, holders: number];

function dayKey(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/** Pure: trailing yield over a window from a coin's day series. Exported for tests. */
export function trailingYield(
  series: DayPoint[],
  now: number,
  windowDays: number,
  distNow: number,
  mcapNow: number,
  quoteUsd: number | null,
): { yieldPct: number | null; actualDays: number | null; rewardsQuote: number | null; rewardsUsd: number | null; avgMcapUsd: number | null } {
  const empty = { yieldPct: null, actualDays: null, rewardsQuote: null, rewardsUsd: null, avgMcapUsd: null };
  if (!series.length) return empty;
  const windowStart = now - windowDays * 86_400_000;
  // Anchor on the snapshot closest to the window start, on either side, so
  // the delta spans as close to the requested window as the series allows.
  const sorted = [...series].sort((a, b) => a.t - b.t);
  const after = sorted.find((p) => p.t >= windowStart) ?? null;
  const before = [...sorted].reverse().find((p) => p.t < windowStart) ?? null;
  let start: DayPoint | null = after;
  if (before && (!after || windowStart - before.t < after.t - windowStart)) start = before;
  if (!start) return empty;
  const actualMs = now - start.t;
  // Under an hour of history is noise, not a yield — report nothing rather than 0%.
  if (actualMs < MIN_WINDOW_MS) return empty;
  const inWindow = sorted.filter((p) => p.t >= start!.t);
  const mcaps = inWindow.map((p) => p.marketCapUsd).filter((m) => m > 0);
  if (mcapNow > 0) mcaps.push(mcapNow);
  const avgMcap = mcaps.length ? mcaps.reduce((a, b) => a + b, 0) / mcaps.length : 0;
  const rewardsQuote = Math.max(0, distNow - start.dist);
  const rewardsUsd = quoteUsd != null ? rewardsQuote * quoteUsd : null;
  const yieldPct = rewardsUsd != null && avgMcap > 0 ? (rewardsUsd / avgMcap) * 100 : null;
  return {
    yieldPct: yieldPct != null ? Math.round(yieldPct * 10000) / 10000 : null,
    actualDays: Math.round((actualMs / 86_400_000) * 100) / 100,
    rewardsQuote,
    rewardsUsd,
    avgMcapUsd: avgMcap > 0 ? avgMcap : null,
  };
}

export class StonkIndex {
  private rows = new Map<string, StonkIndexRow>();
  private series = new Map<string, DayPoint[]>();
  private quotePrices = new Map<string, number>();
  private lastRefreshAt: number | null = null;
  private lastRefreshMs: number | null = null;
  private lastError: string | null = null;
  private refreshing = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private loaded = false;

  constructor(
    private readonly client: StonkFunClient,
    private readonly jupiter: JupiterClient,
    private readonly cache: Cache,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Load persisted snapshots, refresh once, then keep refreshing on a timer. */
  async start(intervalMs = STONK_INGEST_INTERVAL_MS): Promise<void> {
    await this.loadSeries();
    void this.refresh();
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => { void this.refresh(); }, intervalMs);
    // Do not keep the process alive for the ingest alone.
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): StonkIndexStatus {
    let oldest: number | null = null;
    const days = new Set<string>();
    for (const pts of this.series.values()) {
      for (const p of pts) {
        days.add(dayKey(p.t));
        if (oldest == null || p.t < oldest) oldest = p.t;
      }
    }
    return {
      rows: this.rows.size,
      lastRefreshAt: this.lastRefreshAt ? new Date(this.lastRefreshAt).toISOString() : null,
      lastRefreshMs: this.lastRefreshMs,
      lastError: this.lastError,
      refreshing: this.refreshing,
      seriesCoins: this.series.size,
      seriesDays: days.size,
      oldestPointAt: oldest != null ? new Date(oldest).toISOString() : null,
      quotePrices: this.quotePrices.size,
    };
  }

  getRow(mint: string): StonkIndexRow | null {
    return this.rows.get(mint) ?? null;
  }

  getSeries(mint: string): DayPoint[] {
    return [...(this.series.get(mint) ?? [])].sort((a, b) => a.t - b.t);
  }

  getQuoteUsd(quoteMint: string): number | null {
    return this.quotePrices.get(quoteMint) ?? null;
  }

  /** Record a point for a coin outside the ingest (e.g. when an endpoint reads fresh totals). */
  observe(mint: string, point: DayPoint): void {
    const pts = this.series.get(mint) ?? [];
    const day = dayKey(point.t);
    if (pts.some((p) => dayKey(p.t) === day)) return;
    pts.push(point);
    this.series.set(mint, pts);
  }

  /** Ranked screener over the in-memory rows. Sub-millisecond; no I/O. */
  screen(filters: StonkScreenerFilters = {}): { rows: StonkScreenerRow[]; total: number; matched: number } {
    const now = this.now();
    const sort = filters.sort ?? 'rewardsUsd';
    const limit = Math.max(1, Math.min(filters.limit ?? 25, 100));
    const out: StonkScreenerRow[] = [];

    for (const row of this.rows.values()) {
      if (filters.quoteMint && row.quoteMint !== filters.quoteMint) continue;
      if (filters.category && row.quoteCategory !== filters.category) continue;
      if (filters.minHolders != null && row.holderCount < filters.minHolders) continue;
      const ageDays = (now - Date.parse(row.createdAt)) / 86_400_000;
      if (filters.minAgeDays != null && ageDays < filters.minAgeDays) continue;

      const quoteUsd = this.quotePrices.get(row.quoteMint) ?? null;
      const series = this.series.get(row.mint) ?? [];
      const y7 = trailingYield(series, now, 7, row.distributedTokens, row.marketCapUsd, quoteUsd);
      const y30 = trailingYield(series, now, 30, row.distributedTokens, row.marketCapUsd, quoteUsd);
      out.push({
        ...row,
        quoteUsd,
        rewardsUsd: quoteUsd != null ? row.distributedTokens * quoteUsd : null,
        ageDays: Math.round(ageDays * 100) / 100,
        yield7dPct: y7.yieldPct,
        yield30dPct: y30.yieldPct,
        window7dActualDays: y7.actualDays,
        window30dActualDays: y30.actualDays,
      });
    }

    const key = (r: StonkScreenerRow): number | null =>
      sort === 'yield7d' ? r.yield7dPct : sort === 'yield30d' ? r.yield30dPct : sort === 'volume24h' ? r.volume24hUsd : r.rewardsUsd;
    out.sort((a, b) => {
      const ka = key(a); const kb = key(b);
      if (ka == null && kb == null) return b.volume24hUsd - a.volume24hUsd;
      if (ka == null) return 1;
      if (kb == null) return -1;
      return kb - ka;
    });

    return { rows: out.slice(0, limit), total: this.rows.size, matched: out.length };
  }

  // --- ingest --------------------------------------------------------------

  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    const started = this.now();
    try {
      const [ledger, tokens] = await Promise.all([this.client.getRewardsLedger(), this.fetchAllRewardTokens()]);
      const ledgerByMint = new Map<string, StonkRewardsLedgerEntry>(ledger.map((l) => [l.mint, l]));

      const next = new Map<string, StonkIndexRow>();
      for (const t of tokens) {
        const l = ledgerByMint.get(t.mint);
        next.set(t.mint, toRow(t, l));
      }
      // Reward coins the ledger knows but the token list did not return (pool
      // gone, delisted) keep their previous row so history stays reachable.
      for (const [mint, row] of this.rows) if (!next.has(mint)) next.set(mint, row);
      this.rows = next;

      await this.refreshQuotePrices();
      this.recordPoints(started);
      this.pruneSeries(started);
      await this.persistToday(started);

      this.lastRefreshAt = this.now();
      this.lastRefreshMs = this.lastRefreshAt - started;
      this.lastError = null;
      console.log(`[stonk-index] refreshed ${this.rows.size} reward coins, ${this.series.size} with series, ${this.quotePrices.size} quote prices in ${this.lastRefreshMs}ms`);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      console.warn(`[stonk-index] refresh failed: ${this.lastError}`);
    } finally {
      this.refreshing = false;
    }
  }

  private async fetchAllRewardTokens(): Promise<StonkToken[]> {
    const all: StonkToken[] = [];
    let page = 1;
    let totalPages = 1;
    do {
      const res = await this.client.getTokens({ mode: 'reward', page, pageSize: PAGE_SIZE, sort: 'volume24h' });
      all.push(...res.tokens);
      totalPages = Math.min(res.pagination.totalPages ?? 1, MAX_PAGES);
      page++;
      if (page <= totalPages) await new Promise((r) => setTimeout(r, PAGE_GAP_MS));
    } while (page <= totalPages);
    return all;
  }

  private async refreshQuotePrices(): Promise<void> {
    const mints = [...new Set([...this.rows.values()].map((r) => r.quoteMint))];
    for (let i = 0; i < mints.length; i += 50) {
      const batch = mints.slice(i, i + 50);
      try {
        const prices = await this.jupiter.getPrice(batch);
        for (const [mint, p] of Object.entries(prices)) {
          if (p && typeof p.price === 'number' && p.price > 0) this.quotePrices.set(mint, p.price);
        }
      } catch (err) {
        console.warn(`[stonk-index] quote price batch failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private recordPoints(t: number): void {
    const cutoff = t - 30 * 86_400_000;
    for (const row of this.rows.values()) {
      // Skip coins with no distribution activity in the last 30 days and no
      // market — they add nothing to a trailing-yield series.
      const lastPayout = row.lastPayoutAt ? Date.parse(row.lastPayoutAt) : 0;
      if (lastPayout < cutoff && row.marketCapUsd <= 0) continue;
      this.observe(row.mint, { t, dist: row.distributedTokens, marketCapUsd: row.marketCapUsd, holders: row.holderCount });
    }
  }

  private pruneSeries(t: number): void {
    const cutoff = t - SERIES_DAYS * 86_400_000;
    for (const [mint, pts] of this.series) {
      const kept = pts.filter((p) => p.t >= cutoff);
      if (kept.length) this.series.set(mint, kept);
      else this.series.delete(mint);
    }
  }

  // --- persistence ---------------------------------------------------------

  private async persistToday(t: number): Promise<void> {
    const day = dayKey(t);
    const tuples: SnapshotTuple[] = [];
    for (const [mint, pts] of this.series) {
      const p = pts.find((x) => dayKey(x.t) === day);
      if (p) tuples.push([mint, p.t, p.dist, p.marketCapUsd, p.holders]);
    }
    const chunks = Math.ceil(tuples.length / SNAPSHOT_CHUNK);
    for (let i = 0; i < chunks; i++) {
      await this.cache.set(`stonk:snap:${day}:${i}`, tuples.slice(i * SNAPSHOT_CHUNK, (i + 1) * SNAPSHOT_CHUNK), SNAPSHOT_TTL_SECONDS);
    }
    await this.cache.set(`stonk:snap:${day}:n`, chunks, SNAPSHOT_TTL_SECONDS);
  }

  private async loadSeries(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const now = this.now();
    let points = 0;
    for (let d = SERIES_DAYS; d >= 0; d--) {
      const day = dayKey(now - d * 86_400_000);
      const n = await this.cache.get<number>(`stonk:snap:${day}:n`);
      if (!n) continue;
      const keys = Array.from({ length: n }, (_, i) => `stonk:snap:${day}:${i}`);
      const chunks = await this.cache.mget<SnapshotTuple[]>(keys);
      for (const chunk of chunks) {
        if (!Array.isArray(chunk)) continue;
        for (const [mint, t, dist, mcap, holders] of chunk) {
          this.observe(mint, { t, dist, marketCapUsd: mcap, holders });
          points++;
        }
      }
    }
    if (points) console.log(`[stonk-index] loaded ${points} snapshot points for ${this.series.size} coins`);
  }
}

function toRow(t: StonkToken, l: StonkRewardsLedgerEntry | undefined): StonkIndexRow {
  return {
    mint: t.mint,
    symbol: t.symbol,
    name: t.name,
    quoteMint: t.quote?.mint ?? l?.quote?.mint ?? '',
    quoteSymbol: t.quote?.symbol ?? l?.quote?.symbol ?? '',
    quoteDecimals: l?.quote?.decimals ?? t.quote?.decimals ?? null,
    quoteCategory: normalizeCategory(t.quote?.category),
    quoteCategoryRaw: t.quote?.category ?? 'unknown',
    launchpad: t.launchpad,
    mode: t.mode,
    bps: t.transferFee?.bps ?? null,
    flywheelActive: t.flywheel?.active === true,
    priceUsd: Number(t.market?.priceUsd ?? 0),
    marketCapUsd: Number(t.market?.marketCapUsd ?? 0),
    volume24hUsd: Number(t.market?.volume24hUsd ?? 0),
    priceChange24h: t.market?.priceChange24h ?? null,
    status: t.status,
    createdAt: t.createdAt,
    graduatedAt: t.graduatedAt ?? null,
    distributedTokens: Number(l?.distributedTokens ?? 0),
    distributedRaw: l?.distributedRaw ?? null,
    payoutCount: Number(l?.payoutCount ?? 0),
    holderCount: Number(l?.holderCount ?? 0),
    lastPayoutAt: l?.lastPayoutAt ?? null,
  };
}
