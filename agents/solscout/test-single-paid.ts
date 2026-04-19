#!/usr/bin/env bun
/**
 * Test a single paid request with verbose logging
 */

import { createKeyPairSignerFromBytes } from '@solana/kit';
import { toClientSvmSigner } from '@x402/svm';
import { x402Client } from '@x402/core/client';
import { registerExactSvmScheme } from '@x402/svm/exact/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { base58 } from '@scure/base';

const privateKeyStr = process.env.SOLSCOUT_PRIVATE_KEY;
if (!privateKeyStr) {
  console.error('Set SOLSCOUT_PRIVATE_KEY');
  process.exit(1);
}

const keypair = await createKeyPairSignerFromBytes(base58.decode(privateKeyStr));
const signer = toClientSvmSigner(keypair);
console.log('Wallet:', keypair.address);

const client = new x402Client();
registerExactSvmScheme(client, { signer });

// Wrap fetch with logging
const loggingFetch: typeof fetch = async (input, init) => {
  const req = input instanceof Request ? input : new Request(input, init);
  console.log(`\n>>> ${req.method} ${req.url}`);
  for (const [key, value] of req.headers.entries()) {
    if (key.toLowerCase().includes('x402') || key.toLowerCase().includes('payment')) {
      console.log(`    REQ ${key} (${value.length} chars):\n${value}\n`);
    }
  }

  const res = await globalThis.fetch(req);
  console.log(`<<< ${res.status} ${res.statusText}`);
  for (const [key, value] of res.headers.entries()) {
    if (key.toLowerCase().includes('x402') || key.toLowerCase().includes('payment')) {
      console.log(`    RES ${key} (${value.length} chars):\n${value}\n`);
    }
  }

  return res;
};

const paidFetch = wrapFetchWithPayment(loggingFetch, client);

console.log('\n=== Testing enrich-wallet-light with payment ===\n');

try {
  const res = await paidFetch(
    'https://api.solenrich.com/entrypoints/enrich-wallet-light/invoke',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: {
          address: 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg',
          format: 'json',
        },
      }),
    },
  );

  console.log(`\n=== Final response: ${res.status} ===`);
  const body = await res.text();
  console.log(body.slice(0, 500));
} catch (e: any) {
  console.error('Error:', e.message);
  console.error(e.stack);
}
