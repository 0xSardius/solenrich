#!/usr/bin/env bun
/**
 * Direct CDP facilitator auth test. Reads CDP_API_KEY_ID + CDP_API_KEY_SECRET
 * from env, signs a JWT with Coinbase's own SDK, and GETs /supported.
 * Surfaces whatever CDP returns so we can tell scope/key/signature errors apart.
 */

import { createAuthHeader } from '@coinbase/x402';

const keyId = process.env.CDP_API_KEY_ID;
const keySecret = process.env.CDP_API_KEY_SECRET;
if (!keyId || !keySecret) {
  console.error('Set CDP_API_KEY_ID + CDP_API_KEY_SECRET');
  process.exit(1);
}

const url = 'https://api.cdp.coinbase.com/platform/v2/x402';
const host = new URL(url).host;
const path = '/platform/v2/x402/supported';

console.log('Key ID:', keyId.slice(0, 8) + '...' + keyId.slice(-4));
console.log('Secret format:', keySecret.startsWith('-----BEGIN') ? 'PEM EC' : 'base64 Ed25519?');
console.log('Signing JWT...');

const authHeader = await createAuthHeader(keyId, keySecret, 'GET', host, path);
console.log('Auth header (first 50 chars):', authHeader.slice(0, 50) + '...');

const res = await fetch(url + '/supported', {
  method: 'GET',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': authHeader,
  },
});

console.log('\nStatus:', res.status, res.statusText);
console.log('Headers:');
for (const [k, v] of res.headers.entries()) {
  console.log(`  ${k}: ${v.slice(0, 120)}`);
}
console.log('\nBody:');
const body = await res.text();
console.log(body || '(empty)');
