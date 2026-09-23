import type { DayPoint, StonkIndex, StonkIndexRow } from './stonk-index';
import { hoursSince, payoutStatus, type PayoutStatus } from './stonk-gems';

// What changed for a holder's StonkFun reward coins since the last check. Everything comes from the ten-minute
// index and its daily snapshots, so a watchlist of 25 coins answers in milliseconds and can be polled hourly.
// Payout amounts are only as precise as the daily snapshots: `rewards_since` names the snapshot it measured from.

export type StonkAlertType = 'payout_landed' | 'payout_stale' | 'stopped_trading' | 'holders_change' | 'rewards_since';
export type StonkAlertSeverity = 'high' | 'medium' | 'low';

export interface StonkAlert {
  type: StonkAlertType;
  severity: StonkAlertSeverity;
  mint: string;
  symbol: string | null;
  summary: string;
  data: Record<string, unknown>;
}

export interface StonkAlertCoin {
  mint: string;
  symbol: string | null;
  quote_symbol: string;
  payout_status: PayoutStatus;
  last_payout_at: string | null;
  hours_since_last_payout: number | null;
  volume_24h_usd: number;
  holder_count: number;
  market_cap_usd: number;
}

export interface StonkAlertsResult {
  since: string;
  /** Set when `since` was older than the snapshot history and was moved forward. */
  since_clamped_from: string | null;
  checked_at: string;
  alerts: StonkAlert[];
  coins: StonkAlertCoin[];
  /** Mints the index has never seen (not a reward coin, or no trade since the index started). */
  not_found: string[];
  counts_by_type: Partial<Record<StonkAlertType, number>>;
  counts_by_severity: Record<StonkAlertSeverity, number>;
  index: { rows: number; last_refresh_at: string | null; series_days: number };
  caveats: string[];
  next_steps: string[];
}

export interface StonkAlertCriteria {
  /** holders_change fires at this % move (either way) since the snapshot nearest to `since`. Default 10. */
  minHoldersChangePct: number;
  /** payout_stale fires when this many hours pass without a payout, inside the window. Default 24. */
  staleAfterHours: number;
}

export const STONK_ALERTS_MAX_LOOKBACK_DAYS = 31;
export const DEFAULT_STONK_ALERT_CRITERIA: StonkAlertCriteria = { minHoldersChangePct: 10, staleAfterHours: 24 };

/** The snapshot to measure a change from: the latest one at or before `since`, else the earliest after it. */
export function baselinePoint(series: DayPoint[], sinceMs: number): DayPoint | null {
  if (!series.length) return null;
  const sorted = [...series].sort((a, b) => a.t - b.t);
  const before = sorted.filter((p) => p.t <= sinceMs);
  return before.length ? before[before.length - 1] : sorted[0];
}

/** Pure: the alerts for one coin. Exported for tests. */
export function detectStonkAlerts(
  row: StonkIndexRow,
  series: DayPoint[],
  quoteUsd: number | null,
  sinceMs: number,
  now: number,
  c: StonkAlertCriteria,
): StonkAlert[] {
  const out: StonkAlert[] = [];
  const who = row.symbol ? `$${row.symbol}` : row.mint.slice(0, 6);
  const base = { mint: row.mint, symbol: row.symbol ?? null };
  const lastPayout = row.lastPayoutAt ? Date.parse(row.lastPayoutAt) : NaN;

  if (Number.isFinite(lastPayout) && lastPayout > sinceMs) {
    const h = hoursSince(row.lastPayoutAt, now);
    out.push({ ...base, type: 'payout_landed', severity: 'low', summary: `${who} paid holders at ${row.lastPayoutAt} (${h}h ago), in ${row.quoteSymbol}`, data: { last_payout_at: row.lastPayoutAt, hours_ago: h, payout_count: row.payoutCount } });
  }

  // PAYING → STALE inside the window: the stale boundary (last payout + N hours) fell between since and now.
  if (Number.isFinite(lastPayout)) {
    const boundary = lastPayout + c.staleAfterHours * 3_600_000;
    if (boundary > sinceMs && boundary <= now) {
      out.push({ ...base, type: 'payout_stale', severity: 'high', summary: `${who} has not paid holders for ${c.staleAfterHours}h+ (last payout ${row.lastPayoutAt}); went stale at ${new Date(boundary).toISOString()}`, data: { last_payout_at: row.lastPayoutAt, stale_since: new Date(boundary).toISOString(), stale_after_hours: c.staleAfterHours } });
    }
  }

  if (row.volume24hUsd <= 0) {
    out.push({ ...base, type: 'stopped_trading', severity: 'high', summary: `${who} has no trades in the last 24h — no trades, no tax, no payouts`, data: { volume_24h_usd: 0 } });
  }

  const b = baselinePoint(series, sinceMs);
  if (b && b.holders > 0 && row.holderCount > 0) {
    const pct = ((row.holderCount - b.holders) / b.holders) * 100;
    if (Math.abs(pct) >= c.minHoldersChangePct) {
      const up = pct > 0;
      out.push({ ...base, type: 'holders_change', severity: up ? 'low' : 'medium', summary: `${who} holders ${up ? 'up' : 'down'} ${Math.abs(pct).toFixed(1)}% (${b.holders} → ${row.holderCount}) since ${new Date(b.t).toISOString().slice(0, 10)}`, data: { from: b.holders, to: row.holderCount, change_pct: Math.round(pct * 10) / 10, measured_from: new Date(b.t).toISOString() } });
    }
  }

  if (b) {
    const delta = row.distributedTokens - b.dist;
    if (delta > 0) {
      const usd = quoteUsd != null ? Math.round(delta * quoteUsd * 100) / 100 : null;
      const approx = Math.abs(b.t - sinceMs) > 3_600_000;
      out.push({ ...base, type: 'rewards_since', severity: 'low', summary: `${who} paid ${delta.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${row.quoteSymbol}${usd != null ? ` (≈$${usd.toLocaleString()})` : ''} to holders since ${new Date(b.t).toISOString()}${approx ? ' (nearest daily snapshot)' : ''}`, data: { rewards_quote: delta, rewards_usd: usd, quote_symbol: row.quoteSymbol, measured_from: new Date(b.t).toISOString(), approximate: approx } });
    }
  }
  return out;
}

export class StonkAlertChecker {
  constructor(private readonly index: StonkIndex) {}

  check(mints: string[], since: string, criteria: Partial<StonkAlertCriteria> = {}, now = Date.now()): StonkAlertsResult {
    const c = { ...DEFAULT_STONK_ALERT_CRITERIA, ...criteria };
    const status = this.index.status();
    const caveats: string[] = [];
    let sinceMs = Date.parse(since);
    let clampedFrom: string | null = null;
    const floor = now - STONK_ALERTS_MAX_LOOKBACK_DAYS * 86_400_000;
    if (sinceMs < floor) {
      clampedFrom = since;
      sinceMs = floor;
      caveats.push(`since was older than the ${STONK_ALERTS_MAX_LOOKBACK_DAYS}-day snapshot history; moved to ${new Date(floor).toISOString()}.`);
    }
    if (sinceMs > now) sinceMs = now;

    const alerts: StonkAlert[] = [];
    const coins: StonkAlertCoin[] = [];
    const notFound: string[] = [];
    for (const mint of [...new Set(mints)]) {
      const row = this.index.getRow(mint);
      if (!row) { notFound.push(mint); continue; }
      alerts.push(...detectStonkAlerts(row, this.index.getSeries(mint), this.index.getQuoteUsd(row.quoteMint), sinceMs, now, c));
      coins.push({
        mint,
        symbol: row.symbol ?? null,
        quote_symbol: row.quoteSymbol,
        payout_status: payoutStatus(row, now),
        last_payout_at: row.lastPayoutAt,
        hours_since_last_payout: hoursSince(row.lastPayoutAt, now),
        volume_24h_usd: Math.round(row.volume24hUsd),
        holder_count: row.holderCount,
        market_cap_usd: Math.round(row.marketCapUsd),
      });
    }
    const order: Record<StonkAlertSeverity, number> = { high: 0, medium: 1, low: 2 };
    alerts.sort((a, b) => order[a.severity] - order[b.severity]);

    if (status.rows === 0) caveats.unshift('index is warming up after a restart — rows fill in within a minute; re-check shortly');
    caveats.push('rewards_since and holders_change measure from the daily snapshot nearest to `since` (see measured_from); windows under a day are approximate.');
    if (notFound.length) caveats.push(`${notFound.length} mint(s) not in the index — not a reward coin, or no trade since the index started tracking it.`);

    const countsByType: Partial<Record<StonkAlertType, number>> = {};
    const countsBySeverity: Record<StonkAlertSeverity, number> = { high: 0, medium: 0, low: 0 };
    for (const a of alerts) { countsByType[a.type] = (countsByType[a.type] ?? 0) + 1; countsBySeverity[a.severity]++; }

    return {
      since: new Date(sinceMs).toISOString(),
      since_clamped_from: clampedFrom,
      checked_at: new Date(now).toISOString(),
      alerts,
      coins,
      not_found: notFound,
      counts_by_type: countsByType,
      counts_by_severity: countsBySeverity,
      index: { rows: status.rows, last_refresh_at: status.lastRefreshAt, series_days: status.seriesDays },
      caveats,
      next_steps: [
        'Pass checked_at as `since` on the next poll to see only new events.',
        'stonk-reward-risk on a coin that went stale: is the tax still reaching holders?',
        'stonk-quote before adding to a position: does the payout still cover the round trip?',
      ],
    };
  }
}
