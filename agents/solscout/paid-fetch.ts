/**
 * Wraps fetch with x402 payment — automatically handles 402 → pay → retry.
 *
 * Bypasses @x402/svm's `registerExactSvmScheme` helper because it has a bug:
 * it accepts a config object but never forwards `rpcUrl` to the scheme
 * constructor, so the scheme always falls back to https://api.mainnet-beta.solana.com.
 * That public RPC frequently drops sockets under @solana/kit's transport in Bun,
 * which surfaces as "Failed to create payment payload: socket connection closed".
 *
 * Workaround: register the schemes manually with our paid Helius RPC URL.
 */

import { createKeyPairSignerFromBytes } from '@solana/kit';
import { toClientSvmSigner } from '@x402/svm';
import { x402Client } from '@x402/core/client';
import { ExactSvmScheme } from '@x402/svm/exact/client';
import { ExactSvmSchemeV1 } from '@x402/svm/exact/v1/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { base58 } from '@scure/base';

const HELIUS_MAINNET_NETWORK = 'solana';
const SOLANA_NETWORKS = ['solana', 'solana-devnet', 'solana-testnet'] as const;

export async function createPaidFetch(): Promise<typeof fetch> {
  const privateKeyStr = process.env.SOLSCOUT_PRIVATE_KEY;
  if (!privateKeyStr) {
    throw new Error('SOLSCOUT_PRIVATE_KEY not set. Run: bun run agents/solscout/generate-wallet.ts');
  }

  const heliusKey = process.env.HELIUS_API_KEY;
  const heliusRpcUrl = heliusKey
    ? `https://mainnet.helius-rpc.com/?api-key=${heliusKey}`
    : undefined;

  if (!heliusRpcUrl) {
    console.log('  RPC:     public mainnet-beta (set HELIUS_API_KEY for paid Helius RPC)');
  } else {
    console.log('  RPC:     Helius (mainnet, paid)');
  }

  const keypair = await createKeyPairSignerFromBytes(base58.decode(privateKeyStr));
  const signer = toClientSvmSigner(keypair);
  console.log(`  Wallet:  ${keypair.address}`);

  const client = new x402Client();

  // Register the v2 mainnet scheme with our paid Helius RPC.
  // Match the helper's default catch-all of "solana:*" so any solana mainnet
  // CAIP-2 request matches.
  client.register('solana:*', new ExactSvmScheme(signer, { rpcUrl: heliusRpcUrl }));

  // Register v1 schemes for every supported network. Only mainnet gets the
  // Helius URL — devnet/testnet fall back to defaults (we don't use them).
  for (const network of SOLANA_NETWORKS) {
    const config = network === HELIUS_MAINNET_NETWORK ? { rpcUrl: heliusRpcUrl } : undefined;
    client.registerV1(network, new ExactSvmSchemeV1(signer, config));
  }

  const paidFetch = wrapFetchWithPayment(globalThis.fetch, client);
  console.log('  Payment: x402 enabled (USDC on Solana)\n');

  return paidFetch;
}
