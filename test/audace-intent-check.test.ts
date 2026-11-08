/**
 * audace-intent-check decision rules. Pure functions, no network.
 * Run: bun test test/audace-intent-check.test.ts
 */
import { describe, test, expect } from 'bun:test';
import {
  decideIntent, intentDirection, legsNeeded, nextSaturdayUtc, impactAtSize, USDC_MINT,
  AudaceIntentChecker, type IntentLegs,
} from '../src/enrichers/audace-intent-check';
import { AudaceIntentCheckInput } from '../src/schemas/audace';

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const NOW = Date.parse('2026-11-11T12:00:00.000Z'); // a Wednesday
const ENDS = '2026-11-14T00:00:00.000Z';

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

  test('next Saturday 00:00 UTC, including from a Saturday', () => {
    expect(nextSaturdayUtc(NOW)).toBe(ENDS);
    expect(nextSaturdayUtc(Date.parse('2026-11-14T00:00:00.000Z'))).toBe('2026-11-21T00:00:00.000Z');
    expect(nextSaturdayUtc(Date.parse('2026-11-13T23:59:00.000Z'))).toBe(ENDS);
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
  test('EXIT → PROCEED 1, DERISK → REDUCE 0.5, HOLD → HOLD 0, unavailable → HOLD', () => {
    for (const [v, verdict, fraction, code] of [['EXIT', 'PROCEED', 1, 'EXIT_EXIT'], ['DERISK', 'REDUCE', 0.5, 'EXIT_DERISK'], ['HOLD', 'HOLD', 0, 'EXIT_HOLD'], ['INSUFFICIENT_DATA', 'HOLD', 0, 'EXIT_INSUFFICIENT_DATA']] as const) {
      const r = decideIntent(sell(), { sellExit: exit(v) }, NOW);
      expect([r.verdict, r.suggested_fraction, r.codes]).toEqual([verdict, fraction, [code]]);
    }
    expect(decideIntent(sell(), {}, NOW).codes).toEqual(['EXIT_UNAVAILABLE']);
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
