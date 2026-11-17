// Wallet profile fidelity (audit 2026-11-17, step 3): wallet age from real history, no penalty for unmeasured
// factors, dormant from the last tx, and the published risk levels match the code.
import { describe, expect, test } from 'bun:test';
import { walletHistory } from '../src/enrichers/wallet-profiler';
import { scoreWalletRisk, getRiskLevel, riskLevelRanges, RISK_LEVELS } from '../src/enrichers/risk-scorer';
import { labelWallet } from '../src/enrichers/labeler';

const NOW = Date.parse('2026-11-17T12:00:00Z') / 1000;
const DAY = 86400;
const sigs = (ageDaysNewestFirst: number[]) => ageDaysNewestFirst.map((d, i) => ({ signature: `s${i}`, blockTime: NOW - d * DAY }));

describe('walletHistory', () => {
  test('busy wallet, cap hit: first_tx_date null, lower bound set, no age (was "created 5 days ago")', () => {
    const h = walletHistory(sigs(Array.from({ length: 500 }, (_, i) => i / 100)), false, NOW); // 500 txs in 5 days
    expect(h.first_tx_date).toBeNull();
    expect(h.first_seen_at_least).toBe(new Date((NOW - 4.99 * DAY) * 1000).toISOString());
    expect(h.wallet_age_days).toBeNull();
    expect(h.history_complete).toBe(false);
    expect(h.tx_count_30d).toBe(500);
    expect(h.tx_count_30d_capped).toBe(true);
  });
  test('complete history: first tx is the oldest signature', () => {
    const h = walletHistory(sigs([1, 10, 400]), true, NOW);
    expect(h.first_tx_date).toBe(new Date((NOW - 400 * DAY) * 1000).toISOString());
    expect(h.wallet_age_days).toBe(400);
    expect(h.tx_count_30d).toBe(2);
    expect(h.tx_count_30d_capped).toBe(false);
    expect(h.last_tx_date).toBe(new Date((NOW - DAY) * 1000).toISOString());
  });
  test('a cached first-tx date gives the age even when the pages stop early', () => {
    const h = walletHistory(sigs([0, 1, 40]), false, NOW, '2022-04-15T22:36:10.000Z');
    expect(h.first_tx_date).toBe('2022-04-15T22:36:10.000Z');
    expect(h.wallet_age_days).toBeGreaterThan(1600);
    expect(h.tx_count_30d_capped).toBe(false); // the read reached past the 30-day window
  });
  test('failed signature read: everything unknown, nothing invented', () => {
    const h = walletHistory([], false, NOW);
    expect(h).toMatchObject({ first_tx_date: null, first_seen_at_least: null, wallet_age_days: null, tx_count_30d: 0, history_complete: false });
  });
  test('brand-new wallet with no transactions is complete, age unknown', () => {
    expect(walletHistory([], true, NOW).history_complete).toBe(true);
  });
});

describe('scoreWalletRisk: unmeasured factors are not scored', () => {
  const base = { concentration: 90, flagged_associations: 0, labels: [] as string[] };
  test('light profile (diversity, breadth unmeasured; age known): only measured factors', () => {
    const r = scoreWalletRisk({ ...base, wallet_age_days: 1600, tx_diversity: null, protocol_breadth: null });
    expect(r.score).toBeCloseTo(0.2, 6);
    expect(r.factors).toEqual(['Over 80% of portfolio in single holding']);
  });
  test('unknown age adds no age factor', () => {
    expect(scoreWalletRisk({ ...base, concentration: 0, wallet_age_days: null }).score).toBe(0);
  });
  test('measured values still score', () => {
    const r = scoreWalletRisk({ ...base, concentration: 0, wallet_age_days: 3, tx_diversity: 0.05, protocol_breadth: 1 });
    expect(r.score).toBeCloseTo(0.35, 6);
  });
});

describe('labeler', () => {
  const base = { balance_sol: 0, portfolio_value_usd: 0, token_count: 0, nft_count: 0, tx_count_30d: 0, defi_positions: [], top_holdings: [],
    swap_count_30d: 0, daily_tx_counts: [], protocols_interacted: [], stablecoin_pct: 0 };
  const ago = (d: number) => new Date(Date.now() - d * DAY * 1000).toISOString();
  test('dormant uses the LAST tx: old wallet active 40 days ago is not dormant', () => {
    expect(labelWallet({ ...base, first_tx_date: ago(900), last_tx_date: ago(40) })).not.toContain('dormant');
    expect(labelWallet({ ...base, first_tx_date: ago(900), last_tx_date: ago(200) })).toContain('dormant');
  });
  test('no new_wallet label when the first tx is unknown', () => {
    expect(labelWallet({ ...base, tx_count_30d: 100, first_tx_date: null, last_tx_date: ago(0) })).not.toContain('new_wallet');
  });
});

describe('published risk levels match getRiskLevel', () => {
  test('every boundary in RISK_LEVELS maps to its level, and /docs ranges name the same bounds', () => {
    for (const [level, min] of RISK_LEVELS) expect(getRiskLevel(min)).toBe(level);
    expect(getRiskLevel(0.199)).toBe('LOW');
    expect(getRiskLevel(0.79)).toBe('HIGH');
    expect(riskLevelRanges()).toEqual({ LOW: '< 0.2', MODERATE: '0.2 – 0.4', ELEVATED: '0.4 – 0.6', HIGH: '0.6 – 0.8', CRITICAL: '≥ 0.8' });
  });
});
