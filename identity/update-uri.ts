/**
 * Point the 8004-solana agent asset at the current registration file (setAgentUri).
 *
 * The March registration (ipfs://bafkreih3…) listed only an A2A endpoint on the old Railway host and encoded
 * the Solana agent wallet as eip155:1. The new file is hosted on www (landing/agent-registration.json), so later
 * edits need no IPFS and no transaction.
 *
 * Dry run by default: prints signer, balance, current and new URI, and checks the new URI serves a registration.
 * Sends only with --send. The asset's on-chain name ("Agent") cannot change: its update authority is the
 * registry program, which exposes only setAgentUri.
 *
 * Run: bun --env-file=.env identity/update-uri.ts           (dry run)
 *      bun --env-file=.env identity/update-uri.ts --send    (sends one transaction)
 */
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import { SolanaSDK } from '8004-solana';

const ASSET = new PublicKey('5rsdgYL8mETFm785mXpEMYftjSE3H4JSqFANhJ4BoTHk');
const NEW_URI = 'https://www.solenrich.com/agent-registration.json';
const SEND = process.argv.includes('--send');

const key = process.env.SOLANA_PRIVATE_KEY;
if (!key) {
  console.error('SOLANA_PRIVATE_KEY is required (the asset owner key).');
  process.exit(1);
}
const signer = Keypair.fromSecretKey(bs58.decode(key));
const rpcUrl = `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`;
const connection = new Connection(rpcUrl, 'confirmed');

// Current state from the chain (DAS getAsset).
const das = await fetch(rpcUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: ASSET.toBase58() } }),
}).then((r) => r.json() as Promise<any>);
const asset = das.result;
const owner = asset?.ownership?.owner;
const currentUri = asset?.content?.json_uri;
const balance = await connection.getBalance(signer.publicKey);

console.log(`Signer:       ${signer.publicKey.toBase58()}`);
console.log(`Asset owner:  ${owner}`);
console.log(`Balance:      ${(balance / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
console.log(`Current URI:  ${currentUri}`);
console.log(`New URI:      ${NEW_URI}`);

if (owner !== signer.publicKey.toBase58()) {
  console.error('Signer is not the asset owner — refusing.');
  process.exit(1);
}
if (currentUri === NEW_URI) {
  console.log('Already pointing at the new URI. Nothing to do.');
  process.exit(0);
}

// The new URI must serve a valid registration before the chain points at it.
const reg = await fetch(NEW_URI).then((r) => (r.ok ? (r.json() as Promise<any>) : null)).catch(() => null);
if (!reg || reg.type !== 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1' || reg.name !== 'SolEnrich') {
  console.error('New URI does not serve the expected registration file — refusing.');
  process.exit(1);
}
console.log(`New file OK:  name=${reg.name}, services=${reg.services.map((s: any) => s.name).join(', ')}`);

if (!SEND) {
  console.log('\nDry run: nothing sent. Re-run with --send to submit one setAgentUri transaction.');
  process.exit(0);
}

const sdk = new SolanaSDK({ cluster: 'mainnet-beta', signer, rpcUrl } as any);
const result: any = await sdk.setAgentUri(ASSET, NEW_URI);
if (!result?.success) {
  console.error('setAgentUri failed:', result?.error ?? result);
  process.exit(1);
}
console.log(`Sent. Signature: ${result.signature}`);
process.exit(0);
