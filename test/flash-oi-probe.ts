// Probe: read Flash Market accounts to derive per-symbol OI long/short.
//
// Market layout (from src/idl/flash-perpetuals-idl.json, Anchor 0.30 IDL):
//   8   discriminator [219,190,213,55,0,227,198,154]
//   8   pool: pubkey(32)
//   40  target_custody: pubkey(32)
//   72  collateral_custody: pubkey(32)
//   104 side: enum Side { None=0, Long=1, Short=2 } (1 byte)
//   105 correlation: bool
//   106 max_payoff_bps: u64
//   114 permissions: 4x bool
//   118 degen_exposure_usd: u64
//   126 collective_position: PositionStats
//        +0  open_positions: u64
//        +8  update_time: i64
//        +16 average_entry_price: OraclePrice { price u64, exponent i32 } (12)
//        +28 size_amount: u64
//        +36 size_usd: u64          <- absolute 162
//   ...
// Run: bun run test/flash-oi-probe.ts
import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';

const FLASH_PROGRAM = new PublicKey('FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn');
// Flash delegated its accounts to MagicBlock ephemeral rollups (discovered
// 2026-07-07): account OWNER is now the delegation program, so gPA must target
// it, not the Flash program. Data layout/discriminators unchanged.
const DELEGATION_PROGRAM = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');
const MARKET_DISC = Uint8Array.from([219, 190, 213, 55, 0, 227, 198, 154]);
const USD_DECIMALS = 6;

const conn = new Connection(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, 'confirmed');

// 1. Custody pubkeys per symbol from Flash REST
const pd = (await (await fetch('https://flashapi.trade/pool-data')).json()) as any;
const custodies = new Map<string, string[]>(); // symbol -> custody pubkeys (across pools)
for (const pool of pd?.pools ?? []) {
  for (const c of pool?.custodyStats ?? []) {
    if (!custodies.has(c.symbol)) custodies.set(c.symbol, []);
    custodies.get(c.symbol)!.push(c.custodyAccount);
  }
}
console.log('symbols in pool-data:', [...custodies.keys()].join(', '));

// 2. Fetch ALL Market accounts once (disc filter only), group client-side
const accounts = await conn.getProgramAccounts(DELEGATION_PROGRAM, {
  filters: [{ memcmp: { offset: 0, bytes: bs58.encode(MARKET_DISC) } }],
});
console.log('Market accounts found:', accounts.length);

const custodyToSymbol = new Map<string, string>();
for (const [sym, list] of custodies) for (const c of list) custodyToSymbol.set(c, sym);

const agg = new Map<string, { long: number; short: number; longPos: number; shortPos: number }>();
for (const { account } of accounts) {
  const buf = account.data;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
  const targetCustody = new PublicKey(buf.subarray(40, 72)).toBase58();
  const side = buf[104];
  const openPositions = Number(dv.getBigUint64(126, true));
  const sizeUsd = Number(dv.getBigUint64(162, true)) / 10 ** USD_DECIMALS;
  const sym = custodyToSymbol.get(targetCustody) ?? `?${targetCustody.slice(0, 6)}`;
  if (!agg.has(sym)) agg.set(sym, { long: 0, short: 0, longPos: 0, shortPos: 0 });
  const a = agg.get(sym)!;
  if (side === 1) { a.long += sizeUsd; a.longPos += openPositions; }
  else if (side === 2) { a.short += sizeUsd; a.shortPos += openPositions; }
}

const rows = [...agg.entries()].sort((a, b) => (b[1].long + b[1].short) - (a[1].long + a[1].short));
for (const [sym, a] of rows.slice(0, 20)) {
  const total = a.long + a.short;
  console.log(
    `${sym.padEnd(10)} OI $${Math.round(total).toLocaleString()} | long $${Math.round(a.long).toLocaleString()} (${a.longPos} pos) | short $${Math.round(a.short).toLocaleString()} (${a.shortPos} pos) | skew ${total > 0 ? Math.round((a.long / total) * 100) : 0}/${total > 0 ? Math.round((a.short / total) * 100) : 0}`,
  );
}
