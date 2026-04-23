#!/usr/bin/env bun
/**
 * Paid E2E test for the two new orchestration endpoints.
 * Costs: $0.050 (trending-signals) + $0.100 (smart-money-flow) = $0.15 USDC.
 */

import { createKeyPairSignerFromBytes } from '@solana/kit';
import { toClientSvmSigner } from '@x402/svm';
import { x402Client } from '@x402/core/client';
import { registerExactSvmScheme } from '@x402/svm/exact/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { base58 } from '@scure/base';

const privateKeyStr = process.env.SOLSCOUT_PRIVATE_KEY;
if (!privateKeyStr) {
  console.error('Set SOLSCOUT_PRIVATE_KEY');
  process.exit(1);
}

const keypair = await createKeyPairSignerFromBytes(base58.decode(privateKeyStr));
const signer = toClientSvmSigner(keypair);
console.log('Wallet:', keypair.address);

const client = new x402Client();
registerExactSvmScheme(client, { signer });
const paidFetch = wrapFetchWithPayment(globalThis.fetch, client);

async function testEndpoint(key: string, input: Record<string, unknown>, expectedChecks: (d: any) => string[]) {
  console.log(`\n=== ${key} ===`);
  const t0 = Date.now();
  const res = await paidFetch(
    `https://api.solenrich.com/entrypoints/${key}/invoke`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    },
  );
  const ms = Date.now() - t0;
  console.log(`status: ${res.status}  latency: ${ms}ms`);
  const body = await res.json() as any;
  if (res.status !== 200) {
    console.log('ERROR body:', JSON.stringify(body).slice(0, 500));
    return false;
  }
  const data = body.output;
  const failures = expectedChecks(data);
  if (failures.length > 0) {
    console.log('FAIL checks:');
    for (const f of failures) console.log('  ✗', f);
    return false;
  }
  console.log('all checks PASS');
  console.log('sample output:', JSON.stringify(data).slice(0, 400));
  return true;
}

const trendingOk = await testEndpoint(
  'trending-signals',
  { format: 'both', limit: 5, min_liquidity_usd: 5000, include_whale_watch: false },
  (d) => {
    const f: string[] = [];
    if (!Array.isArray(d.tokens)) f.push('tokens is not an array');
    if (typeof d.total_scanned !== 'number') f.push('missing total_scanned');
    if (!d.filters) f.push('missing filters');
    if (!d.overall_sentiment) f.push('missing overall_sentiment');
    if (typeof d.llm_summary !== 'string' || d.llm_summary.length < 50) f.push('llm_summary too short');
    return f;
  },
);

const smartMoneyOk = await testEndpoint(
  'smart-money-flow',
  { format: 'both', lookback_days: 14, min_win_rate: 0.5, top_n_tokens: 5, include_graph: false },
  (d) => {
    const f: string[] = [];
    if (typeof d.seed_wallets_considered !== 'number') f.push('missing seed_wallets_considered');
    if (!Array.isArray(d.qualifying_smart_wallets)) f.push('qualifying_smart_wallets is not an array');
    if (!Array.isArray(d.accumulated_tokens)) f.push('accumulated_tokens is not an array');
    if (!Array.isArray(d.clusters)) f.push('clusters is not an array');
    if (!d.filters) f.push('missing filters');
    if (typeof d.llm_summary !== 'string' || d.llm_summary.length < 50) f.push('llm_summary too short');
    return f;
  },
);

console.log('\n=== RESULT ===');
console.log('trending-signals:', trendingOk ? 'PASS' : 'FAIL');
console.log('smart-money-flow:', smartMoneyOk ? 'PASS' : 'FAIL');
if (!trendingOk || !smartMoneyOk) process.exit(1);
