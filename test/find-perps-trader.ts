/**
 * One-off: find a wallet with open Jupiter Perps positions for testing
 * the perps-trader-profile endpoint against real data.
 *
 * Run: bun run test/find-perps-trader.ts
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { AnchorProvider, Program, Wallet, BN } from '@coral-xyz/anchor';
import { Perpetuals } from '../src/idl/jupiter-perpetuals';
import { IDL } from '../src/idl/jupiter-perpetuals-idl';

const PERPS_PROGRAM_ID = new PublicKey('PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu');

const HELIUS_KEY = process.env.HELIUS_API_KEY;
if (!HELIUS_KEY) {
  console.error('HELIUS_API_KEY not set');
  process.exit(1);
}

const connection = new Connection(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`, 'confirmed');

// Provider needs a wallet but we're only reading
const dummyKeypair = { publicKey: PublicKey.default, signTransaction: async (t: any) => t, signAllTransactions: async (ts: any) => ts };
const provider = new AnchorProvider(connection, dummyKeypair as any, { commitment: 'confirmed' });
const program = new Program<Perpetuals>(IDL as any, PERPS_PROGRAM_ID, provider);

console.log('Fetching all Jupiter Perps positions...');
const all = await program.account.position.all();
console.log(`Total position accounts: ${all.length}`);

const open = all.filter(p => !(p.account.sizeUsd as BN).isZero());
console.log(`Open positions (sizeUsd > 0): ${open.length}`);

// Group by owner so we can find traders with multiple positions (more interesting demo)
const byOwner = new Map<string, number>();
for (const p of open) {
  const owner = (p.account.owner as PublicKey).toBase58();
  byOwner.set(owner, (byOwner.get(owner) ?? 0) + 1);
}

const sorted = Array.from(byOwner.entries()).sort((a, b) => b[1] - a[1]);
console.log(`\nTop traders by position count:`);
for (const [owner, count] of sorted.slice(0, 10)) {
  // Sum size of their positions
  const positions = open.filter(p => (p.account.owner as PublicKey).toBase58() === owner);
  const totalSizeUsd = positions.reduce((s, p) => {
    const size = (p.account.sizeUsd as BN).toNumber() / 1e6;
    return s + size;
  }, 0);
  console.log(`  ${owner}  positions=${count}  total_size=$${totalSizeUsd.toFixed(0)}`);
}
