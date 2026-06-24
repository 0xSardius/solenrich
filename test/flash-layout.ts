#!/usr/bin/env bun
/**
 * Compute Flash Custody Borsh field offsets from the saved IDL, verify the total
 * matches the live 704-byte account, and decode a live SOL custody to confirm
 * utilization + borrow-rate fields. Also prints BorrowRateParams/State + Market
 * struct shapes so we know Flash's borrow formula and where OI lives.
 *
 * Run: bun run test/flash-layout.ts
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { readFileSync } from 'node:fs';

const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const idl = JSON.parse(readFileSync('src/idl/flash-perpetuals-idl.json', 'utf8'));
const types: any[] = idl.types ?? [];
const findType = (n: string) => types.find((t) => t.name === n);

const PRIM: Record<string, number> = {
  bool: 1, u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4,
  u64: 8, i64: 8, u128: 16, i128: 16, pubkey: 32, publicKey: 32,
};

function refName(t: any): string | null {
  if (t?.defined) return typeof t.defined === 'string' ? t.defined : t.defined.name;
  return null;
}

function typeSize(t: any): number {
  if (typeof t === 'string') {
    if (PRIM[t] != null) return PRIM[t];
    throw new Error('unknown prim: ' + t);
  }
  if (t.array) return t.array[1] * typeSize(t.array[0]);
  const dn = refName(t);
  if (dn) {
    const def = findType(dn);
    if (!def) throw new Error('missing type: ' + dn);
    if (def.type.kind === 'enum') {
      // unit (C-like) enum = 1 byte discriminant
      const hasData = (def.type.variants ?? []).some((v: any) => v.fields);
      if (hasData) throw new Error(`enum ${dn} has data variants — not fixed`);
      return 1;
    }
    return structSize(def.type.fields);
  }
  throw new Error('unknown type: ' + JSON.stringify(t));
}
function structSize(fields: any[]): number {
  return fields.reduce((s, f) => s + typeSize(f.type), 0);
}

// Print key nested struct shapes
for (const n of ['BorrowRateParams', 'BorrowRateState', 'Market', 'OracleParams']) {
  const t = findType(n);
  if (t?.type?.fields) {
    console.log(`\n=== ${n} (${structSize(t.type.fields)}B) ===`);
    for (const f of t.type.fields) console.log(`  ${f.name}: ${JSON.stringify(f.type)} [${typeSize(f.type)}B]`);
  } else if (t) {
    console.log(`\n=== ${n} === kind=${t.type.kind}`, JSON.stringify(t.type).slice(0, 200));
  }
}

// Compute Custody field offsets (account data starts after 8-byte disc)
const custody = findType('Custody');
const offsets: Record<string, { off: number; size: number }> = {};
let off = 8;
for (const f of custody.type.fields) {
  offsets[f.name] = { off, size: typeSize(f.type) };
  off += typeSize(f.type);
}
console.log(`\n=== Custody total: ${off}B (account should be 704) ===`);
const want = ['decimals', 'is_stable', 'borrow_rate', 'token_amount_multiplier', 'assets', 'borrow_rate_state'];
for (const w of want) console.log(`  ${w}: offset ${offsets[w].off}, size ${offsets[w].size}`);

// Sub-offsets within Assets {collateral u64, owned u64, locked u64}
const assetsOff = offsets['assets'].off;
console.log(`  assets.collateral @ ${assetsOff}, assets.owned @ ${assetsOff + 8}, assets.locked @ ${assetsOff + 16}`);

// Decode a live SOL custody to verify
const conn = new Connection(RPC, 'confirmed');
const pd = await fetch('https://flashapi.trade/pool-data').then((r) => r.json()) as any;
let solCustody = '', solUtil = '';
for (const pool of pd.pools ?? []) for (const c of pool.custodyStats ?? []) {
  if (c.symbol === 'SOL') { solCustody = c.custodyAccount; solUtil = c.utilizationUi; break; }
}
console.log(`\n=== Live verify: SOL custody ${solCustody} (pool-data utilizationUi=${solUtil}) ===`);
const acc = await conn.getAccountInfo(new PublicKey(solCustody));
if (!acc) { console.log('null'); process.exit(1); }
const buf = acc.data;
console.log(`account len: ${buf.length}`);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
const decimals = dv.getUint8(offsets['decimals'].off);
const owned = dv.getBigUint64(assetsOff + 8, true);
const locked = dv.getBigUint64(assetsOff + 16, true);
const util = owned === 0n ? 0 : Number(locked) / Number(owned);
console.log(`decimals=${decimals} owned=${owned} locked=${locked} utilization=${(util * 100).toFixed(2)}% (expect ~${solUtil}%)`);

// Dump raw borrow_rate + borrow_rate_state field values
function dumpStruct(name: string, baseOff: number) {
  const t = findType(name);
  console.log(`\n--- ${name} raw @ ${baseOff} ---`);
  let o = baseOff;
  for (const f of t.type.fields) {
    const sz = typeSize(f.type);
    let val: any = '(' + sz + 'B)';
    if (sz === 8) val = dv.getBigUint64(o, true).toString();
    else if (sz === 4) val = dv.getUint32(o, true);
    else if (sz === 2) val = dv.getUint16(o, true);
    else if (sz === 1) val = dv.getUint8(o);
    console.log(`  ${f.name} @ ${o}: ${val}`);
    o += sz;
  }
}
dumpStruct('BorrowRateParams', offsets['borrow_rate'].off);
dumpStruct('BorrowRateState', offsets['borrow_rate_state'].off);
