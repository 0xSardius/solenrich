// Smoke test for Phase 1 modules
import { CONFIG, PRICING, CACHE_TTL } from '../src/config';
import { FormatSchema, DepthSchema, SolanaAddressSchema, TxSignatureSchema } from '../src/schemas/common';
import { parallelFetch } from '../src/utils/parallel';
import { shortenAddress, formatUsd, formatNumber, lamportsToSol, tokenAmountToDecimal } from '../src/utils/normalize';
import { Cache } from '../src/cache/index';

// --- Config ---
console.log('CONFIG.helius.baseUrl:', CONFIG.helius.baseUrl);
console.log('PRICING enrich-wallet-full:', PRICING['enrich-wallet-full']);
console.log('CACHE_TTL walletProfile:', CACHE_TTL.walletProfile);

// --- Schemas ---
const fmt = FormatSchema.parse('llm');
console.log('FormatSchema parse "llm":', fmt);

const depth = DepthSchema.parse(undefined); // should default to 'light'
console.log('DepthSchema default:', depth);

const addr = SolanaAddressSchema.safeParse('vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg');
console.log('SolanaAddress valid:', addr.success);

const badAddr = SolanaAddressSchema.safeParse('0xinvalid');
console.log('SolanaAddress invalid:', !badAddr.success);

const sig = TxSignatureSchema.safeParse('5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW');
console.log('TxSignature valid:', sig.success);

// --- Normalize ---
console.log('shortenAddress:', shortenAddress('vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg'));
console.log('formatUsd:', formatUsd(1234567.89));
console.log('formatNumber:', formatNumber(2500000));
console.log('lamportsToSol:', lamportsToSol(1_000_000_000));
console.log('tokenAmountToDecimal:', tokenAmountToDecimal(5000000, 6));

// --- parallelFetch ---
const results = await parallelFetch([
  { name: 'fast', fn: async () => 'ok' },
  { name: 'slow', fn: () => new Promise((_, rej) => setTimeout(() => rej('timeout'), 50)), fallback: 'fell back' },
]);
console.log('parallelFetch fast:', results.fast);
console.log('parallelFetch slow (fallback):', results.slow);

// --- Cache ---
const cache = new Cache();
await cache.set('test-key', { hello: 'world' }, 60);
const val = await cache.get<{ hello: string }>('test-key');
console.log('Cache round-trip:', val?.hello === 'world' ? 'PASS' : 'FAIL');

await cache.del('test-key');
const deleted = await cache.get('test-key');
console.log('Cache delete:', deleted === null ? 'PASS' : 'FAIL');

console.log('\n✓ All Phase 1 smoke tests passed');
