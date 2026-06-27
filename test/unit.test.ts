/**
 * Comprehensive unit tests for all pure functions.
 * Run: bun test test/unit.test.ts
 */

import { describe, test, expect } from 'bun:test';

// --- Imports ---

import { labelWallet, type WalletData } from '../src/enrichers/labeler';
import { getRiskLevel, scoreWalletRisk, scoreTokenRisk } from '../src/enrichers/risk-scorer';
import {
  shortenAddress, formatUsd, formatNumber, formatPercent,
  formatTimestamp, lamportsToSol, tokenAmountToDecimal,
} from '../src/utils/normalize';
import { lookupEntity, tagAddress, tagAddresses } from '../src/utils/entities';
import { median, spreadPct } from '../src/utils/price-aggregator';
import { formatResponse } from '../src/formatters/index';
import { parseIntent } from '../src/entrypoints/query';
import { STRESS_COVERAGE } from '../agents/solscout/stress';
import { ENDPOINT_META } from '../src/openapi';
import { PRICING } from '../src/config';

// --- SolScout stress coverage guard ---
// Enforces the "new endpoint checklist" rule: every paid endpoint (PRICING) must
// have a SolScout stress config. Fails CI if an endpoint was added without one.
describe('SolScout stress coverage', () => {
  test('every paid endpoint has a stress config', () => {
    expect(STRESS_COVERAGE.missing).toEqual([]);
  });
});

// --- CDP payment guard: resource.description length ---
// CDP's x402 facilitator REJECTS any payment whose resource.description exceeds
// ~500 chars (verify 400: "'paymentPayload' is invalid"). The resource.description
// is ENDPOINT_META[key].description. An over-long description makes the endpoint
// return 402 even on a valid payment — a SILENT failure that blocked check-alerts +
// both Hyperliquid endpoints from ever settling (root-caused 2026-06-27). Cap at 480
// for safe margin (perps-cross-venue-funding settled at 489; hl-trader failed at 536).
describe('CDP payment: endpoint description length', () => {
  const MAX_DESCRIPTION = 480;
  for (const key of Object.keys(PRICING)) {
    test(`${key} description <= ${MAX_DESCRIPTION} chars`, () => {
      const meta = (ENDPOINT_META as Record<string, { description?: string }>)[key];
      const len = (meta?.description ?? '').length;
      expect(len).toBeLessThanOrEqual(MAX_DESCRIPTION);
    });
  }
});

// --- Helpers ---

function makeWalletData(overrides: Partial<WalletData> = {}): WalletData {
  return {
    balance_sol: 0,
    portfolio_value_usd: 0,
    token_count: 0,
    nft_count: 0,
    tx_count_30d: 0,
    first_tx_date: null,
    defi_positions: [],
    top_holdings: [],
    swap_count_30d: 0,
    daily_tx_counts: [],
    protocols_interacted: [],
    stablecoin_pct: 0,
    ...overrides,
  };
}

// =====================================================
// 1. LABELER
// =====================================================

describe('labelWallet', () => {
  test('empty wallet returns no labels', () => {
    expect(labelWallet(makeWalletData())).toEqual([]);
  });

  test('whale: holding > $100k', () => {
    const labels = labelWallet(makeWalletData({
      top_holdings: [{ symbol: 'SOL', usd_value: 150_000, pct_portfolio: 100 }],
    }));
    expect(labels).toContain('whale');
  });

  test('whale: exactly $100k does NOT trigger', () => {
    const labels = labelWallet(makeWalletData({
      top_holdings: [{ symbol: 'SOL', usd_value: 100_000, pct_portfolio: 100 }],
    }));
    expect(labels).not.toContain('whale');
  });

  test('active_trader: 51 swaps', () => {
    expect(labelWallet(makeWalletData({ swap_count_30d: 51 }))).toContain('active_trader');
  });

  test('active_trader: exactly 50 does NOT trigger', () => {
    expect(labelWallet(makeWalletData({ swap_count_30d: 50 }))).not.toContain('active_trader');
  });

  test('defi_user: 2 distinct protocols', () => {
    const labels = labelWallet(makeWalletData({
      defi_positions: [
        { protocol: 'Jupiter', type: 'swap', value_usd: 0 },
        { protocol: 'Marinade', type: 'stake', value_usd: 0 },
      ],
    }));
    expect(labels).toContain('defi_user');
  });

  test('defi_user: 1 protocol does NOT trigger', () => {
    const labels = labelWallet(makeWalletData({
      defi_positions: [{ protocol: 'Jupiter', type: 'swap', value_usd: 0 }],
    }));
    expect(labels).not.toContain('defi_user');
  });

  test('nft_collector: 10 NFTs', () => {
    expect(labelWallet(makeWalletData({ nft_count: 10 }))).toContain('nft_collector');
  });

  test('nft_collector: 9 does NOT trigger', () => {
    expect(labelWallet(makeWalletData({ nft_count: 9 }))).not.toContain('nft_collector');
  });

  test('new_wallet: first tx 15 days ago', () => {
    const date = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();
    expect(labelWallet(makeWalletData({ first_tx_date: date }))).toContain('new_wallet');
  });

  test('new_wallet: first tx 31 days ago does NOT trigger', () => {
    const date = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    expect(labelWallet(makeWalletData({ first_tx_date: date }))).not.toContain('new_wallet');
  });

  test('dormant: no txs in 30d and > 90d old', () => {
    const date = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    expect(labelWallet(makeWalletData({ tx_count_30d: 0, first_tx_date: date }))).toContain('dormant');
  });

  test('airdrop_farmer: 5 protocols', () => {
    expect(labelWallet(makeWalletData({
      protocols_interacted: ['A', 'B', 'C', 'D', 'E'],
    }))).toContain('airdrop_farmer');
  });

  test('airdrop_farmer: 4 protocols does NOT trigger', () => {
    expect(labelWallet(makeWalletData({
      protocols_interacted: ['A', 'B', 'C', 'D'],
    }))).not.toContain('airdrop_farmer');
  });

  test('bot_suspect: day with 501 txs', () => {
    expect(labelWallet(makeWalletData({ daily_tx_counts: [10, 501, 5] }))).toContain('bot_suspect');
  });

  test('bot_suspect: exactly 500 does NOT trigger', () => {
    expect(labelWallet(makeWalletData({ daily_tx_counts: [500] }))).not.toContain('bot_suspect');
  });

  test('stablecoin_heavy: 61%', () => {
    expect(labelWallet(makeWalletData({ stablecoin_pct: 61 }))).toContain('stablecoin_heavy');
  });

  test('stablecoin_heavy: exactly 60% does NOT trigger', () => {
    expect(labelWallet(makeWalletData({ stablecoin_pct: 60 }))).not.toContain('stablecoin_heavy');
  });

  test('lp_provider: 2 LP positions', () => {
    const labels = labelWallet(makeWalletData({
      defi_positions: [
        { protocol: 'Orca', type: 'LP', value_usd: 0 },
        { protocol: 'Raydium', type: 'liquidity', value_usd: 0 },
      ],
    }));
    expect(labels).toContain('lp_provider');
  });

  test('lp_provider: case insensitive types', () => {
    const labels = labelWallet(makeWalletData({
      defi_positions: [
        { protocol: 'A', type: 'POOL', value_usd: 0 },
        { protocol: 'B', type: 'Clmm', value_usd: 0 },
      ],
    }));
    expect(labels).toContain('lp_provider');
  });

  test('multiple labels are sorted alphabetically', () => {
    const labels = labelWallet(makeWalletData({
      top_holdings: [{ symbol: 'SOL', usd_value: 150_000, pct_portfolio: 100 }],
      swap_count_30d: 51,
    }));
    expect(labels).toEqual(['active_trader', 'whale']);
  });
});

// =====================================================
// 2. RISK SCORER
// =====================================================

describe('getRiskLevel', () => {
  test('0.0 → LOW', () => expect(getRiskLevel(0)).toBe('LOW'));
  test('0.19 → LOW', () => expect(getRiskLevel(0.19)).toBe('LOW'));
  test('0.2 → MODERATE', () => expect(getRiskLevel(0.2)).toBe('MODERATE'));
  test('0.39 → MODERATE', () => expect(getRiskLevel(0.39)).toBe('MODERATE'));
  test('0.4 → ELEVATED', () => expect(getRiskLevel(0.4)).toBe('ELEVATED'));
  test('0.59 → ELEVATED', () => expect(getRiskLevel(0.59)).toBe('ELEVATED'));
  test('0.6 → HIGH', () => expect(getRiskLevel(0.6)).toBe('HIGH'));
  test('0.79 → HIGH', () => expect(getRiskLevel(0.79)).toBe('HIGH'));
  test('0.8 → CRITICAL', () => expect(getRiskLevel(0.8)).toBe('CRITICAL'));
  test('1.0 → CRITICAL', () => expect(getRiskLevel(1.0)).toBe('CRITICAL'));
  test('negative → LOW', () => expect(getRiskLevel(-0.5)).toBe('LOW'));
  test('over 1.0 → CRITICAL', () => expect(getRiskLevel(1.5)).toBe('CRITICAL'));
});

describe('scoreWalletRisk', () => {
  const safe = {
    wallet_age_days: 365, tx_diversity: 0.5, protocol_breadth: 5,
    concentration: 20, flagged_associations: 0, labels: [],
  };

  test('zero risk wallet', () => {
    const r = scoreWalletRisk(safe);
    expect(r.score).toBe(0);
    expect(r.risk_level).toBe('LOW');
    expect(r.factors).toHaveLength(0);
  });

  test('new wallet < 7 days: +0.20', () => {
    const r = scoreWalletRisk({ ...safe, wallet_age_days: 3 });
    expect(r.score).toBe(0.2);
    expect(r.factors).toHaveLength(1);
  });

  test('new wallet 7-30 days: +0.10', () => {
    const r = scoreWalletRisk({ ...safe, wallet_age_days: 15 });
    expect(r.score).toBe(0.1);
  });

  test('wallet exactly 7 days: +0.10 (falls into < 30 branch)', () => {
    const r = scoreWalletRisk({ ...safe, wallet_age_days: 7 });
    expect(r.score).toBe(0.1);
  });

  test('high concentration > 80%: +0.20', () => {
    const r = scoreWalletRisk({ ...safe, concentration: 85 });
    expect(r.score).toBe(0.2);
  });

  test('moderate concentration 50-80%: +0.10', () => {
    const r = scoreWalletRisk({ ...safe, concentration: 60 });
    expect(r.score).toBe(0.1);
  });

  test('flagged associations: +0.25', () => {
    const r = scoreWalletRisk({ ...safe, flagged_associations: 3 });
    expect(r.score).toBe(0.25);
  });

  test('bot_suspect label: +0.15', () => {
    const r = scoreWalletRisk({ ...safe, labels: ['bot_suspect'] });
    expect(r.score).toBe(0.15);
  });

  test('airdrop_farmer label: +0.10', () => {
    const r = scoreWalletRisk({ ...safe, labels: ['airdrop_farmer'] });
    expect(r.score).toBe(0.1);
  });

  test('low tx_diversity: +0.10', () => {
    const r = scoreWalletRisk({ ...safe, tx_diversity: 0.05 });
    expect(r.score).toBe(0.1);
  });

  test('low protocol_breadth: +0.05', () => {
    const r = scoreWalletRisk({ ...safe, protocol_breadth: 1 });
    expect(r.score).toBe(0.05);
  });

  test('score clamped at 1.0', () => {
    const r = scoreWalletRisk({
      wallet_age_days: 1, tx_diversity: 0.01, protocol_breadth: 0,
      concentration: 95, flagged_associations: 5, labels: ['bot_suspect', 'airdrop_farmer'],
    });
    expect(r.score).toBe(1.0);
    expect(r.risk_level).toBe('CRITICAL');
  });

  test('multiple factors listed', () => {
    const r = scoreWalletRisk({ ...safe, wallet_age_days: 3, concentration: 85 });
    expect(r.factors).toHaveLength(2);
    expect(r.score).toBe(0.4);
  });
});

describe('scoreTokenRisk', () => {
  const safe = {
    risk_flags_count: 0, verified: true, mint_authority_active: false,
    freeze_authority_active: false, liquidity: 100_000,
  };

  test('zero risk token', () => {
    const r = scoreTokenRisk(safe);
    expect(r.score).toBe(0);
    expect(r.risk_level).toBe('LOW');
  });

  test('risk flags capped at 0.30', () => {
    const r = scoreTokenRisk({ ...safe, risk_flags_count: 5 });
    expect(r.score).toBe(0.3);
  });

  test('1 risk flag: 0.08', () => {
    const r = scoreTokenRisk({ ...safe, risk_flags_count: 1 });
    expect(r.score).toBe(0.08);
  });

  test('not verified: +0.15', () => {
    const r = scoreTokenRisk({ ...safe, verified: false });
    expect(r.score).toBe(0.15);
  });

  test('mint authority active: +0.20', () => {
    const r = scoreTokenRisk({ ...safe, mint_authority_active: true });
    expect(r.score).toBe(0.2);
  });

  test('freeze authority active: +0.10', () => {
    const r = scoreTokenRisk({ ...safe, freeze_authority_active: true });
    expect(r.score).toBe(0.1);
  });

  test('very low liquidity < $10K: +0.20', () => {
    const r = scoreTokenRisk({ ...safe, liquidity: 5000 });
    expect(r.score).toBe(0.2);
  });

  test('low liquidity $10K-$50K: +0.10', () => {
    const r = scoreTokenRisk({ ...safe, liquidity: 30_000 });
    expect(r.score).toBe(0.1);
  });

  test('HHI > 2500: +0.15', () => {
    const r = scoreTokenRisk({ ...safe, herfindahl_index: 3000 });
    expect(r.score).toBe(0.15);
  });

  test('HHI 1500-2500: +0.05', () => {
    const r = scoreTokenRisk({ ...safe, herfindahl_index: 2000 });
    expect(r.score).toBe(0.05);
  });

  test('HHI <= 1500: no penalty', () => {
    const r = scoreTokenRisk({ ...safe, herfindahl_index: 500 });
    expect(r.score).toBe(0);
  });

  test('whale distributing: +0.10', () => {
    const r = scoreTokenRisk({ ...safe, whale_distributing: true });
    expect(r.score).toBe(0.1);
  });

  test('top holder > 50%: +0.20', () => {
    const r = scoreTokenRisk({ ...safe, holder_concentration_top1: 55 });
    expect(r.score).toBe(0.2);
  });

  test('top holder 25-50%: +0.10', () => {
    const r = scoreTokenRisk({ ...safe, holder_concentration_top1: 30 });
    expect(r.score).toBe(0.1);
  });

  test('score clamped at 1.0 and rounded', () => {
    const r = scoreTokenRisk({
      risk_flags_count: 5, verified: false, mint_authority_active: true,
      freeze_authority_active: true, liquidity: 1000,
      holder_concentration_top1: 80, holder_concentration_top5: 95,
      herfindahl_index: 5000, whale_distributing: true,
    });
    expect(r.score).toBe(1.0);
    expect(r.risk_level).toBe('CRITICAL');
  });
});

// =====================================================
// 3. NORMALIZE
// =====================================================

describe('shortenAddress', () => {
  test('long address shortened', () => {
    expect(shortenAddress('vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg')).toBe('vine...PTg');
  });
  test('8 chars returned as-is', () => expect(shortenAddress('12345678')).toBe('12345678'));
  test('9 chars shortened', () => expect(shortenAddress('123456789')).toBe('1234...789'));
  test('empty string', () => expect(shortenAddress('')).toBe(''));
});

describe('formatUsd', () => {
  test('zero', () => expect(formatUsd(0)).toBe('$0.00'));
  test('whole number', () => expect(formatUsd(1000)).toBe('$1,000.00'));
  test('decimal', () => expect(formatUsd(12.5)).toBe('$12.50'));
  test('micro-price', () => {
    const result = formatUsd(0.0000234);
    expect(result).toMatch(/^\$0\.0000234/);
  });
  test('negative', () => expect(formatUsd(-100)).toBe('$-100.00'));
});

describe('formatNumber', () => {
  test('thousands', () => expect(formatNumber(1234)).toBe('1.23K'));
  test('millions', () => expect(formatNumber(1234567)).toBe('1.23M'));
  test('billions', () => expect(formatNumber(1234567890)).toBe('1.23B'));
  test('below 1K', () => expect(formatNumber(42)).toBe('42.00'));
  test('zero', () => expect(formatNumber(0)).toBe('0.00'));
  test('exactly 1K', () => expect(formatNumber(1000)).toBe('1.00K'));
  test('negative', () => expect(formatNumber(-1000)).toBe('-1.00K'));
});

describe('formatPercent', () => {
  test('50%', () => expect(formatPercent(50)).toBe('50.00%'));
  test('0%', () => expect(formatPercent(0)).toBe('0.00%'));
  test('100%', () => expect(formatPercent(100)).toBe('100.00%'));
  test('decimal', () => expect(formatPercent(33.333)).toBe('33.33%'));
});

describe('formatTimestamp', () => {
  test('returns ISO 8601 format', () => {
    const ts = formatTimestamp();
    expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe('lamportsToSol', () => {
  test('1 SOL', () => expect(lamportsToSol(1_000_000_000)).toBe(1));
  test('0.5 SOL', () => expect(lamportsToSol(500_000_000)).toBe(0.5));
  test('zero', () => expect(lamportsToSol(0)).toBe(0));
});

describe('tokenAmountToDecimal', () => {
  test('USDC: 1M raw / 6 decimals = 1', () => expect(tokenAmountToDecimal(1_000_000, 6)).toBe(1));
  test('zero decimals', () => expect(tokenAmountToDecimal(100, 0)).toBe(100));
  test('zero amount', () => expect(tokenAmountToDecimal(0, 6)).toBe(0));
  test('bigint input', () => expect(tokenAmountToDecimal(1_000_000n, 6)).toBe(1));
});

// =====================================================
// 4. ENTITIES
// =====================================================

describe('lookupEntity', () => {
  test('known CEX', () => {
    const e = lookupEntity('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
    expect(e).not.toBeNull();
    expect(e!.label).toBe('Binance Hot Wallet');
    expect(e!.type).toBe('cex');
  });

  test('known protocol', () => {
    const e = lookupEntity('JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4');
    expect(e).not.toBeNull();
    expect(e!.label).toBe('Jupiter');
    expect(e!.type).toBe('protocol');
  });

  test('unknown address', () => expect(lookupEntity('unknown123')).toBeNull());
  test('empty string', () => expect(lookupEntity('')).toBeNull());
});

describe('tagAddress', () => {
  test('known address includes entity fields', () => {
    const t = tagAddress('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM');
    expect(t.entity_label).toBe('Binance Hot Wallet');
    expect(t.entity_type).toBe('cex');
  });

  test('unknown address has no entity fields', () => {
    const t = tagAddress('unknown');
    expect(t.address).toBe('unknown');
    expect(t.entity_label).toBeUndefined();
    expect(t.entity_type).toBeUndefined();
  });
});

describe('tagAddresses', () => {
  test('mixed known/unknown', () => {
    const result = tagAddresses(['9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'unknown']);
    expect(result).toHaveLength(2);
    expect(result[0].entity_label).toBe('Binance Hot Wallet');
    expect(result[1].entity_label).toBeUndefined();
  });

  test('empty array', () => expect(tagAddresses([])).toEqual([]));
});

// =====================================================
// 5. PRICE AGGREGATOR (median, spreadPct)
// =====================================================

describe('median', () => {
  test('empty array', () => expect(median([])).toBe(0));
  test('single value', () => expect(median([5])).toBe(5));
  test('odd length', () => expect(median([1, 2, 3])).toBe(2));
  test('even length', () => expect(median([1, 2, 3, 4])).toBe(2.5));
  test('unsorted input', () => expect(median([10, 1, 5])).toBe(5));
  test('all zeros', () => expect(median([0, 0, 0])).toBe(0));
  test('with negatives', () => expect(median([-5, 0, 5])).toBe(0));
  test('two values', () => expect(median([100, 200])).toBe(150));
});

describe('spreadPct', () => {
  test('empty array', () => expect(spreadPct([])).toBe(0));
  test('single value', () => expect(spreadPct([100])).toBe(0));
  test('same values', () => expect(spreadPct([100, 100])).toBe(0));
  test('100% spread', () => expect(spreadPct([100, 200])).toBe(100));
  test('10% spread', () => expect(spreadPct([100, 110])).toBe(10));
  test('three values', () => expect(spreadPct([10, 20, 30])).toBe(200));
  test('min is zero', () => expect(spreadPct([0, 100])).toBe(0));
});

// =====================================================
// 6. FORMAT RESPONSE
// =====================================================

describe('formatResponse', () => {
  const data = { a: 1, b: 'hello' };
  const formatter = (d: typeof data) => `a=${d.a}`;

  test('json: returns data unchanged', () => {
    expect(formatResponse(data, 'json', formatter)).toEqual(data);
  });

  test('llm: returns briefing object', () => {
    const result = formatResponse(data, 'llm', formatter);
    expect(result).toEqual({ briefing: 'a=1', content_type: 'text/markdown' });
  });

  test('both: returns data + llm_summary', () => {
    const result = formatResponse(data, 'both', formatter) as any;
    expect(result.a).toBe(1);
    expect(result.b).toBe('hello');
    expect(result.llm_summary).toBe('a=1');
  });
});

// =====================================================
// 7. QUERY INTENT PARSER
// =====================================================

const TEST_ADDR = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';

describe('parseIntent', () => {
  // Safety keywords route to the safety-check compound (due-diligence + whale-watch)
  test('"is X safe?" → safety-check', () => {
    const r = parseIntent(`is ${TEST_ADDR} safe?`);
    expect(r.intent).toBe('safety-check');
    expect(r.address).toBe(TEST_ADDR);
  });

  test('"rug" keyword → safety-check', () => {
    expect(parseIntent(`rug ${TEST_ADDR}`).intent).toBe('safety-check');
  });

  test('"scam" keyword → safety-check', () => {
    expect(parseIntent(`is ${TEST_ADDR} a scam?`).intent).toBe('safety-check');
  });

  // Whale keywords
  test('"whales for X" → whale-watch', () => {
    const r = parseIntent(`whales for ${TEST_ADDR}`);
    expect(r.intent).toBe('whale-watch');
    expect(r.address).toBe(TEST_ADDR);
  });

  test('"accumulation" → whale-watch', () => {
    expect(parseIntent(`accumulation ${TEST_ADDR}`).intent).toBe('whale-watch');
  });

  // Copy-trade keywords
  test('"copy trade signals" → copy-trade', () => {
    expect(parseIntent(`copy trade signals ${TEST_ADDR}`).intent).toBe('copy-trade');
  });

  test('"pnl" → copy-trade', () => {
    expect(parseIntent(`pnl for ${TEST_ADDR}`).intent).toBe('copy-trade');
  });

  test('"win rate" → copy-trade', () => {
    expect(parseIntent(`win rate ${TEST_ADDR}`).intent).toBe('copy-trade');
  });

  // Graph keywords
  test('"graph connections" → graph', () => {
    expect(parseIntent(`graph connections ${TEST_ADDR}`).intent).toBe('graph');
  });

  test('"network" → graph', () => {
    expect(parseIntent(`network ${TEST_ADDR}`).intent).toBe('graph');
  });

  // Transaction keywords
  test('"parse tx" → transaction', () => {
    expect(parseIntent(`parse tx ${TEST_ADDR}`).intent).toBe('transaction');
  });

  // Token keywords
  test('"token price" → token', () => {
    expect(parseIntent(`token price for ${TEST_ADDR}`).intent).toBe('token');
  });

  test('"market cap" → token', () => {
    expect(parseIntent(`market cap ${TEST_ADDR}`).intent).toBe('token');
  });

  test('"liquidity" → token', () => {
    expect(parseIntent(`liquidity ${TEST_ADDR}`).intent).toBe('token');
  });

  test('"holder concentration" → token', () => {
    expect(parseIntent(`holder concentration ${TEST_ADDR}`).intent).toBe('token');
  });

  // Wallet keywords
  test('"wallet profile" → wallet', () => {
    expect(parseIntent(`wallet profile ${TEST_ADDR}`).intent).toBe('wallet');
  });

  test('"balance" → wallet', () => {
    expect(parseIntent(`balance ${TEST_ADDR}`).intent).toBe('wallet');
  });

  // Case insensitivity
  test('case insensitive', () => {
    expect(parseIntent(`WHALES FOR ${TEST_ADDR}`).intent).toBe('whale-watch');
  });

  // Fallback: address but no keyword → wallet
  test('address only defaults to wallet', () => {
    const r = parseIntent(`analyze ${TEST_ADDR}`);
    expect(r.intent).toBe('wallet');
    expect(r.address).toBe(TEST_ADDR);
  });

  // Unknown: no address, no keyword
  test('no address or keyword → unknown', () => {
    const r = parseIntent('hello world');
    expect(r.intent).toBe('unknown');
    expect(r.address).toBeNull();
  });

  test('empty string → unknown', () => {
    const r = parseIntent('');
    expect(r.intent).toBe('unknown');
    expect(r.address).toBeNull();
  });

  // Priority: rug keywords route to the safety-check compound
  test('safety-check with "rugpull" keyword', () => {
    expect(parseIntent(`rugpull check ${TEST_ADDR}`).intent).toBe('safety-check');
  });

  // Priority: whale-watch wins over wallet
  test('whale-watch priority over wallet', () => {
    expect(parseIntent(`whale wallet ${TEST_ADDR}`).intent).toBe('whale-watch');
  });
});
