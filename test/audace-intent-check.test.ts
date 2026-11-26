/**
 * audace-intent-check decision rules. Pure functions, no network.
 * Run: bun test test/audace-intent-check.test.ts
 */
import { describe, test, expect } from 'bun:test';
import {
  decideIntent, intentDirection, legsNeeded, nextSaturdayUtc, defaultSeasonEndUtc, impactAtSize, USDC_MINT,
  AudaceIntentChecker, type IntentLegs,
} from '../src/enrichers/audace-intent-check';
import { AudaceIntentCheckInput } from '../src/schemas/audace';

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const NOW = Date.parse('2026-11-11T12:00:00.000Z'); // a Wednesday
const ENDS = '2026-11-14T10:00:00.000Z';

const input = (over: Record<string, unknown> = {}) =>
  AudaceIntentCheckInput.parse({ category: 'degen', tokenInMint: USDC_MINT, tokenOutMint: BONK, amountIn: 25, seasonEndsAt: ENDS, ...over });

const risk = (flags: string[] = [], extra: Record<string, unknown> = {}) => ({ symbol: 'Bonk', price_usd: 0.00002, liquidity: 500_000, risk_flags: flags, ...extra }) as any;
const signal = (verdict: string) => ({ symbol: 'Bonk', verdict, reasoning: 'sig' }) as any;
const exit = (verdict: string, price = 0.00002) => ({ symbol: 'Bonk', verdict, exit_score: 0.4, price_usd: price, reasoning: 'tape' }) as any;
const cleanBuy: IntentLegs = { risk: risk(['unverified']), signal: signal('HIGH_CONFLUENCE'), buyMomentum: exit('HOLD') };

describe('direction and clock helpers', () => {
  test('USDC in = buy, USDC out = sell, else swap', () => {
    expect(intentDirection(USDC_MINT, BONK)).toBe('buy');
    expect(intentDirection(BONK, USDC_MINT)).toBe('sell');
    expect(intentDirection(BONK, JUP)).toBe('swap');
  });

  test('next Saturday 10:00 UTC, including from a Saturday before and after 10:00', () => {
    expect(nextSaturdayUtc(NOW)).toBe(ENDS);
    expect(nextSaturdayUtc(Date.parse('2026-11-14T09:59:00.000Z'))).toBe(ENDS);
    expect(nextSaturdayUtc(Date.parse('2026-11-14T10:00:00.000Z'))).toBe('2026-11-21T10:00:00.000Z');
    expect(nextSaturdayUtc(Date.parse('2026-11-13T23:59:00.000Z'))).toBe(ENDS);
  });

  test('default season end = the league schedule Monday 10:00 → Saturday 10:00 UTC — AudaceFi report 2026-11-22', () => {
    // Jordan, Nov 22: Season 3 ends Nov 28 10:00 UTC; we returned 2026-11-28T00:00Z (10 h early).
    expect(defaultSeasonEndUtc(Date.parse('2026-11-22T15:20:00.000Z'))).toBe('2026-11-28T10:00:00.000Z');
    expect(defaultSeasonEndUtc(Date.parse('2026-11-24T10:00:00.000Z'))).toBe('2026-11-28T10:00:00.000Z');
    expect(defaultSeasonEndUtc(Date.parse('2026-11-28T10:00:00.000Z'))).toBe('2026-12-05T10:00:00.000Z');
    const r = decideIntent(input({ seasonEndsAt: undefined }), cleanBuy, Date.parse('2026-11-22T15:20:00.000Z'));
    expect(r.season).toMatchObject({ ends_at: '2026-11-28T10:00:00.000Z', ends_at_source: 'default_saturday' });
    expect(r.caveats.join(' ')).toContain('Saturday 10:00 UTC');
    expect(r.caveats.join(' ')).not.toContain('Season 1');
  });

  test('the checker uses the same default as decideIntent (was: a second default at Saturday 00:00)', async () => {
    // 2026-11-28 09:30 UTC: 30 min before the real 10:00 snapshot → inside the 60-min buffer → no upstream reads.
    let reads = 0;
    const stub = { enrich: async () => { reads++; return null; }, check: async () => { reads++; return null; }, analyze: async () => { reads++; return null; } } as any;
    const r = await new AudaceIntentChecker(stub, stub, stub).check(input({ seasonEndsAt: undefined }), Date.parse('2026-11-28T09:30:00.000Z'));
    expect(r.codes).toContain('SNAPSHOT_CLOCK');
    expect(reads).toBe(0);
  });

  test('legsNeeded: no reads inside the buffer; trenches only for Degen buys', () => {
    expect(legsNeeded('buy', 'degen', 30)).toEqual({ buy: false, signal: false, sell: false });
    expect(legsNeeded('buy', 'degen', 600)).toEqual({ buy: true, signal: true, sell: false });
    expect(legsNeeded('buy', 'whale', 600)).toEqual({ buy: true, signal: false, sell: false });
    expect(legsNeeded('sell', 'degen', 600)).toEqual({ buy: false, signal: false, sell: true });
    expect(legsNeeded('swap', 'crypto_bro', 600)).toEqual({ buy: true, signal: false, sell: true });
  });

  test('impactAtSize picks the smallest probed size that covers the trade', () => {
    const est = [{ size_usd: 100, price_impact_pct: 0.1 }, { size_usd: 1000, price_impact_pct: 1.2 }, { size_usd: 10000, price_impact_pct: 6 }] as any;
    expect(impactAtSize(est, 25)).toBe(0.1);
    expect(impactAtSize(est, 5000)).toBe(6);
    expect(impactAtSize(est, 50000)).toBe(6);
    expect(impactAtSize(undefined, 25)).toBeNull();
  });
});

describe('buys', () => {
  test('an unknown mint (no price, no liquidity, no tape) holds with TOKEN_NO_MARKET — AudaceFi report 2026-11-04', () => {
    const unknown: IntentLegs = { risk: risk(['unverified'], { symbol: null, price_usd: 0, liquidity: 0 }), buyMomentum: exit('INSUFFICIENT_DATA', 0) };
    const r = decideIntent(input({ category: 'crypto_bro', network: 'mainnet' }), unknown, NOW);
    expect([r.verdict, r.suggested_fraction]).toEqual(['HOLD', 0]);
    expect(r.codes).toEqual(['TOKEN_NO_MARKET', 'MOMENTUM_INSUFFICIENT_DATA']);
  });

  test('a priced token with no liquidity holds; INSUFFICIENT_DATA momentum alone holds', () => {
    expect(decideIntent(input({ category: 'whale' }), { risk: risk([], { liquidity: 0 }), buyMomentum: exit('HOLD') }, NOW).codes).toEqual(['TOKEN_NO_MARKET']);
    expect(decideIntent(input({ category: 'whale' }), { risk: risk(), buyMomentum: exit('INSUFFICIENT_DATA') }, NOW).codes).toEqual(['MOMENTUM_INSUFFICIENT_DATA']);
  });

  test('a traded bonding-curve token with unreported liquidity is LIQUIDITY_UNKNOWN, not TOKEN_NO_MARKET (audit #38)', () => {
    const curve = risk([], { liquidity: null, bonding_curve: true, data_quality: { degraded: false, unavailable: [] } });
    const r = decideIntent(input({ category: 'whale' }), { risk: curve, buyMomentum: exit('HOLD') }, NOW);
    expect(r.codes).toEqual(['RISK_LIQUIDITY_UNKNOWN']);
    expect(r.verdict).toBe('HOLD');
  });

  test('extreme volatility from the 24h estimate does not block; from 7d candles it does (audit #41)', () => {
    const est = risk(['extreme_volatility'], { volatility: { window: '24h', source: 'dexscreener_intraday', classification: 'EXTREME' } });
    const r = decideIntent(input({ category: 'whale' }), { risk: est, buyMomentum: exit('HOLD') }, NOW);
    expect(r.codes).toEqual([]);
    expect(r.verdict).toBe('PROCEED');
    expect(r.caveats.some((c) => c.includes('24h estimate'))).toBe(true);
    const real = risk(['extreme_volatility'], { volatility: { window: '7d', source: 'birdeye_daily', classification: 'EXTREME' } });
    expect(decideIntent(input({ category: 'whale' }), { risk: real, buyMomentum: exit('HOLD') }, NOW).codes).toEqual(['RISK_EXTREME_VOLATILITY']);
  });

  test('all checks pass → PROCEED', () => {
    const r = decideIntent(input(), cleanBuy, NOW);
    expect([r.verdict, r.suggested_fraction, r.codes]).toEqual(['PROCEED', 1, []]);
    expect(r.intent.size_usd).toBe(25);
    expect(r.buy_check?.degen_signal).toBe('HIGH_CONFLUENCE');
  });

  test('block flag, weak signal and DERISK momentum each add a code → HOLD', () => {
    const r = decideIntent(input(), { risk: risk(['low_liquidity']), signal: signal('SINGLE_SIGNAL'), buyMomentum: exit('DERISK') }, NOW);
    expect(r.verdict).toBe('HOLD');
    expect(r.codes).toEqual(['RISK_LOW_LIQUIDITY', 'SIGNAL_TOO_WEAK', 'MOMENTUM_DERISK']);
  });

  test('failed reads fail closed', () => {
    const r = decideIntent(input(), {}, NOW);
    expect(r.verdict).toBe('HOLD');
    expect(r.codes).toEqual(['RISK_UNAVAILABLE', 'SIGNAL_UNAVAILABLE', 'MOMENTUM_UNAVAILABLE']);
  });

  test('crypto-bro (kebab) normalizes and skips the trenches signal', () => {
    const r = decideIntent(input({ category: 'crypto-bro' }), { risk: risk(), buyMomentum: exit('HOLD') }, NOW);
    expect(r.intent.category).toBe('crypto_bro');
    expect(r.verdict).toBe('PROCEED');
  });

  test('freeze authority blocks on mainnet only', () => {
    const legs = { ...cleanBuy, risk: risk(['freeze_authority_active']) };
    expect(decideIntent(input(), legs, NOW).verdict).toBe('PROCEED');
    expect(decideIntent(input({ network: 'mainnet' }), legs, NOW).codes).toContain('RISK_FREEZE_AUTHORITY_ACTIVE');
  });

  test('mainnet holds a buy over 3% price impact at size', () => {
    const legs = { ...cleanBuy, risk: risk([], { slippage_estimates: [{ size_usd: 100, price_impact_pct: 0.2 }, { size_usd: 1000, price_impact_pct: 4.5 }] }) };
    expect(decideIntent(input({ network: 'mainnet', amountIn: 50 }), legs, NOW).verdict).toBe('PROCEED');
    const big = decideIntent(input({ network: 'mainnet', amountIn: 800 }), legs, NOW);
    expect(big.codes).toEqual(['HIGH_PRICE_IMPACT']);
    expect(big.buy_check?.price_impact_pct).toBe(4.5);
    expect(decideIntent(input({ amountIn: 800 }), legs, NOW).verdict).toBe('PROCEED'); // devnet ignores impact
  });
});

describe('sells', () => {
  const sell = (over = {}) => input({ tokenInMint: BONK, tokenOutMint: USDC_MINT, amountIn: 1_000_000, ...over });
  test('EXIT → PROCEED 1, DERISK → REDUCE 0.5; no exit signal → PROCEED 1 with NO_EXIT_SIGNAL (sells are never blocked)', () => {
    for (const [v, verdict, fraction, codes] of [
      ['EXIT', 'PROCEED', 1, ['EXIT_EXIT']],
      ['DERISK', 'REDUCE', 0.5, ['EXIT_DERISK']],
      ['HOLD', 'PROCEED', 1, ['EXIT_HOLD', 'NO_EXIT_SIGNAL']],
      ['INSUFFICIENT_DATA', 'PROCEED', 1, ['EXIT_INSUFFICIENT_DATA', 'NO_EXIT_SIGNAL']],
    ] as const) {
      const r = decideIntent(sell(), { sellExit: exit(v) }, NOW);
      expect([r.verdict, r.suggested_fraction, r.codes]).toEqual([verdict, fraction, [...codes]]);
    }
    const failed = decideIntent(sell(), {}, NOW);
    expect([failed.verdict, failed.codes]).toEqual(['PROCEED', ['EXIT_UNAVAILABLE', 'NO_EXIT_SIGNAL']]);
  });

  test('size_usd uses the exit read price', () => {
    expect(decideIntent(sell(), { sellExit: exit('HOLD', 0.00002) }, NOW).intent.size_usd).toBe(20);
  });
});

describe('snapshot clock', () => {
  const late = NOW + (Date.parse(ENDS) - NOW) - 30 * 60_000;
  test('inside the buffer a sell proceeds in full and a buy holds', () => {
    const s = decideIntent(input({ tokenInMint: BONK, tokenOutMint: USDC_MINT }), {}, late);
    expect([s.verdict, s.suggested_fraction, s.codes, s.season.minutes_to_snapshot]).toEqual(['PROCEED', 1, ['SNAPSHOT_CLOCK'], 30]);
    const b = decideIntent(input(), cleanBuy, late);
    expect([b.verdict, b.codes, b.buy_check]).toEqual(['HOLD', ['SNAPSHOT_CLOCK'], null]);
  });

  test('a swap inside the buffer holds and routes to USDC', () => {
    expect(decideIntent(input({ tokenInMint: BONK, tokenOutMint: JUP }), {}, late).codes).toEqual(['SNAPSHOT_CLOCK', 'ROUTE_TO_USDC']);
  });

  test('default season end is flagged in caveats', () => {
    const r = decideIntent(input({ seasonEndsAt: undefined }), cleanBuy, NOW);
    expect(r.season).toMatchObject({ ends_at: ENDS, ends_at_source: 'default_saturday' });
    expect(r.caveats[0]).toContain('seasonEndsAt not given');
  });
});

describe('swaps', () => {
  test('a failing buy leg with an EXIT sell leg routes to USDC', () => {
    const r = decideIntent(input({ tokenInMint: BONK, tokenOutMint: JUP, category: 'whale' }), { risk: risk(['whale_dominated']), buyMomentum: exit('HOLD'), sellExit: exit('EXIT') }, NOW);
    expect(r.verdict).toBe('HOLD');
    expect(r.codes).toEqual(['RISK_WHALE_DOMINATED', 'ROUTE_TO_USDC']);
    expect(r.sell_check?.exit_verdict).toBe('EXIT');
  });
});

describe('AudaceIntentChecker', () => {
  test('runs only the legs it needs and survives a failing leg', async () => {
    const calls: string[] = [];
    const checker = new AudaceIntentChecker(
      { enrich: async (m: string) => { calls.push(`risk:${m}`); return risk(); } } as any,
      { check: async () => { calls.push('signal'); throw new Error('dexscreener 503'); } } as any,
      { analyze: async (m: string) => { calls.push(`exit:${m}`); return exit('HOLD'); } } as any,
    );
    const r = await checker.check(input(), NOW);
    expect(calls.sort()).toEqual([`exit:${BONK}`, `risk:${BONK}`, 'signal']);
    expect(r.codes).toEqual(['SIGNAL_UNAVAILABLE']);
    calls.length = 0;
    await checker.check(input({ tokenInMint: BONK, tokenOutMint: USDC_MINT }), NOW);
    expect(calls).toEqual([`exit:${BONK}`]);
  });

  test('accepts and ignores the other swap-intent fields', () => {
    const parsed = AudaceIntentCheckInput.parse({ seasonId: '6f1c', idempotencyKey: 'k-12345678', surface: 'api', category: 'whale', tokenInMint: USDC_MINT, tokenOutMint: BONK, amountIn: 5 });
    expect(Object.keys(parsed)).not.toContain('seasonId');
    expect(parsed.network).toBe('devnet');
  });
});
