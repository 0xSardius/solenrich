/**
 * /status verdict rules (A3, 2026-09-20). Pure: agent.ts gathers the inputs,
 * this decides ok / degraded / down and the HTTP code an uptime checker keys on.
 *
 * "Can SolEnrich take money right now?" is the question. /health (Lucid SDK)
 * only says the process is up — it said that for all five days of the CDP
 * free-tier outage.
 */
export type FacilitatorState = 'ok' | 'unreachable' | 'unknown' | 'disabled';
export type RedisState = 'ok' | 'error' | 'memory';

export interface StatusInputs {
  now: number;
  uptime_sec: number;
  payments_enabled: boolean;
  facilitator: FacilitatorState;
  /** ms timestamp of the last refused settlement, if any. */
  last_settlement_failure_at: number | null;
  settlement_failures_today: number;
  /** ms timestamp of the last paid-then-failed handler, if any. */
  last_settle_first_loss_at: number | null;
  settle_first_losses_today: number;
  redis: RedisState;
  index_rows: number;
  index_last_refresh_at: number | null;
  index_last_error: string | null;
}

export interface StatusVerdict {
  verdict: 'ok' | 'degraded' | 'down';
  http: 200 | 503;
  reasons: string[];
}

/** A refused settlement or paid error inside this window marks the service degraded. */
export const RECENT_WINDOW_MS = 15 * 60 * 1000;
/** The StonkFun index refreshes every 10 min; older than this is stale. */
export const INDEX_STALE_MS = 30 * 60 * 1000;
/** After boot the index needs about a minute; do not call it stale before this. */
export const BOOT_GRACE_SEC = 5 * 60;

export function computeStatus(i: StatusInputs): StatusVerdict {
  const reasons: string[] = [];
  let down = false;
  let degraded = false;

  if (i.payments_enabled && i.facilitator === 'unreachable') {
    down = true;
    reasons.push('facilitator unreachable — no payment can settle');
  }
  if (i.redis === 'error') {
    down = true;
    reasons.push('redis unreachable — cache, metrics, and stonk snapshots are off');
  }
  if (i.payments_enabled && i.redis === 'memory') {
    degraded = true;
    reasons.push('cache in memory mode in production');
  }
  if (i.last_settlement_failure_at != null && i.now - i.last_settlement_failure_at <= RECENT_WINDOW_MS) {
    degraded = true;
    reasons.push(`settlement refused in the last 15 min (${i.settlement_failures_today} today)`);
  }
  if (i.last_settle_first_loss_at != null && i.now - i.last_settle_first_loss_at <= RECENT_WINDOW_MS) {
    degraded = true;
    reasons.push(`a buyer paid for an error in the last 15 min (${i.settle_first_losses_today} today)`);
  }
  const pastGrace = i.uptime_sec > BOOT_GRACE_SEC;
  if (i.index_rows === 0) {
    if (pastGrace) {
      degraded = true;
      reasons.push(`stonk index empty after boot${i.index_last_error ? `: ${i.index_last_error}` : ''}`);
    } else {
      reasons.push('stonk index warming up (boot grace)');
    }
  } else if (i.index_last_refresh_at != null && i.now - i.index_last_refresh_at > INDEX_STALE_MS) {
    degraded = true;
    const min = Math.round((i.now - i.index_last_refresh_at) / 60_000);
    reasons.push(`stonk index stale: last refresh ${min} min ago${i.index_last_error ? ` (${i.index_last_error})` : ''}`);
  }
  if (i.payments_enabled && i.facilitator === 'unknown') {
    reasons.push('facilitator check timed out — payments state unknown');
  }

  const verdict = down ? 'down' : degraded ? 'degraded' : 'ok';
  return { verdict, http: verdict === 'ok' ? 200 : 503, reasons };
}
