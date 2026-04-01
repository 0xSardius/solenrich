/**
 * Wraps fetch with x402 payment — automatically handles 402 → pay → retry
 */

import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';

export async function createPaidFetch(): Promise<typeof fetch> {
  const privateKeyStr = process.env.SOLSCOUT_PRIVATE_KEY;
  if (!privateKeyStr) {
    throw new Error('SOLSCOUT_PRIVATE_KEY not set. Run: bun run agents/solscout/generate-wallet.ts');
  }

  const secretKey = bs58.decode(privateKeyStr);
  const keypair = Keypair.fromSecretKey(secretKey);
  console.log(`  Wallet:  ${keypair.publicKey.toBase58()}`);

  // Dynamic imports for x402 client
  const { x402Client } = await import('@x402/core/client');
  const { registerExactSvmScheme } = await import('@x402/svm/exact/client');
  const { wrapFetchWithPayment } = await import('@x402/fetch');

  const client = new x402Client();
  registerExactSvmScheme(client, { signer: keypair as any });

  const paidFetch = wrapFetchWithPayment(globalThis.fetch, client);
  console.log('  Payment: x402 enabled (USDC on Solana)\n');

  return paidFetch;
}
