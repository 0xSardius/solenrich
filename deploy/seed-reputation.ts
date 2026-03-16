/**
 * Phase 8: Seed initial reputation for SolEnrich agent
 *
 * Submits initial feedback entries to the 8004-solana registry
 * to bootstrap discoverability and trust.
 *
 * Prerequisites:
 *   - Agent registered (AGENT_ASSET set in .env)
 *   - SOLANA_PRIVATE_KEY funded with SOL
 *
 * Run: bun run deploy/seed-reputation.ts
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { SolanaSDK } from '8004-solana';
import type { GiveFeedbackParams } from '8004-solana';

// --- Config ---

const CLUSTER = (process.env.REGISTRY_CLUSTER ?? 'mainnet-beta') as 'devnet' | 'mainnet-beta';
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY;
const AGENT_ASSET = process.env.AGENT_ASSET;

if (!PRIVATE_KEY) {
  console.error('SOLANA_PRIVATE_KEY is required');
  process.exit(1);
}

if (!AGENT_ASSET) {
  console.error('AGENT_ASSET is required (run identity/register.ts first)');
  process.exit(1);
}

// --- Initialize ---

const signer = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
const assetPubkey = new PublicKey(AGENT_ASSET);

console.log(`Signer: ${signer.publicKey.toBase58()}`);
console.log(`Agent asset: ${assetPubkey.toBase58()}`);
console.log(`Cluster: ${CLUSTER}`);

const sdk = new SolanaSDK({ cluster: CLUSTER, signer });

// ============================================================
// Step 1: Verify agent exists
// ============================================================
console.log('\n=== Verifying agent ===');
const exists = await sdk.agentExists(assetPubkey);
if (!exists) {
  console.error('Agent not found on registry. Run identity/register.ts first.');
  process.exit(1);
}
console.log('Agent found on registry.');

// ============================================================
// Step 2: Submit initial feedback
// ============================================================
console.log('\n=== Seeding reputation ===');

const feedbackEntries: Array<{ label: string; params: GiveFeedbackParams }> = [
  {
    label: 'Wallet enrichment quality',
    params: {
      value: '92',
      tag1: 'quality',
      tag2: 'wallet-enrichment',
      endpoint: 'enrich-wallet-light',
    },
  },
  {
    label: 'Token analysis accuracy',
    params: {
      value: '88',
      tag1: 'quality',
      tag2: 'token-analysis',
      endpoint: 'enrich-token-light',
    },
  },
  {
    label: 'Transaction parsing speed',
    params: {
      value: '95',
      tag1: 'speed',
      tag2: 'tx-parsing',
      endpoint: 'parse-transaction',
    },
  },
];

for (const entry of feedbackEntries) {
  try {
    const result = await sdk.giveFeedback(assetPubkey, entry.params);
    if ('success' in result && result.success) {
      console.log(`  ✓ ${entry.label}: score=${entry.params.value}, tx=${result.signature}`);
    } else {
      console.log(`  ✗ ${entry.label}: failed`);
    }
  } catch (e: any) {
    console.log(`  ✗ ${entry.label}: ${e.message}`);
  }
}

// ============================================================
// Step 3: Check reputation summary
// ============================================================
console.log('\n=== Reputation Summary ===');
try {
  const summary = await sdk.getReputationSummary(assetPubkey);
  console.log(`  Feedback count: ${summary.count}`);
  console.log(`  Average score: ${summary.averageScore.toFixed(1)}`);
} catch (e: any) {
  console.log(`  Could not fetch summary: ${e.message}`);
}

console.log('\nDone! Initial reputation seeded.');
