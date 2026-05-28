import { Connection, PublicKey } from '@solana/web3.js';

const apiKey = process.env.HELIUS_API_KEY;
const RPC = process.env.HELIUS_RPC_URL || (apiKey ? `https://mainnet.helius-rpc.com/?api-key=${apiKey}` : null);
if (!RPC) {
  console.error('Set HELIUS_API_KEY in .env');
  process.exit(1);
}
const PROGRAM = new PublicKey('13gDzEXCdocbj8iAiqrScGo47NiSuYENGsRqi3SEAwet');
const POS_DISC = Buffer.from([170, 188, 143, 228, 122, 64, 247, 208]).toString('base64');
const conn = new Connection(RPC, 'confirmed');

const accounts = await conn.getProgramAccounts(PROGRAM, {
  commitment: 'confirmed',
  filters: [
    { memcmp: { offset: 0, bytes: POS_DISC, encoding: 'base64' } },
  ],
  dataSlice: { offset: 0, length: 200 },
});

console.log('Position accounts:', accounts.length);
if (accounts.length === 0) process.exit(0);

const decoded = accounts.map(({ pubkey, account }) => {
  const buf = account.data;
  const side = buf.readUInt8(9);
  const owner = new PublicKey(buf.subarray(16, 48)).toBase58();
  const custody = new PublicKey(buf.subarray(80, 112)).toBase58();
  const sizeUsd = Number(buf.readBigUInt64LE(168)) / 1_000_000;
  const collatUsd = Number(buf.readBigUInt64LE(184)) / 1_000_000;
  return { pda: pubkey.toBase58(), owner, custody, side, sizeUsd, collatUsd, accountSize: account.data.length };
});

const open = decoded.filter(d => d.sizeUsd > 0);
console.log('open positions:', open.length, 'closed:', decoded.length - open.length);
const sizes = [...new Set(decoded.map(d => d.accountSize))];
console.log('account sizes seen:', sizes);

const byOwner = new Map();
for (const d of open) {
  if (!byOwner.has(d.owner)) byOwner.set(d.owner, []);
  byOwner.get(d.owner).push(d);
}
const multi = [...byOwner.entries()].filter(([_, ps]) => ps.length >= 2);
multi.sort((a, b) => b[1].reduce((s, p) => s + p.sizeUsd, 0) - a[1].reduce((s, p) => s + p.sizeUsd, 0));

console.log('\ntop traders (multi-position):');
for (const [owner, ps] of multi.slice(0, 5)) {
  const totalSize = ps.reduce((s, p) => s + p.sizeUsd, 0);
  console.log(`  ${owner} — ${ps.length} positions, total $${totalSize.toFixed(0)} gross`);
  for (const p of ps) console.log(`    side=${p.side} custody=${p.custody.slice(0, 8)}... size=$${p.sizeUsd.toFixed(0)} collat=$${p.collatUsd.toFixed(0)}`);
}
