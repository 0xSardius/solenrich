/**
 * Phase 8: Register SolEnrich agent on 8004-solana registry
 *
 * 3-step process:
 *   1. Create collection (Parallax Labs Agents)
 *   2. Register agent with metadata on IPFS
 *   3. Set operational wallet
 *
 * Prerequisites:
 *   - SOLANA_PRIVATE_KEY funded with SOL (devnet or mainnet)
 *   - PINATA_JWT set for IPFS uploads
 *
 * Run: bun run identity/register.ts
 */

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  SolanaSDK,
  IPFSClient,
  ServiceType,
  buildCollectionMetadataJson,
  buildRegistrationFileJson,
} from '8004-solana';
import type { SolanaSDKConfig } from '8004-solana';

// --- Config ---

const CLUSTER = (process.env.REGISTRY_CLUSTER ?? 'mainnet-beta') as 'devnet' | 'mainnet-beta';
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY;
const PINATA_JWT = process.env.PINATA_JWT;

if (!PRIVATE_KEY || PRIVATE_KEY === '') {
  console.error('SOLANA_PRIVATE_KEY is required');
  process.exit(1);
}

if (!PINATA_JWT || PINATA_JWT === 'your_pinata_jwt_for_ipfs') {
  console.error('PINATA_JWT is required (set a real Pinata JWT, not placeholder)');
  process.exit(1);
}

// --- Initialize ---

const signer = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
console.log(`Signer: ${signer.publicKey.toBase58()}`);
console.log(`Cluster: ${CLUSTER}`);

const ipfs = new IPFSClient({
  pinataEnabled: true,
  pinataJwt: PINATA_JWT,
});

const sdkConfig: SolanaSDKConfig = {
  cluster: CLUSTER,
  signer,
  ipfsClient: ipfs,
};

const sdk = new SolanaSDK(sdkConfig);

// ============================================================
// Step 1: Create collection metadata (upload only, no on-chain tx)
// ============================================================
console.log('\n=== Step 1: Create Collection ===');

const collectionResult = await sdk.createCollection({
  name: 'Parallax Labs Agents',
  description: 'Onchain agentic services by Parallax Labs',
  category: 'data-analysis',
  tags: ['solana', 'enrichment', 'data', 'x402', 'agents'],
  project: {
    name: 'Parallax Labs',
    socials: {
      website: 'https://parallaxlabs.xyz',
      x: 'parallaxlabs',
    },
  },
});

console.log(`Collection CID: ${collectionResult.cid}`);
console.log(`Collection URI: ${collectionResult.uri}`);
console.log(`Collection pointer: ${collectionResult.pointer}`);

// ============================================================
// Step 2: Build agent metadata, upload to IPFS, register on-chain
// ============================================================
console.log('\n=== Step 2: Register Agent ===');

const DEPLOY_URL = process.env.AGENT_URL ?? 'https://solenrich-production.up.railway.app';

const registrationFile = buildRegistrationFileJson({
  name: 'SolEnrich',
  description:
    'Solana onchain data enrichment agent. Wallet profiling, token analysis, DeFi positions, risk scoring. JSON for agents, natural language for LLMs. Powered by x402 micropayments.',
  services: [
    { type: ServiceType.A2A, value: `${DEPLOY_URL}/.well-known/agent.json` },
  ],
  skills: [
    'data_engineering/data_engineering',
    'natural_language_processing/information_retrieval_synthesis/information_retrieval_synthesis',
  ],
  walletAddress: signer.publicKey.toBase58(),
  x402Support: true,
  active: true,
  metadata: {
    chains: ['solana'],
    formats: ['json', 'llm', 'both'],
    pricing: {
      currency: 'USDC',
      min: '0.001',
      max: '0.025',
    },
    capabilities: [
      'wallet-enrichment',
      'token-analysis',
      'transaction-parsing',
      'risk-scoring',
      'llm-optimized-data',
    ],
  },
});

// Upload metadata to IPFS
const agentMetaCid = await ipfs.addJson(registrationFile as Record<string, unknown>);
const agentUri = `ipfs://${agentMetaCid}`;
console.log(`Agent metadata URI: ${agentUri}`);

// Register on-chain
const registerResult = await sdk.registerAgent(agentUri, {
  collectionPointer: collectionResult.pointer,
});

if (!registerResult.success) {
  console.error('Registration failed:', registerResult.error);
  process.exit(1);
}

const assetPubkey = registerResult.asset;
console.log(`Agent registered! Asset: ${assetPubkey?.toBase58()}`);
console.log(`Tx signature: ${registerResult.signature}`);

// ============================================================
// Step 3: Set operational wallet
// ============================================================
console.log('\n=== Step 3: Set Operational Wallet ===');

const opWallet = Keypair.generate();
const walletResult = await sdk.setAgentWallet(assetPubkey!, opWallet);

if (!walletResult || ('success' in walletResult && !walletResult.success)) {
  console.error('Failed to set operational wallet');
  process.exit(1);
}

console.log(`Operational wallet: ${opWallet.publicKey.toBase58()}`);

// ============================================================
// Output: values to add to .env
// ============================================================
console.log('\n=== Add these to your .env ===');
console.log(`AGENT_ASSET=${assetPubkey?.toBase58()}`);
console.log(`OPERATIONAL_WALLET_ADDRESS=${opWallet.publicKey.toBase58()}`);
console.log(`OPERATIONAL_WALLET_PRIVATE_KEY=${bs58.encode(opWallet.secretKey)}`);

// Cleanup
await ipfs.close();
console.log('\nDone! Agent identity registered on 8004-solana registry.');
