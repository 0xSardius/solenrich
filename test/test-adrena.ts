import { Connection, PublicKey } from '@solana/web3.js';

const HELIUS_RPC = process.env.HELIUS_API_KEY
  ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`
  : 'https://api.mainnet-beta.solana.com';

// Real mainnet custody PDAs (main-pool, from pools_manifest.json)
const CUSTODIES = {
  USDC: 'Dk523LZeDQbZtUwPEBjFXCd2Au1tD7mWZBJJmcgHktNk',
  BONK: '8aJuzsgjxBnvRhDcfQBD7z4CUj7QoPEpaNwVd7KqsSk5',
  jitoSOL: 'GZ9XfWwgTRhkma2Y91Q9r1XKotNXYjBnKKabj19rhT71',
  WBTC: 'GFu3qS22mo6bAjg4Lr5R7L8pPgHq6GvbjJPKEHkbbs2c',
};

// Custody account layout — offsets from start of account data (incl. 8-byte Anchor disc).
// Derived from @adrena/abi v2.1.0-release39 idl/adrena.json.
// Sub-struct sizes:
//   LimitedString: 32 ([u8;31] + u8)
//   PricingParams: 32 (u32+u32+u64+u64+u64)
//   Fees: 32 (9*u16 + [u8;6] + u64)
//   BorrowRateParams: 8 (u64)
//   FeesStats: 48 (6*u64)
//   VolumeStats: 48 (6*u64)
//   TradeStats: 32 (4*u64)
//   Assets: 24 (3*u64)
//   PositionsAccounting: 200 (11*u64 + 4*U128Split + 1*StableLockedAmountStat[48])
//   BorrowRateState: 32 (u64 + i64 + U128Split)
//   U128Split: 16 (high u64 + low u64)
//   StableLockedAmountStat: 48 (pubkey + u64 + [u8;8])

const OFF = {
  decimals: 8 + 4,
  isStable: 8 + 5,
  // After 8-byte disc + 8 header bytes + 3 pubkeys (96) + 2 LimitedStrings (64) + Pricing (32) + Fees (32) = 240
  maxHourlyRate: 8 + 232,           // borrow_rate.max_hourly_borrow_interest_rate
  // collected_fees(48) + volume_stats(48) + trade_stats(32) = 128 after maxHourlyRate's 8-byte field
  // maxHourlyRate at 240, +8 = 248, +128 = 376 → assets start at offset 8 + 368 ? Recheck:
  // borrow_rate (8 bytes) starts at offset 8 + 232 = 240, ends at 248.
  // collected_fees ends at 248 + 48 = 296.
  // volume_stats ends at 296 + 48 = 344.
  // trade_stats ends at 344 + 32 = 376.
  // assets starts at 376. assets.collateral @ 376, owned @ 384, locked @ 392.
  assetsCollateral: 376,
  assetsOwned: 384,
  assetsLocked: 392,
  // long_positions starts at 400 (assets ends at 400). open_positions @ 400, size_usd @ 408.
  longOpenPositions: 400,
  longSizeUsd: 408,
  // short_positions starts at 600. open_positions @ 600, size_usd @ 608.
  shortOpenPositions: 600,
  shortSizeUsd: 608,
  // borrow_rate_state starts at 800. current_rate @ 800, last_update @ 808, cumulative_interest @ 816.
  currentRate: 800,
  lastUpdate: 808,
  // optimal_utilization_bps @ 832.
  optimalUtilBps: 832,
} as const;

function readU64LE(buf: Buffer, offset: number): bigint {
  return buf.readBigUInt64LE(offset);
}
function readI64LE(buf: Buffer, offset: number): bigint {
  return buf.readBigInt64LE(offset);
}

async function main() {
  const conn = new Connection(HELIUS_RPC, 'confirmed');

  for (const [symbol, pk] of Object.entries(CUSTODIES)) {
    const info = await conn.getAccountInfo(new PublicKey(pk));
    if (!info) {
      console.log(symbol, 'NO ACCOUNT');
      continue;
    }
    const buf = info.data;

    const decimals = buf.readUInt8(OFF.decimals);
    const isStable = buf.readUInt8(OFF.isStable);
    const maxHourly = readU64LE(buf, OFF.maxHourlyRate);
    const collateral = readU64LE(buf, OFF.assetsCollateral);
    const owned = readU64LE(buf, OFF.assetsOwned);
    const locked = readU64LE(buf, OFF.assetsLocked);
    const longSize = readU64LE(buf, OFF.longSizeUsd);
    const longOpen = readU64LE(buf, OFF.longOpenPositions);
    const shortSize = readU64LE(buf, OFF.shortSizeUsd);
    const shortOpen = readU64LE(buf, OFF.shortOpenPositions);
    const currentRate = readU64LE(buf, OFF.currentRate);
    const lastUpdate = readI64LE(buf, OFF.lastUpdate);
    const optUtilBps = readU64LE(buf, OFF.optimalUtilBps);

    // Adrena: current_rate is per-hour scaled by RATE_POWER=1e9
    const RATE_POWER = 1_000_000_000n;
    const aprBps = (currentRate * 24n * 365n * 10_000n) / RATE_POWER;
    const aprPct = Number(aprBps) / 100;

    const longOiUsd = Number(longSize) / 1e6;
    const shortOiUsd = Number(shortSize) / 1e6;
    const utilPct = owned > 0n ? Number((locked * 10000n) / owned) / 100 : 0;

    console.log(`\n=== ${symbol} (${pk.slice(0, 8)}...) — ${buf.length} bytes ===`);
    console.log(`  decimals: ${decimals}, is_stable: ${isStable}`);
    console.log(`  borrow_rate.max_hourly: ${maxHourly} (raw)`);
    console.log(`  borrow_rate_state.current_rate: ${currentRate} → ${aprPct.toFixed(2)}% APR`);
    console.log(`  last_update: ${new Date(Number(lastUpdate) * 1000).toISOString()}`);
    console.log(`  assets.collateral: ${collateral}`);
    console.log(`  assets.owned: ${owned} (${(Number(owned) / 10 ** decimals).toLocaleString()} tokens)`);
    console.log(`  assets.locked: ${locked} (util ${utilPct.toFixed(2)}%)`);
    console.log(`  long_positions: ${longOpen} open, $${longOiUsd.toLocaleString()} OI`);
    console.log(`  short_positions: ${shortOpen} open, $${shortOiUsd.toLocaleString()} OI`);
    console.log(`  optimal_util_bps: ${optUtilBps}`);
  }
}
main().catch(e => {
  console.error(e);
  process.exit(1);
});
