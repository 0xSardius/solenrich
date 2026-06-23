#!/usr/bin/env bun
/**
 * Fetch Flash Trade's on-chain Anchor IDL (published at the standard IDL PDA),
 * decompress it, save to src/idl/, and confirm the Custody struct has the fields
 * our JupiterPerps borrow-rate + OI logic needs (assets, jumpRateState, pricing).
 *
 * Run: bun run test/flash-idl-fetch.ts
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { inflate } from 'node:zlib';
import { promisify } from 'node:util';
import { writeFileSync } from 'node:fs';

const inflateAsync = promisify(inflate);
const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const PROGRAM = new PublicKey('FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn');

const conn = new Connection(RPC, 'confirmed');

// Anchor IDL account address: createWithSeed(base, "anchor:idl", programId), base = PDA([], programId)
const [base] = PublicKey.findProgramAddressSync([], PROGRAM);
const idlAddr = await PublicKey.createWithSeed(base, 'anchor:idl', PROGRAM);
console.log('IDL account:', idlAddr.toBase58());

const acc = await conn.getAccountInfo(idlAddr);
if (!acc) {
  console.log('No on-chain IDL account found — fall back to the flash-trade/flash-perpetuals GitHub repo.');
  process.exit(1);
}

// Layout: 8-byte disc + 32-byte authority + 4-byte LE length + zlib(IDL JSON)
const data = acc.data;
const len = data.readUInt32LE(40);
const compressed = data.subarray(44, 44 + len);
const json = (await inflateAsync(compressed)).toString('utf8');
const idl = JSON.parse(json);

console.log(`IDL: name=${idl.name} version=${idl.version} accounts=[${(idl.accounts ?? []).map((a: any) => a.name).join(', ')}]`);

writeFileSync('src/idl/flash-perpetuals-idl.json', JSON.stringify(idl, null, 2));
console.log('Wrote src/idl/flash-perpetuals-idl.json');

// New Anchor IDL (0.30+): account structs live in idl.types, not inline.
const types: any[] = idl.types ?? [];
const findType = (n: string) => types.find((t) => t.name === n);

const custody = findType('Custody');
if (!custody) {
  console.log('\nNo Custody struct in idl.types — names:', types.map((t) => t.name).join(', '));
  process.exit(0);
}
console.log('\n=== Custody struct field order (for Borsh offset computation) ===');
for (const f of custody.type.fields) {
  console.log(`  ${f.name}: ${JSON.stringify(f.type)}`);
}
// Expand the nested structs we need (assets + jump-rate)
for (const n of ['Assets', 'JumpRateState', 'FundingRateState', 'PricingParams']) {
  const t = findType(n);
  if (t) console.log(`\n=== ${n} ===\n  ` + t.type.fields.map((f: any) => `${f.name}: ${JSON.stringify(f.type)}`).join('\n  '));
}
