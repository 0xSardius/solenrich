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
import { assessRunner, computeRunnerMetrics, type RunnerScoreInput } from '../src/enrichers/runner-score';
import { assessExit, computeExitMetrics, type ExitScoreInput } from '../src/enrichers/exit-score';
import { classifyNfts, isSuspectedSpam, type NftAssetInput } from '../src/enrichers/nft-classifier';
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

// =====================================================
// 8. RUNNER SCORE (runner-scan velocity math)
// =====================================================

function mkRunner(over: Partial<RunnerScoreInput> = {}): RunnerScoreInput {
  return {
    txns: {
      m5: { buys: 0, sells: 0 },
      h1: { buys: 0, sells: 0 },
      h6: { buys: 0, sells: 0 },
      h24: { buys: 0, sells: 0 },
    },
    volume: { m5: 0, h1: 0, h6: 0, h24: 0 },
    price_change: { m5: 0, h1: 0, h6: 0, h24: 0 },
    liquidity_usd: 50_000,
    age_hours: 4,
    liquidity_change_pct: null,
    holder_growth_pct: null,
    ...over,
  };
}

// A token ticking along at a constant rate: every ratio should land on ~1.0.
const STEADY = mkRunner({
  txns: {
    m5: { buys: 10, sells: 8 },
    h1: { buys: 120, sells: 100 },
    h6: { buys: 720, sells: 600 },
    h24: { buys: 2880, sells: 2400 },
  },
  volume: { m5: 83, h1: 1000, h6: 6000, h24: 24000 },
  price_change: { m5: 0, h1: 1, h6: 6, h24: 20 },
});

// Buying speeding up on all three windows with demand-dominated flow.
const ACCELERATING = mkRunner({
  txns: {
    m5: { buys: 40, sells: 10 },
    h1: { buys: 200, sells: 60 },
    h6: { buys: 600, sells: 300 },
    h24: { buys: 1200, sells: 800 },
  },
  volume: { m5: 4000, h1: 30_000, h6: 90_000, h24: 150_000 },
  price_change: { m5: 8, h1: 40, h6: 60, h24: 80 },
});

describe('computeRunnerMetrics', () => {
  test('steady state produces ~1.0 ratios', () => {
    const m = computeRunnerMetrics(STEADY);
    expect(m.buy_rate_accel_m5_h1).toBeCloseTo(1.0, 1);
    expect(m.buy_rate_accel_h1_h6).toBeCloseTo(1.0, 1);
    expect(m.volume_accel).toBeCloseTo(1.0, 1);
    expect(m.windows_accelerating).toBe(0);
  });

  test('acceleration is detected on every window', () => {
    const m = computeRunnerMetrics(ACCELERATING);
    expect(m.buy_rate_accel_m5_h1).toBeCloseTo(2.4, 1);
    expect(m.buy_rate_accel_h1_h6).toBeCloseTo(2.0, 1);
    expect(m.volume_accel).toBeCloseTo(2.0, 1);
    expect(m.windows_accelerating).toBe(3);
  });

  test('buy pressure is buys over total', () => {
    const m = computeRunnerMetrics(ACCELERATING);
    expect(m.buy_pressure_h1).toBeCloseTo(200 / 260, 2);
  });

  test('thin samples return null rather than a noisy ratio', () => {
    const m = computeRunnerMetrics(
      mkRunner({ txns: { m5: { buys: 1, sells: 0 }, h1: { buys: 3, sells: 1 }, h6: { buys: 4, sells: 2 }, h24: { buys: 8, sells: 4 } } }),
    );
    expect(m.buy_rate_accel_m5_h1).toBeNull();
    expect(m.buy_rate_accel_h1_h6).toBeNull();
    expect(m.buy_pressure_h1).toBeNull();
  });

  test('price velocity is zero when price is falling', () => {
    const m = computeRunnerMetrics(mkRunner({ price_change: { m5: -1, h1: -5, h6: 30, h24: 50 } }));
    expect(m.price_velocity).toBe(0);
  });

  test('price velocity credits a reversal off a flat 6h', () => {
    const m = computeRunnerMetrics(mkRunner({ price_change: { m5: 2, h1: 10, h6: 0, h24: 5 } }));
    expect(m.price_velocity).toBe(2);
  });

  test('average trade size is volume over transaction count', () => {
    const m = computeRunnerMetrics(
      mkRunner({ txns: { m5: { buys: 0, sells: 0 }, h1: { buys: 60, sells: 40 }, h6: { buys: 0, sells: 0 }, h24: { buys: 0, sells: 0 } }, volume: { m5: 0, h1: 5000, h6: 0, h24: 0 } }),
    );
    expect(m.avg_trade_usd).toBe(50);
  });
});

describe('assessRunner stages', () => {
  test('steady state is QUIET', () => {
    expect(assessRunner(STEADY).stage).toBe('QUIET');
  });

  test('multi-window acceleration is RUNNING', () => {
    const a = assessRunner(ACCELERATING);
    expect(a.stage).toBe('RUNNING');
    expect(a.flags).toContain('accelerating_5m');
    expect(a.flags).toContain('strong_buy_pressure');
    expect(a.runner_score).toBeGreaterThan(0.6);
  });

  test('single-window acceleration is IGNITING, not RUNNING', () => {
    const a = assessRunner(
      mkRunner({
        txns: { m5: { buys: 40, sells: 10 }, h1: { buys: 200, sells: 60 }, h6: { buys: 1500, sells: 500 }, h24: { buys: 3000, sells: 1500 } },
        volume: { m5: 1000, h1: 10_000, h6: 90_000, h24: 200_000 },
        price_change: { m5: 3, h1: 10, h6: 15, h24: 20 },
      }),
    );
    expect(a.metrics.windows_accelerating).toBe(1);
    expect(a.stage).toBe('IGNITING');
  });

  test('big 24h gain with decelerating buys is PARABOLIC_LATE', () => {
    const a = assessRunner(
      mkRunner({
        txns: { m5: { buys: 5, sells: 5 }, h1: { buys: 200, sells: 100 }, h6: { buys: 900, sells: 400 }, h24: { buys: 2000, sells: 900 } },
        volume: { m5: 500, h1: 10_000, h6: 90_000, h24: 300_000 },
        price_change: { m5: 0, h1: 5, h6: 40, h24: 300 },
      }),
    );
    expect(a.stage).toBe('PARABOLIC_LATE');
    expect(a.flags).toContain('already_ran');
  });

  test('liquidity pull is FADING regardless of buy activity', () => {
    const a = assessRunner({ ...ACCELERATING, liquidity_change_pct: -40 });
    expect(a.stage).toBe('FADING');
    expect(a.flags).toContain('liquidity_pulled');
    // The guard must dominate: an LP pull cannot score like a runner.
    expect(a.runner_score).toBeLessThan(assessRunner(ACCELERATING).runner_score);
    expect(a.reasoning).toContain('rug');
  });

  test('sells dominating with a falling price is FADING', () => {
    const a = assessRunner(
      mkRunner({
        txns: { m5: { buys: 2, sells: 20 }, h1: { buys: 40, sells: 160 }, h6: { buys: 400, sells: 500 }, h24: { buys: 900, sells: 1000 } },
        volume: { m5: 500, h1: 8000, h6: 60_000, h24: 200_000 },
        price_change: { m5: -5, h1: -30, h6: -40, h24: 10 },
      }),
    );
    expect(a.stage).toBe('FADING');
    expect(a.flags).toContain('dumping');
    expect(a.flags).toContain('sells_dominating');
  });
});

describe('assessRunner guards', () => {
  test('tiny average trade size on high counts flags wash-trade risk', () => {
    const a = assessRunner(
      mkRunner({
        txns: { m5: { buys: 40, sells: 40 }, h1: { buys: 400, sells: 400 }, h6: { buys: 2400, sells: 2400 }, h24: { buys: 9600, sells: 9600 } },
        volume: { m5: 800, h1: 8000, h6: 48_000, h24: 190_000 },
      }),
    );
    expect(a.flags).toContain('wash_trade_risk');
    expect(a.reasoning).toContain('wash-traded');
  });

  test('sub-hour tokens are flagged as thin history', () => {
    expect(assessRunner(mkRunner({ age_hours: 0.4 })).flags).toContain('thin_history');
  });

  test('thin liquidity is flagged', () => {
    expect(assessRunner(mkRunner({ liquidity_usd: 3000 })).flags).toContain('low_liquidity');
  });

  test('holder growth lifts the score, shrinkage flags it', () => {
    const withGrowth = assessRunner({ ...ACCELERATING, holder_growth_pct: 25 });
    const withShrink = assessRunner({ ...ACCELERATING, holder_growth_pct: -5 });
    expect(withGrowth.runner_score).toBeGreaterThan(withShrink.runner_score);
    expect(withGrowth.flags).toContain('holder_growth_strong');
    expect(withShrink.flags).toContain('holders_shrinking');
  });

  test('score always lands within 0..1', () => {
    const cases = [STEADY, ACCELERATING, mkRunner(), { ...ACCELERATING, liquidity_change_pct: -90, holder_growth_pct: -50 }];
    for (const c of cases) {
      const s = assessRunner(c).runner_score;
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  test('a token with no activity at all scores zero and stays QUIET', () => {
    const a = assessRunner(mkRunner());
    expect(a.runner_score).toBe(0);
    expect(a.stage).toBe('QUIET');
  });
});

describe('assessRunner buy-pressure gating', () => {
  // Regression: the first live run ranked a token churning at 43% buys ABOVE one
  // accumulating at 85%, because raw acceleration outweighed pressure. Volume
  // accelerating into selling is distribution, and must not score like a runner.
  const churning = mkRunner({
    txns: { m5: { buys: 120, sells: 160 }, h1: { buys: 900, sells: 1200 }, h6: { buys: 1200, sells: 1500 }, h24: { buys: 2000, sells: 2400 } },
    volume: { m5: 6000, h1: 68_000, h6: 68_000, h24: 90_000 },
    price_change: { m5: 2, h1: 20, h6: 10, h24: 30 },
  });

  test('acceleration under selling pressure stays QUIET', () => {
    const a = assessRunner(churning);
    expect(a.metrics.windows_accelerating).toBeGreaterThanOrEqual(2);
    expect(a.flags).toContain('sells_dominating');
    expect(a.stage).toBe('QUIET');
  });

  test('acceleration under selling pressure scores below accumulation', () => {
    expect(assessRunner(churning).runner_score).toBeLessThan(assessRunner(ACCELERATING).runner_score);
  });

  test('two accelerating windows with only balanced flow is IGNITING, not RUNNING', () => {
    const a = assessRunner(
      mkRunner({
        txns: { m5: { buys: 30, sells: 26 }, h1: { buys: 3020, sells: 2594 }, h6: { buys: 3020, sells: 2594 }, h24: { buys: 4000, sells: 3500 } },
        volume: { m5: 20_000, h1: 186_000, h6: 186_000, h24: 250_000 },
        price_change: { m5: 1, h1: 12, h6: 12, h24: 40 },
      }),
    );
    expect(a.metrics.buy_pressure_h1).toBeLessThan(0.55);
    expect(a.metrics.buy_pressure_h1).toBeGreaterThanOrEqual(0.5);
    expect(a.stage).toBe('IGNITING');
  });

  test('a big 24h run is flagged even when buying is still accelerating', () => {
    const a = assessRunner({ ...ACCELERATING, price_change: { m5: 8, h1: 40, h6: 60, h24: 965 } });
    expect(a.stage).not.toBe('PARABOLIC_LATE');
    expect(a.flags).toContain('up_big_24h');
    expect(a.reasoning).toContain('965%');
  });
});

// ---------------------------------------------------------------------------
// classifyNfts / isSuspectedSpam
// ---------------------------------------------------------------------------

function nft(over: Partial<NftAssetInput> = {}): NftAssetInput {
  return {
    compressed: false,
    name: 'Mad Lads #1234',
    description: 'A Mad Lad.',
    collection_mint: 'J1S9H3QjnRtBbbuD4HjPV6RpRhwuk4zKbxsnCHuTgh9w',
    collection_name: 'Mad Lads',
    ...over,
  };
}

describe('isSuspectedSpam', () => {
  test('never flags uncompressed assets', () => {
    // Uncompressed mints cost rent per asset, so bulk spam is rare there and a
    // false positive would hide a real holding.
    expect(isSuspectedSpam(nft({ compressed: false, name: 'Claim your 5000WIF' }))).toBe(false);
  });

  test('flags invisible characters used to evade filters', () => {
    // Observed live: zero-width spaces inside "USDC".
    expect(isSuspectedSpam(nft({ compressed: true, name: '" U\u200bSD\u200bC VO\u200bUC\u200bHER "' }))).toBe(true);
  });

  test('flags a domain in the name', () => {
    expect(isSuspectedSpam(nft({ compressed: true, name: 'Visit claimsol.xyz now' }))).toBe(true);
    expect(isSuspectedSpam(nft({ compressed: true, name: 'https://drain.example/gift' }))).toBe(true);
  });

  test('flags claim bait wording', () => {
    for (const name of ['Claim You BOME', '$ME BOUNTY', 'USDC Voucher', 'Airdrop #12', 'You won 5 SOL']) {
      expect(isSuspectedSpam(nft({ compressed: true, name, collection_name: null }))).toBe(true);
    }
  });

  test('does not flag legitimate compressed drops', () => {
    for (const name of ['Muffin Pass', 'J.U.P Planetary Call', 'dVIN Labs', 'Active Staking']) {
      expect(isSuspectedSpam(nft({ compressed: true, name, collection_name: name }))).toBe(false);
    }
  });

  test('does not match bait words inside longer words', () => {
    expect(isSuspectedSpam(nft({ compressed: true, name: 'Reclaimed Land #4' }))).toBe(false);
    expect(isSuspectedSpam(nft({ compressed: true, name: 'Freedom Pass' }))).toBe(false);
  });

  test('flags a link in the description only when there is no collection', () => {
    const desc = 'Go to freesol.vip to redeem';
    expect(isSuspectedSpam(nft({ compressed: true, name: 'Pass', collection_mint: null, description: desc }))).toBe(true);
    expect(isSuspectedSpam(nft({ compressed: true, name: 'Pass', description: desc }))).toBe(false);
  });
});

describe('classifyNfts', () => {
  test('buckets always sum to total', () => {
    const assets = [
      nft(),
      nft({ compressed: true, name: 'Muffin Pass', collection_name: 'Muffin Pass' }),
      nft({ compressed: true, name: 'Claim your 5000WIF', collection_name: null, collection_mint: null }),
    ];
    const { summary } = classifyNfts(assets);
    expect(summary.total).toBe(3);
    expect(summary.collected + summary.airdropped + summary.suspected_spam).toBe(3);
    expect(summary).toMatchObject({ collected: 1, airdropped: 1, suspected_spam: 1 });
  });

  test('handles an empty wallet', () => {
    const { summary, collections } = classifyNfts([]);
    expect(summary).toMatchObject({ total: 0, collected: 0, airdropped: 0, suspected_spam: 0, distinct_collections: 0 });
    expect(collections).toEqual([]);
  });

  test('distinct_collections counts only real holdings', () => {
    // 40 spam drops across 40 fake collections is not a 40-collection collector.
    const spam = Array.from({ length: 40 }, (_, i) =>
      nft({ compressed: true, name: `Claim reward #${i}`, collection_mint: `fake${i}`, collection_name: `Claim ${i}` }),
    );
    const { summary } = classifyNfts([...spam, nft()]);
    expect(summary.suspected_spam).toBe(40);
    expect(summary.distinct_collections).toBe(1);
  });

  test('groups by collection mint and sorts real holdings first', () => {
    const assets = [
      ...Array.from({ length: 30 }, () => nft({ compressed: true, name: 'Drop', collection_mint: 'cheap', collection_name: 'Cheap Drop' })),
      nft(),
      nft({ name: 'Mad Lads #2' }),
    ];
    const { collections } = classifyNfts(assets);
    // Mad Lads has 2 assets vs 30 drops, but real holdings sort ahead of drops.
    expect(collections[0].name).toBe('Mad Lads');
    expect(collections[0].count).toBe(2);
    expect(collections[1].count).toBe(30);
  });

  test('keeps unaffiliated mints separate instead of collapsing them', () => {
    const assets = [
      nft({ collection_mint: null, collection_name: null, name: 'One-off A' }),
      nft({ collection_mint: null, collection_name: null, name: 'One-off B' }),
    ];
    const { collections } = classifyNfts(assets);
    expect(collections).toHaveLength(2);
  });

  test('marks a collection as spam if any asset in it is spam', () => {
    const assets = [
      nft({ compressed: true, name: 'Pass #1', collection_mint: 'c1', collection_name: 'Passes' }),
      nft({ compressed: true, name: 'Claim now', collection_mint: 'c1', collection_name: 'Passes' }),
    ];
    const { collections } = classifyNfts(assets);
    expect(collections).toHaveLength(1);
    expect(collections[0].suspected_spam).toBe(true);
  });

  test('respects the topCollections cap without distorting the summary', () => {
    const assets = Array.from({ length: 12 }, (_, i) => nft({ collection_mint: `c${i}`, collection_name: `Coll ${i}` }));
    const { summary, collections } = classifyNfts(assets, 5);
    expect(collections).toHaveLength(5);
    expect(summary.total).toBe(12);
    expect(summary.distinct_collections).toBe(12);
  });
});

describe('labelWallet nft_collector', () => {
  test('uses collected count when present, not the raw count', () => {
    // The wallet that motivated the change: 118 non-fungibles, 15 real.
    const spammed = makeWalletData({ nft_count: 118, nft_collected_count: 3 });
    expect(labelWallet(spammed)).not.toContain('nft_collector');

    const collector = makeWalletData({ nft_count: 118, nft_collected_count: 15 });
    expect(labelWallet(collector)).toContain('nft_collector');
  });

  test('falls back to nft_count when collected count is absent', () => {
    expect(labelWallet(makeWalletData({ nft_count: 10 }))).toContain('nft_collector');
  });
});

// ============================================================
// exit-score (exit-signal endpoint)
// ============================================================

function mkExit(over: Partial<ExitScoreInput> = {}): ExitScoreInput {
  return {
    txns: {
      m5: { buys: 0, sells: 0 },
      h1: { buys: 0, sells: 0 },
      h6: { buys: 0, sells: 0 },
      h24: { buys: 0, sells: 0 },
    },
    volume: { m5: 0, h1: 0, h6: 0, h24: 0 },
    price_change: { m5: 0, h1: 0, h6: 0, h24: 0 },
    liquidity_usd: 50_000,
    liquidity_change_pct: null,
    holder_growth_pct: null,
    whale: null,
    ...over,
  };
}

// A healthy tape: buyers in control, steady pace, whales accumulating.
const HEALTHY = mkExit({
  txns: {
    m5: { buys: 12, sells: 6 },
    h1: { buys: 144, sells: 72 },
    h6: { buys: 864, sells: 432 },
    h24: { buys: 3456, sells: 1728 },
  },
  volume: { m5: 100, h1: 1200, h6: 7200, h24: 28_800 },
  price_change: { m5: 1, h1: 5, h6: 20, h24: 40 },
  whale: {
    net_flow_direction: 'accumulating',
    distributing_count: 1,
    accumulating_count: 4,
    whale_count: 10,
    total_sell_volume_usd: 5_000,
    total_buy_volume_usd: 40_000,
  },
});

// Sellers in control, buying collapsing, whales heading out.
const DETERIORATING = mkExit({
  txns: {
    m5: { buys: 3, sells: 15 },
    h1: { buys: 80, sells: 160 },
    h6: { buys: 900, sells: 700 },
    h24: { buys: 2500, sells: 1800 },
  },
  volume: { m5: 200, h1: 4000, h6: 60_000, h24: 150_000 },
  price_change: { m5: -2, h1: -8, h6: 10, h24: 60 },
  holder_growth_pct: -4,
  whale: {
    net_flow_direction: 'distributing',
    distributing_count: 4,
    accumulating_count: 1,
    whale_count: 10,
    total_sell_volume_usd: 60_000,
    total_buy_volume_usd: 12_000,
  },
});

describe('computeExitMetrics', () => {
  test('healthy tape reads low sell pressure and steady pace', () => {
    const m = computeExitMetrics(HEALTHY);
    expect(m.sell_pressure_h1).toBeCloseTo(0.333, 2);
    expect(m.buy_rate_decel_m5_h1).toBeCloseTo(1.0, 1);
    expect(m.volume_decel).toBeCloseTo(1.0, 1);
    expect(m.whale_sell_buy_ratio).toBeCloseTo(0.13, 1);
  });

  test('deteriorating tape reads seller dominance and deceleration', () => {
    const m = computeExitMetrics(DETERIORATING);
    expect(m.sell_pressure_h1).toBeCloseTo(0.667, 2);
    expect(m.buy_rate_decel_m5_h1!).toBeLessThan(0.8);
    expect(m.whale_sell_buy_ratio!).toBeGreaterThan(2);
  });

  test('thin samples produce null pressure, not garbage', () => {
    const m = computeExitMetrics(mkExit({ txns: { m5: { buys: 1, sells: 1 }, h1: { buys: 2, sells: 1 }, h6: { buys: 3, sells: 2 }, h24: { buys: 4, sells: 3 } } }));
    expect(m.sell_pressure_m5).toBeNull();
    expect(m.sell_pressure_h1).toBeNull();
    expect(m.buy_rate_decel_m5_h1).toBeNull();
  });
});

describe('assessExit verdicts', () => {
  test('healthy tape is HOLD with positive flags', () => {
    const a = assessExit(HEALTHY);
    expect(a.verdict).toBe('HOLD');
    expect(a.exit_score).toBeLessThan(0.4);
    expect(a.flags).toContain('buyers_in_control');
    expect(a.flags).toContain('whales_accumulating');
  });

  test('deteriorating tape with whale exodus is EXIT', () => {
    const a = assessExit(DETERIORATING);
    expect(a.verdict).toBe('EXIT');
    expect(a.flags).toContain('sellers_dominating');
    expect(a.flags).toContain('whales_distributing');
    expect(a.flags).toContain('whale_exodus');
    expect(a.exit_score).toBeGreaterThanOrEqual(0.7);
  });

  test('LP pull forces EXIT regardless of a healthy tape', () => {
    const a = assessExit({ ...HEALTHY, liquidity_change_pct: -40 });
    expect(a.verdict).toBe('EXIT');
    expect(a.flags).toContain('lp_pull');
    expect(a.exit_score).toBeGreaterThanOrEqual(0.9);
    expect(a.reasoning).toContain('rug');
  });

  test('active dump forces EXIT', () => {
    const a = assessExit(
      mkExit({
        txns: {
          m5: { buys: 2, sells: 20 },
          h1: { buys: 50, sells: 150 },
          h6: { buys: 600, sells: 700 },
          h24: { buys: 2000, sells: 2200 },
        },
        volume: { m5: 500, h1: 8000, h6: 50_000, h24: 150_000 },
        price_change: { m5: -6, h1: -25, h6: -30, h24: -10 },
      }),
    );
    expect(a.verdict).toBe('EXIT');
    expect(a.flags).toContain('dumping');
    expect(a.exit_score).toBeGreaterThanOrEqual(0.85);
  });

  test('distribution into strength flags and lifts the score', () => {
    const withDivergence = mkExit({
      txns: {
        m5: { buys: 10, sells: 12 },
        h1: { buys: 100, sells: 110 },
        h6: { buys: 600, sells: 500 },
        h24: { buys: 2000, sells: 1600 },
      },
      volume: { m5: 400, h1: 5000, h6: 30_000, h24: 100_000 },
      price_change: { m5: 2, h1: 12, h6: 30, h24: 80 },
    });
    const a = assessExit(withDivergence);
    expect(a.flags).toContain('distribution_into_strength');
    const without = assessExit({
      ...withDivergence,
      price_change: { m5: 0, h1: 2, h6: 30, h24: 80 },
    });
    expect(a.exit_score).toBeGreaterThan(without.exit_score);
  });

  test('no market data and no whale data is INSUFFICIENT_DATA', () => {
    const a = assessExit(mkExit());
    expect(a.verdict).toBe('INSUFFICIENT_DATA');
  });

  test('whale data alone still produces a verdict', () => {
    const a = assessExit(mkExit({ whale: DETERIORATING.whale }));
    expect(a.verdict).not.toBe('INSUFFICIENT_DATA');
    expect(a.flags).toContain('whales_distributing');
  });

  test('thin exit liquidity is flagged as a caveat', () => {
    const a = assessExit({ ...DETERIORATING, liquidity_usd: 8_000 });
    expect(a.flags).toContain('thin_exit_liquidity');
    expect(a.reasoning).toContain('derisk in steps');
  });
});
