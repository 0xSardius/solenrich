#!/usr/bin/env bun
/**
 * Flash on-chain exploration: is Flash Trade's custody account layout the same
 * lineage as Jupiter Perps (so JupiterPerpsClient's decode + borrow-rate logic ports)?
 *
 * Anchor account discriminator = first 8 bytes of sha256("account:<Name>") — program
 * INDEPENDENT. So if Flash's custody disc == Jupiter's custody disc, both name the
 * account "Custody" and almost certainly share the struct. Also compares account size.
 *
 * Run: bun run test/flash-onchain-probe.ts
 */

const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

async function getAccount(pk: string): Promise<{ owner: string; len: number; disc: string } | null> {
  const r = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
      params: [pk, { encoding: 'base64' }],
    }),
  });
  const j = await r.json() as any;
  const v = j?.result?.value;
  if (!v) return null;
  const raw = Buffer.from(v.data[0], 'base64');
  return { owner: v.owner, len: raw.length, disc: raw.subarray(0, 8).toString('hex') };
}

const pd = await fetch('https://flashapi.trade/pool-data').then((r) => r.json()) as any;
const custodies: { symbol: string; custodyAccount: string }[] = [];
for (const pool of pd.pools ?? []) {
  for (const c of pool.custodyStats ?? []) {
    custodies.push({ symbol: c.symbol, custodyAccount: c.custodyAccount });
  }
}
console.log(`Flash exposes ${custodies.length} custody accounts. Symbols:`, [...new Set(custodies.map((c) => c.symbol))].join(', '));

const want = ['SOL', 'BTC', 'ETH', 'USDC'];
const samples = want.map((s) => custodies.find((c) => c.symbol === s)).filter(Boolean) as typeof custodies;

console.log('\n--- Flash custody accounts ---');
let flashProgram = '';
for (const s of samples) {
  const a = await getAccount(s.custodyAccount);
  if (a) flashProgram = a.owner;
  console.log(`FLASH ${s.symbol.padEnd(5)} ${s.custodyAccount}`);
  console.log(`        ${a ? `owner=${a.owner} len=${a.len} disc=${a.disc}` : 'NULL'}`);
}

console.log('\n--- Jupiter Perps custody (reference) ---');
const jup = await getAccount('7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz');
console.log(`JUPITER SOL  owner=${jup?.owner} len=${jup?.len} disc=${jup?.disc}`);

console.log('\n--- Verdict ---');
console.log(`Flash program ID: ${flashProgram || 'unknown'}`);
const flashSol = await getAccount(samples.find((s) => s.symbol === 'SOL')?.custodyAccount ?? '');
if (flashSol && jup) {
  console.log(`Custody discriminator match: ${flashSol.disc === jup.disc ? 'YES — same struct lineage' : 'NO — different account name/struct'}`);
  console.log(`Custody size: Flash ${flashSol.len}B vs Jupiter ${jup.len}B (${flashSol.len === jup.len ? 'identical' : 'differ — layout diverged'})`);
}
