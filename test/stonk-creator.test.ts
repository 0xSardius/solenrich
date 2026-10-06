// Unit tests for the stonk-creator verdict (src/enrichers/stonk-creator.ts, buildCreatorReport).
// Shapes follow the live run of 2026-10-05 (local/scripts/stonk-creator-live.ts).
import { describe, test, expect } from 'bun:test';
import { buildCreatorReport } from '../src/enrichers/stonk-creator';
import type { StonkLaunch } from '../src/sources/stonkfun';
import type { StonkIndexRow } from '../src/enrichers/stonk-index';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const H = 3_600_000;
let n = 0;
const launch = (hoursAgo: number): StonkLaunch => ({
  mint: `M${++n}`, pool: 'P', name: `Coin ${n}`, symbol: `C${n}`, creator: 'CR', quote: { mint: 'Q', symbol: 'PEPE' },
  launchpad: 'launchlab', mode: 'reward', transferFee: { bps: 300 }, createdAt: new Date(NOW - hoursAgo * H).toISOString(),
});
const alive = (mint: string, opts: Partial<StonkIndexRow> = {}): [string, StonkIndexRow] => [mint, {
  mint, symbol: mint, name: mint, quoteMint: 'Q', quoteSymbol: 'PEPE', quoteDecimals: 4, quoteCategory: 'crypto' as never, quoteCategoryRaw: 'crypto',
  launchpad: 'launchlab', mode: 'reward', bps: 300, flywheelActive: false, priceUsd: 1, marketCapUsd: 50_000, volume24hUsd: 2_000,
  priceChange24h: 0, status: 'new', createdAt: '', graduatedAt: null, distributedTokens: 1, distributedRaw: null, payoutCount: 5,
  holderCount: 40, lastPayoutAt: new Date(NOW - 2 * H).toISOString(), ...opts,
}];

describe('buildCreatorReport', () => {
  test('many launches a day and almost none surviving → SERIAL_LAUNCHER', () => {
    const ls = [...Array.from({ length: 30 }, () => launch(2)), ...Array.from({ length: 40 }, () => launch(100))];
    const rows = new Map([alive(ls[30].mint)]); // 1 of 40 matured alive = 3%
    const r = buildCreatorReport('CR', ls, 4946, rows, NOW);
    expect(r.verdict).toBe('SERIAL_LAUNCHER');
    expect(r.launches.last_24h).toBe(30);
    expect(r.matured.still_trading_pct).toBe(3);
    expect(r.launches.complete).toBe(false);
  });

  test('several matured coins and a third or more still trading → ESTABLISHED', () => {
    const ls = Array.from({ length: 5 }, () => launch(200));
    const rows = new Map([alive(ls[0].mint, { marketCapUsd: 900_000 }), alive(ls[1].mint)]);
    const r = buildCreatorReport('CR', ls, 5, rows, NOW);
    expect(r.verdict).toBe('ESTABLISHED');
    expect(r.matured).toEqual({ count: 5, still_trading: 2, still_trading_pct: 40, paying_24h: 2 });
    expect(r.living.best_market_cap_usd).toBe(900_000);
    expect(r.coins[0].mint).toBe(ls[0].mint); // living coins first, biggest first
  });

  test('one coin, dead or alive, is NEW — too little history to judge', () => {
    const dead = buildCreatorReport('CR', [launch(100)], 1, new Map(), NOW);
    expect(dead.verdict).toBe('NEW');
    const l = launch(100);
    const hit = buildCreatorReport('CR', [l], 1, new Map([alive(l.mint, { marketCapUsd: 888_087 })]), NOW);
    expect(hit.verdict).toBe('NEW');
    expect(hit.evidence.join(' ')).toContain('1 of 1 coins older than 3 days still trade');
  });

  test('serial volume with no coin old enough yet → SERIAL_LAUNCHER, not NEW', () => {
    const ls = Array.from({ length: 12 }, () => launch(3));
    expect(buildCreatorReport('CR', ls, 12, new Map(), NOW).verdict).toBe('SERIAL_LAUNCHER');
  });

  test('a moderate creator with low survival → MIXED', () => {
    const ls = Array.from({ length: 4 }, () => launch(150));
    const r = buildCreatorReport('CR', ls, 4, new Map([alive(ls[0].mint)]), NOW);
    expect(r.verdict).toBe('MIXED');
  });

  test('a coin in the index with no 24 h volume does not count as alive', () => {
    const ls = Array.from({ length: 3 }, () => launch(150));
    const r = buildCreatorReport('CR', ls, 3, new Map([alive(ls[0].mint, { volume24hUsd: 0 })]), NOW);
    expect(r.matured.still_trading).toBe(0);
  });

  test('a partial index is reported in coverage and evidence', () => {
    const ls = Array.from({ length: 3 }, () => launch(150));
    const r = buildCreatorReport('CR', ls, 3, new Map(), NOW, '57/64 pages');
    expect(r.coverage.index_partial).toBe('57/64 pages');
    expect(r.evidence.join(' ')).toContain('partial');
  });
});
