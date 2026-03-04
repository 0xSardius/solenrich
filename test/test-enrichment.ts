// Phase 7: End-to-end enrichment verification
// Tests all 3 enrichers directly (bypasses HTTP/payment layer)
// Run: bun run test/test-enrichment.ts

import { Cache } from '../src/cache';
import { HeliusClient } from '../src/sources/helius';
import { BirdeyeClient } from '../src/sources/birdeye';
import { JupiterClient } from '../src/sources/jupiter';
import { SolanaRpcClient } from '../src/sources/solana-rpc';
import { WalletProfiler } from '../src/enrichers/wallet-profiler';
import { TokenAnalyzer } from '../src/enrichers/token-analyzer';
import { TxParser } from '../src/enrichers/tx-parser';
import { formatResponse } from '../src/formatters';
import { formatWalletBriefing } from '../src/formatters/llm-wallet';
import { formatTokenBriefing } from '../src/formatters/llm-token';
import { formatTransactionBriefing } from '../src/formatters/llm-transaction';

const TEST_WALLET = 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg';
const TEST_TOKEN = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'; // BONK

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

// --- Setup ---
const cache = new Cache();
const helius = new HeliusClient(cache);
const birdeye = new BirdeyeClient(cache);
const jupiter = new JupiterClient(cache);
const solanaRpc = new SolanaRpcClient();

const profiler = new WalletProfiler(helius, birdeye, solanaRpc, jupiter, cache);
const analyzer = new TokenAnalyzer(helius, birdeye, jupiter, cache);
const txParser = new TxParser(helius, cache);

// ============================================================
// 1. Wallet Enrichment
// ============================================================
console.log('\n=== 1. Wallet Enrichment (light) ===');
const t1 = Date.now();
const wallet = await profiler.enrich(TEST_WALLET, 'light');
const walletMs = Date.now() - t1;
console.log(`  Completed in ${walletMs}ms`);

check('address populated', wallet.address === TEST_WALLET);
check('sol_balance is number', typeof wallet.sol_balance === 'number');
check('portfolio_value_usd is number', typeof wallet.portfolio_value_usd === 'number');
check('token_count > 0', wallet.token_count > 0, `got ${wallet.token_count}`);
check('top_holdings is array', Array.isArray(wallet.top_holdings));
check('nft_count is number', typeof wallet.nft_count === 'number');
check('labels is array', Array.isArray(wallet.labels) && wallet.labels.length > 0, `got [${wallet.labels}]`);
check('risk_score in [0, 1]', wallet.risk_score >= 0 && wallet.risk_score <= 1, `got ${wallet.risk_score}`);
check('risk_factors is array', Array.isArray(wallet.risk_factors));
check('first_tx_date is set', wallet.first_tx_date !== null);
check('last_updated is ISO string', wallet.last_updated.includes('T'));

// Cache hit test
console.log('\n  Cache hit test:');
const t2 = Date.now();
const walletCached = await profiler.enrich(TEST_WALLET, 'light');
const cacheMs = Date.now() - t2;
console.log(`  First: ${walletMs}ms, Cached: ${cacheMs}ms`);
check('cache hit is faster', cacheMs < walletMs / 2, `${cacheMs}ms vs ${walletMs}ms`);
check('cached data matches', walletCached.address === wallet.address);

// LLM format
console.log('\n  LLM format:');
const walletBriefing = formatWalletBriefing(wallet);
console.log(walletBriefing);
check('briefing is non-empty', walletBriefing.length > 50);
check('briefing under 2000 chars', walletBriefing.length < 2000, `got ${walletBriefing.length} chars`);

// format: "both"
const bothResult = formatResponse(wallet, 'both', formatWalletBriefing) as any;
check('both format has address', 'address' in bothResult);
check('both format has llm_summary', 'llm_summary' in bothResult);

// ============================================================
// 2. Token Enrichment
// ============================================================
console.log('\n=== 2. Token Enrichment (BONK) ===');
try {
  const token = await analyzer.enrich(TEST_TOKEN, true);
  console.log(`  ${token.symbol} — $${token.price_usd}`);

  check('mint matches', token.mint === TEST_TOKEN);
  check('symbol is BONK', token.symbol.toUpperCase().includes('BONK'), `got "${token.symbol}"`);
  check('decimals is number', typeof token.decimals === 'number');
  check('price_usd is number', typeof token.price_usd === 'number');
  check('market_cap is number', typeof token.market_cap === 'number');
  check('holder_count > 0', token.holder_count > 0, `got ${token.holder_count}`);
  check('risk_flags is array', Array.isArray(token.risk_flags));
  check('verified is boolean', typeof token.verified === 'boolean');
  check('top_holders present (includeHolders=true)', Array.isArray(token.top_holders));
  check('last_updated is ISO string', token.last_updated.includes('T'));

  const tokenBriefing = formatTokenBriefing(token);
  console.log('\n  LLM format:');
  console.log(tokenBriefing);
  check('token briefing non-empty', tokenBriefing.length > 50);
} catch (e: any) {
  console.log(`  SKIPPED — ${e.message}`);
  check('token enrichment succeeded', false, e.message);
}

// ============================================================
// 3. Transaction Enrichment
// ============================================================
console.log('\n=== 3. Transaction Enrichment ===');

// First get a real signature from the test wallet
let testSig: string | null = null;
try {
  const sigs = await helius.getSignaturesForAddress(TEST_WALLET, 5);
  testSig = sigs[0]?.signature ?? null;
  console.log(`  Using signature: ${testSig?.slice(0, 20)}...`);
} catch (e: any) {
  console.log(`  Could not fetch signatures: ${e.message}`);
}

if (testSig) {
  try {
    const tx = await txParser.enrich(testSig);
    if (tx) {
      check('signature matches', tx.signature === testSig);
      check('type is string', typeof tx.type === 'string' && tx.type.length > 0, `got "${tx.type}"`);
      check('fee_sol is number', typeof tx.fee_sol === 'number');
      check('fee_payer is string', typeof tx.fee_payer === 'string' && tx.fee_payer.length > 0);
      check('timestamp is ISO string', tx.timestamp.includes('T'));
      check('success is boolean', typeof tx.success === 'boolean');
      check('accounts_involved non-empty', tx.accounts_involved.length > 0);
      check('last_updated is ISO string', tx.last_updated.includes('T'));

      const txBriefing = formatTransactionBriefing(tx);
      console.log('\n  LLM format:');
      console.log(txBriefing);
      check('tx briefing non-empty', txBriefing.length > 50);
    } else {
      check('transaction found', false, 'parser returned null');
    }
  } catch (e: any) {
    console.log(`  SKIPPED — ${e.message}`);
    check('tx enrichment succeeded', false, e.message);
  }
} else {
  console.log('  SKIPPED — no signature available');
}

// ============================================================
// Summary
// ============================================================
console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed === 0) {
  console.log('✓ All Phase 7 enrichment verification tests passed');
} else {
  console.log(`✗ ${failed} test(s) failed`);
  process.exit(1);
}
