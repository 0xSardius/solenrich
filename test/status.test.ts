/**
 * /status verdict rules (A3, 2026-09-20). Pure function, no network.
 * Run: bun test test/status.test.ts
 */
import { describe, test, expect } from 'bun:test';
import { computeStatus, RECENT_WINDOW_MS, INDEX_STALE_MS, BOOT_GRACE_SEC, type StatusInputs } from '../src/lib/status';

const NOW = Date.parse('2026-09-20T12:00:00Z');
const healthy = (over: Partial<StatusInputs> = {}): StatusInputs => ({
  now: NOW,
  uptime_sec: 3600,
  payments_enabled: true,
  facilitator: 'ok',
  last_settlement_failure_at: null,
  settlement_failures_today: 0,
  last_settle_first_loss_at: null,
  settle_first_losses_today: 0,
  redis: 'ok',
  index_rows: 8000,
  index_last_refresh_at: NOW - 4 * 60_000,
  index_last_error: null,
  ...over,
});

describe('computeStatus', () => {
  test('healthy production is ok / 200 with no reasons', () => {
    expect(computeStatus(healthy())).toEqual({ verdict: 'ok', http: 200, reasons: [] });
  });

  test('facilitator unreachable is down / 503 — no payment can settle', () => {
    const v = computeStatus(healthy({ facilitator: 'unreachable' }));
    expect(v.verdict).toBe('down');
    expect(v.http).toBe(503);
    expect(v.reasons[0]).toContain('facilitator unreachable');
  });

  test('facilitator unreachable with payments disabled (local dev) is not down', () => {
    const v = computeStatus(healthy({ payments_enabled: false, facilitator: 'disabled' }));
    expect(v.verdict).toBe('ok');
  });

  test('facilitator probe timeout is a note, not a verdict change', () => {
    const v = computeStatus(healthy({ facilitator: 'unknown' }));
    expect(v.verdict).toBe('ok');
    expect(v.reasons.some((r) => r.includes('timed out'))).toBe(true);
  });

  test('redis error is down; memory mode in production is degraded', () => {
    expect(computeStatus(healthy({ redis: 'error' })).verdict).toBe('down');
    const mem = computeStatus(healthy({ redis: 'memory' }));
    expect(mem.verdict).toBe('degraded');
    expect(computeStatus(healthy({ redis: 'memory', payments_enabled: false, facilitator: 'disabled' })).verdict).toBe('ok');
  });

  test('a refused settlement inside 15 min is degraded; older than that is not', () => {
    const recent = computeStatus(healthy({ last_settlement_failure_at: NOW - RECENT_WINDOW_MS + 1000, settlement_failures_today: 3 }));
    expect(recent.verdict).toBe('degraded');
    expect(recent.reasons[0]).toContain('3 today');
    const old = computeStatus(healthy({ last_settlement_failure_at: NOW - RECENT_WINDOW_MS - 1000, settlement_failures_today: 3 }));
    expect(old.verdict).toBe('ok');
  });

  test('a settle-first loss inside 15 min is degraded', () => {
    const v = computeStatus(healthy({ last_settle_first_loss_at: NOW - 60_000, settle_first_losses_today: 1 }));
    expect(v.verdict).toBe('degraded');
    expect(v.reasons[0]).toContain('paid for an error');
  });

  test('empty index inside boot grace is a note; after grace it is degraded', () => {
    const booting = computeStatus(healthy({ index_rows: 0, index_last_refresh_at: null, uptime_sec: 60 }));
    expect(booting.verdict).toBe('ok');
    expect(booting.reasons[0]).toContain('warming up');
    const stuck = computeStatus(healthy({ index_rows: 0, index_last_refresh_at: null, uptime_sec: BOOT_GRACE_SEC + 1, index_last_error: 'stonkfun 503' }));
    expect(stuck.verdict).toBe('degraded');
    expect(stuck.reasons[0]).toContain('stonkfun 503');
  });

  test('stale index (older than 30 min) is degraded with the age in minutes', () => {
    const v = computeStatus(healthy({ index_last_refresh_at: NOW - INDEX_STALE_MS - 5 * 60_000 }));
    expect(v.verdict).toBe('degraded');
    expect(v.reasons[0]).toContain('35 min ago');
  });

  test('down wins over degraded and all reasons are listed', () => {
    const v = computeStatus(healthy({ facilitator: 'unreachable', index_last_refresh_at: NOW - INDEX_STALE_MS - 60_000 }));
    expect(v.verdict).toBe('down');
    expect(v.reasons).toHaveLength(2);
  });
});
