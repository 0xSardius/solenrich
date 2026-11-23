// StonkFun fidelity (audit 2026-11-14, Batch B): a coin missing from the rewards ledger is UNKNOWN, not NEVER;
// alerts do not miss payouts inside the ledger lag; a yield from two observations does not drive a verdict;
// top-10 concentration excludes the pool vault.
import { describe, expect, test } from 'bun:test';
import { toRow, type StonkIndexRow } from '../src/enrichers/stonk-index';
import { payoutStatus, scoreGem } from '../src/enrichers/stonk-gems';
import { StonkAlertChecker } from '../src/enrichers/stonk-alerts';
import { computeYield } from '../src/enrichers/stonk-yield';
import { pickYieldBasis } from '../src/enrichers/stonk-quote';
import { toScreenerRowOut } from '../src/entrypoints/stonk';
import { walletTop10Pct } from '../src/enrichers/stonk-reward-risk';

const NOW = Date.parse('2026-11-22T12:00:00.000Z');
const H = 3_600_000;
const D = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();

const token = (o: Record<string, unknown> = {}) => ({
  mint: 'MINT1', symbol: 'NEW', name: 'New', launchpad: 'launchlab', mode: 'reward', status: 'active',
  createdAt: iso(NOW - 20 * 60_000), graduatedAt: null, transferFee: { bps: 300 },
  quote: { mint: 'QZEC', symbol: 'ZEC', decimals: 8, category: 'custom' },
  market: { priceUsd: 0.00001, marketCapUsd: 9_000, volume24hUsd: 4_000, priceChange24h: 50 }, ...o,
}) as any;

describe('#22 a coin missing from the rewards ledger is UNKNOWN, not NEVER', () => {
  test('toRow without a ledger entry marks ledgerSeen false; with one, true', () => {
    expect(toRow(token(), undefined).ledgerSeen).toBe(false);
    const l = { mint: 'MINT1', distributedTokens: 1, payoutCount: 3, holderCount: 40, lastPayoutAt: iso(NOW - H) } as any;
    expect(toRow(token(), l).ledgerSeen).toBe(true);
  });
  test('payoutStatus UNKNOWN; a ledger row with 0 payouts is still NEVER', () => {
    expect(payoutStatus(toRow(token(), undefined), NOW)).toBe('UNKNOWN');
    const l = { mint: 'MINT1', distributedTokens: 0, payoutCount: 0, holderCount: 0, lastPayoutAt: null } as any;
    expect(payoutStatus(toRow(token(), l), NOW)).toBe('NEVER');
  });
  test('gems do not say "never paid" or "only 0 holders" for an unseen coin', () => {
    const g = scoreGem(toRow(token(), undefined), NOW, null);
    expect(g.warnings.some((w) => w.includes('never paid'))).toBe(false);
    expect(g.warnings.some((w) => w.includes('only 0'))).toBe(false);
    expect(g.warnings.some((w) => w.includes('ledger'))).toBe(true);
  });
  test('screener row: holder_count and payout_count null, ledger_seen false', () => {
    const r = toRow(token(), undefined);
    const out = toScreenerRowOut({ ...r, quoteUsd: null, rewardsUsd: null, ageDays: 0.01, yield7dPct: null, yield30dPct: null,
      window7dActualDays: null, window30dActualDays: null, roundTripPct: 6, hoursSinceLastPayout: null, payoutStatus: 'UNKNOWN', paying24h: false, live: false } as any, 1);
    expect(out.holder_count).toBeNull();
    expect(out.payout_count).toBeNull();
    expect(out.ledger_seen).toBe(false);
  });
});

describe('#26 alerts are measured as of the ledger load, not as of now', () => {
  const row = (o: Partial<StonkIndexRow>): StonkIndexRow => ({ ...toRow(token({ createdAt: iso(NOW - 5 * D) }), { mint: 'MINT1', distributedTokens: 5, payoutCount: 9, holderCount: 50, lastPayoutAt: iso(NOW - 2 * H) } as any), ...o });
  const index = (r: StonkIndexRow, ledgerAt: number) => ({
    status: () => ({ rows: 1, lastRefreshAt: iso(NOW - 60_000), seriesDays: 3, ledgerLoadedAt: iso(ledgerAt) }),
    getRow: () => r, getSeries: () => [], getQuoteUsd: () => 30,
  }) as any;
  test('checked_at = ledger load time, so the next poll covers the lag; index shows ledger_loaded_at', () => {
    const r = new StonkAlertChecker(index(row({}), NOW - 25 * 60_000)).check(['MINT1'], iso(NOW - 6 * H), {}, NOW);
    expect(r.checked_at).toBe(iso(NOW - 25 * 60_000));
    expect(r.index.ledger_loaded_at).toBe(iso(NOW - 25 * 60_000));
  });
  test('a stale boundary after the ledger load does not fire payout_stale (the coin may have paid since)', () => {
    // last payout 24h10m ago → boundary 10 min ago; the ledger is 25 min old, so the boundary is after it.
    const r = new StonkAlertChecker(index(row({ lastPayoutAt: iso(NOW - 24 * H - 10 * 60_000) }), NOW - 25 * 60_000)).check(['MINT1'], iso(NOW - 6 * H), {}, NOW);
    expect(r.alerts.some((a) => a.type === 'payout_stale')).toBe(false);
  });
});

describe('#24 top-10 concentration counts wallets, not the pool vault', () => {
  // A real wallet (on-curve) and a PDA (off-curve, e.g. the LaunchLab vault authority).
  const WALLET = 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg';
  const PDA = '5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq';
  const largest = [{ address: 'vault', amount: 700 }, { address: 'w1', amount: 50 }, { address: 'w2', amount: 30 }];
  test('the program-owned vault is excluded; wallets are summed', () => {
    const owners = [{ tokenAccount: 'vault', owner: PDA }, { tokenAccount: 'w1', owner: WALLET }, { tokenAccount: 'w2', owner: WALLET }];
    expect(walletTop10Pct(largest, owners, 1000)).toEqual({ pct: 8, basis: 'wallets', excluded_program_accounts: 1 });
  });
  test('owners not resolved → raw token-account sum, labelled so', () => {
    expect(walletTop10Pct(largest, null, 1000)).toEqual({ pct: 78, basis: 'token_accounts', excluded_program_accounts: 0 });
  });
  test('score: a vault-heavy coin no longer gets the -5 "rewards concentrate" warning when wallets hold 8%', () => {
    const owners = [{ tokenAccount: 'vault', owner: PDA }, { tokenAccount: 'w1', owner: WALLET }, { tokenAccount: 'w2', owner: WALLET }];
    expect(walletTop10Pct(largest, owners, 1000).pct).toBeLessThan(30);
  });
});

describe('#27 #25 lifetime yield needs three real market-cap observations', () => {
  const base = {
    mint: 'MINT1', symbol: 'NEW', name: 'New', mode: 'reward', launchMarketCapUsd: 3_250, marketCapUsd: 50_000,
    distributedTokens: 2, payoutCount: 30, holderCount: 80, lastPayoutAt: iso(NOW - H),
    quote: { mint: 'QZEC', symbol: 'ZEC', decimals: 8, categoryRaw: 'custom' }, quoteUsd: 30, now: NOW,
  };
  test('a 10-day coin whose only series point is today\'s seeded one → caution (2 real observations)', () => {
    const y = computeYield({ ...base, createdAt: iso(NOW - 10 * D), series: [{ t: NOW, dist: 2, marketCapUsd: 50_000, holders: 80 }] });
    expect(y.lifetime.caution).toBe(true);
    expect(y.lifetime.caution_reason).toContain('fewer than 3');
    expect(y.lifetime.mcap_observations).toBe(2);
  });
  test('earlier daily points count: launch + 2 past days + now = 4', () => {
    const y = computeYield({ ...base, createdAt: iso(NOW - 10 * D), series: [
      { t: NOW - 2 * D, dist: 1, marketCapUsd: 20_000, holders: 50 }, { t: NOW - D, dist: 1.5, marketCapUsd: 30_000, holders: 60 }, { t: NOW, dist: 2, marketCapUsd: 50_000, holders: 80 }] });
    expect(y.lifetime.mcap_observations).toBe(4);
    expect(y.lifetime.caution).toBe(false);
  });
  test('stonk-quote does not project from a lifetime window with fewer than 3 observations', () => {
    const y = computeYield({ ...base, createdAt: iso(NOW - 10 * D), series: [{ t: NOW, dist: 2, marketCapUsd: 50_000, holders: 80 }] });
    expect(pickYieldBasis(y).basis).toBeNull();
  });
});
