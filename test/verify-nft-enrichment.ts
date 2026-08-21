// Live verification for the wallet NFT enrichment upgrade.
// Run: bun run test/verify-nft-enrichment.ts
//
// The second wallet is the one that motivated the change: it holds 118
// non-fungibles, of which 103 are compressed drops and several are drainer bait.

import { Cache } from '../src/cache';
import { HeliusClient } from '../src/sources/helius';
import { DexScreenerClient } from '../src/sources/dexscreener';
import { SolanaRpcClient } from '../src/sources/solana-rpc';
import { WalletProfiler } from '../src/enrichers/wallet-profiler';
import { formatWalletBriefing } from '../src/formatters/llm-wallet';

const WALLETS: Array<[string, string]> = [
  ['airdrop-spammed', '9UfXX287j3x8AKVny4GxCfd2ADVaS8ABM3MEZPtDoPs3'],
  ['real collector', 'CxBhuJwhVgNMc7yjnRx3XFAsTnnbYDc2bhAGSaLBjNqZ'],
  ['solana foundation', 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg'],
];

const cache = new Cache();
const profiler = new WalletProfiler(
  new HeliusClient(cache),
  new SolanaRpcClient(cache),
  new DexScreenerClient(cache),
  cache,
);

for (const [label, address] of WALLETS) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`${label}  ${address}`);
  console.log('='.repeat(70));

  const r = await profiler.enrich(address, 'light');
  const s = r.nft_summary;

  console.log(
    `nft_count=${r.nft_count}  collected=${s.collected}  airdropped=${s.airdropped}  ` +
      `spam=${s.suspected_spam}  collections=${s.distinct_collections}`,
  );

  const sum = s.collected + s.airdropped + s.suspected_spam;
  console.log(`buckets sum to total: ${sum === s.total ? 'yes' : `NO (${sum} vs ${s.total})`}`);
  console.log(`labels: ${r.labels.join(', ') || '(none)'}`);

  if (r.nft_collections.length > 0) {
    console.log('breakdown:');
    for (const c of r.nft_collections) {
      const tag = c.suspected_spam ? 'SPAM' : c.compressed ? 'cNFT' : 'NFT ';
      console.log(`  ${String(c.count).padStart(4)}x  ${tag}  ${c.name.slice(0, 50)}`);
    }
  }

  console.log('\n--- LLM briefing (NFT lines) ---');
  for (const line of formatWalletBriefing(r).split('\n')) {
    if (/NFT|Holds|spam/i.test(line)) console.log(`  ${line}`);
  }
}
