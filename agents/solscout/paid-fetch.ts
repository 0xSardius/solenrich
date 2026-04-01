/**
 * Wraps fetch with x402 payment — automatically handles 402 → pay → retry
 */

import { createKeyPairSignerFromBytes } from '@solana/kit';
import { toClientSvmSigner } from '@x402/svm';
import { x402Client } from '@x402/core/client';
import { registerExactSvmScheme } from '@x402/svm/exact/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { base58 } from '@scure/base';

export async function createPaidFetch(): Promise<typeof fetch> {
  const privateKeyStr = process.env.SOLSCOUT_PRIVATE_KEY;
  if (!privateKeyStr) {
    throw new Error('SOLSCOUT_PRIVATE_KEY not set. Run: bun run agents/solscout/generate-wallet.ts');
  }

  const keypair = await createKeyPairSignerFromBytes(base58.decode(privateKeyStr));
  const signer = toClientSvmSigner(keypair);
  console.log(`  Wallet:  ${keypair.address}`);

  const client = new x402Client();
  registerExactSvmScheme(client, { signer });

  const paidFetch = wrapFetchWithPayment(globalThis.fetch, client);
  console.log('  Payment: x402 enabled (USDC on Solana)\n');

  return paidFetch;
}
