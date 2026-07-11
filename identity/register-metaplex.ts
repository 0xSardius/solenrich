/**
 * Register SolEnrich in the Metaplex 014 Agent Registry (onchain agent identity).
 *
 * One-call flow: mintAndSubmitAgent creates an MPL Core asset and registers the
 * Agent Identity PDA in a single atomic transaction. Costs standard tx fee +
 * rent (~0.005 SOL), no protocol fee.
 *
 * Prerequisites:
 *   - SOLANA_PRIVATE_KEY (base58) funded with SOL on mainnet
 *   - https://solenrich.com/agent-metadata.json publicly reachable (landing/)
 *
 * Run once: bun run identity/register-metaplex.ts
 */

import { mintAndSubmitAgent, mplAgentIdentity } from '@metaplex-foundation/mpl-agent-registry';
import { createUmi } from '@metaplex-foundation/umi-bundle-defaults';
import { keypairIdentity } from '@metaplex-foundation/umi';
import bs58 from 'bs58';

const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error('SOLANA_PRIVATE_KEY is required');
  process.exit(1);
}

const RPC = process.env.HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
  : 'https://api.mainnet-beta.solana.com';

// www is canonical (apex 307-redirects); use it directly so indexers that
// don't follow redirects still resolve the metadata.
const METADATA_URI = 'https://www.solenrich.com/agent-metadata.json';

// Sanity: metadata must be publicly reachable before minting an asset that points at it.
const probe = await fetch(METADATA_URI);
if (!probe.ok) {
  console.error(`Metadata not reachable (${probe.status}) at ${METADATA_URI} — deploy landing/ first.`);
  process.exit(1);
}
console.log('Metadata reachable:', METADATA_URI);

const umi = createUmi(RPC).use(mplAgentIdentity());
const keypair = umi.eddsa.createKeypairFromSecretKey(bs58.decode(PRIVATE_KEY));
umi.use(keypairIdentity(keypair));
console.log('Signer:', umi.identity.publicKey.toString());

const result = await mintAndSubmitAgent(umi, {}, {
  wallet: umi.identity.publicKey,
  name: 'SolEnrich',
  uri: METADATA_URI,
  agentMetadata: {
    type: 'agent',
    name: 'SolEnrich',
    description:
      'Agent-native onchain intelligence for Solana: wallet risk scoring, token due-diligence and rug detection, smart-money tracking across spot/perps/fresh launches, cross-venue perps funding, and LLM-ready briefings. 32 paid endpoints, per-call USDC via x402 on Solana or Base.',
    services: [
      { name: 'api', endpoint: 'https://api.solenrich.com' },
      { name: 'docs', endpoint: 'https://api.solenrich.com/docs' },
      { name: 'openapi', endpoint: 'https://api.solenrich.com/openapi.json' },
      { name: 'mcp', endpoint: 'https://api.solenrich.com/mcp' },
      { name: 'x402-discovery', endpoint: 'https://api.solenrich.com/.well-known/x402' },
    ],
    registrations: [],
    supportedTrust: ['reputation'],
  },
});

console.log('Asset address:', result.assetAddress?.toString?.() ?? result.assetAddress);
console.log('Signature:', result.signature?.toString?.() ?? result.signature);
console.log('Record these in CLAUDE.md / memory (Key Values).');
