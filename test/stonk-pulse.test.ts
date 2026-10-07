// Unit tests for stonk-market-pulse (src/enrichers/stonk-pulse.ts): breadth, verdict, shelves, population, revenue.
import { describe, test, expect } from 'bun:test';
import { livePulse, pulseVerdict, shelfPulse, populationPulse, revenuePulse } from '../src/enrichers/stonk-pulse';
import type { StonkIndexRow } from '../src/enrichers/stonk-index';
import type { QuoteStats } from '../src/enrichers/stonk-gems';

const NOW = Date.parse('2026-10-06T12:00:00Z');
const row = (change: number | null, vol = 1_000, quote = 'PEPE', paidHoursAgo: number | null = 2): StonkIndexRow => ({
  mint: Math.random().toString(36), symbol: 'X', name: 'X', quoteMint: 'Q', quoteSymbol: quote, quoteDecimals: 4, quoteCategory: 'crypto' as never,
  quoteCategoryRaw: 'crypto', launchpad: 'launchlab', mode: 'reward', bps: 300, flywheelActive: false, priceUsd: 1, marketCapUsd: 10_000,
  volume24hUsd: vol, priceChange24h: change, status: 'new', createdAt: '', graduatedAt: null, distributedTokens: 0, distributedRaw: null,
  payoutCount: 1, holderCount: 10, lastPayoutAt: paidHoursAgo == null ? null : new Date(NOW - paidHoursAgo * 3_600_000).toISOString(),
});

describe('livePulse', () => {
  test('breadth, median and volume-weighted move; coins without a change are counted but not measured', () => {
    const rows = [row(10, 9_000), row(-2), row(-4), row(1), row(null)];
    const l = livePulse(rows, NOW);
    expect(l.coins).toBe(5);
    expect(l.coins_with_change).toBe(4);
    expect(l.breadth_pct).toBe(50);
    expect(l.median_change_pct).toBe(-2);
    expect(l.volume_weighted_change_pct).toBeCloseTo((10 * 9000 - 2000 - 4000 + 1000) / 12_000, 1);
    expect(l.paying_24h_pct).toBe(100);
  });
});

describe('pulseVerdict', () => {
  const base = livePulse([row(1)], NOW);
  test('RISK_OFF on a falling median or thin breadth', () => {
    expect(pulseVerdict({ ...base, median_change_pct: -6, breadth_pct: 45 })).toBe('RISK_OFF');
    expect(pulseVerdict({ ...base, median_change_pct: 0, breadth_pct: 25 })).toBe('RISK_OFF');
  });
  test('RISK_ON needs both a rising median and broad gains', () => {
    expect(pulseVerdict({ ...base, median_change_pct: 3, breadth_pct: 60 })).toBe('RISK_ON');
    expect(pulseVerdict({ ...base, median_change_pct: 3, breadth_pct: 50 })).toBe('NEUTRAL');
  });
  test('2026-10-06 values (breadth 40%, median −1.7%) read NEUTRAL', () => {
    expect(pulseVerdict({ ...base, median_change_pct: -1.7, breadth_pct: 40.2 })).toBe('NEUTRAL');
  });
});

describe('shelfPulse', () => {
  test('shelves under 15 live coins are left out; strongest and weakest by median', () => {
    const rows = [
      ...Array.from({ length: 15 }, () => row(5, 1_000, 'GOOD')),
      ...Array.from({ length: 15 }, () => row(-8, 1_000, 'BAD')),
      ...Array.from({ length: 5 }, () => row(50, 1_000, 'TINY')),
    ];
    const s = shelfPulse(rows);
    expect(s.strongest[0].quote).toBe('GOOD');
    expect(s.weakest[0].quote).toBe('BAD');
    expect([...s.strongest, ...s.weakest].some((x) => x.quote === 'TINY')).toBe(false);
  });
});

describe('populationPulse', () => {
  test('sums per-quote stats and weights survival by coins older than 3 days', () => {
    const q = (coins: number, older: number, survival: number | null): QuoteStats => ({
      quote_mint: 'Q', quote_symbol: 'Q', quote_category: 'crypto' as never, coins, launches_24h: 10, launches_7d: 70, traded_24h: coins / 10,
      traded_share_24h: 0.1, paying_24h: coins / 20, paying_share_24h: 0.05, survival_3d: survival, older_than_3d: older, live_24h: 0,
      volume_24h_usd: 0, holders_total: 0, holders_median: 0, market_cap_median_usd: 0, tax_mix: { bps_100: 0, bps_300: 0, other: 0 },
      paying_by_tax: { bps_100: null, bps_300: null }, traded_by_tax: { bps_100: null, bps_300: null }, crowding: null, is_new: false, demand_score: 0,
    });
    const p = populationPulse([q(1000, 800, 0.05), q(1000, 200, 0.2)], 'population')!;
    expect(p.coins).toBe(2000);
    expect(p.launches_24h).toBe(20);
    expect(p.traded_24h_pct).toBe(10);
    expect(p.survival_3d_pct).toBe(8); // (0.05·800 + 0.2·200) / 1000
  });
});

describe('revenuePulse', () => {
  test('last 7 complete days vs the 7 before; today is left out', () => {
    const days = Array.from({ length: 15 }, (_, i) => ({ date: new Date(NOW - (14 - i) * 86_400_000).toISOString().slice(0, 10), total_usd: 100, holders_usd: i < 7 ? 50 : 100 }));
    const r = revenuePulse(days, NOW)!;
    expect(r.last_7d).toHaveLength(7);
    expect(r.last_7d.at(-1)!.date < '2026-10-06').toBe(true);
    expect(r.holders_7d_usd).toBe(700);
    expect(r.holders_prior_7d_usd).toBe(350);
    expect(r.holders_change_pct).toBe(100);
  });
  test('too little history → null', () => {
    expect(revenuePulse([{ date: '2026-10-01', total_usd: 1, holders_usd: 1 }], NOW)).toBeNull();
  });
});
