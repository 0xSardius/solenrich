// Adrena Protocol on-chain data client
// Reads main-pool Custody accounts via fixed-offset Borsh decoding.
//
// Why fixed offsets instead of Anchor Program: Adrena ships @adrena/abi as an
// Anchor 0.30+ IDL, but our codebase pins @coral-xyz/anchor@0.29 (Jupiter Perps
// reference IDLs predate the 0.30 IDL format change). Converting the IDL
// in-flight is whack-a-mole — nested `defined`/array shapes change.
// Hand-decoding the ~10 Custody fields we need is faster, more robust to
// future IDL renames on fields we don't touch, and avoids the version pin
// conflict entirely.
//
// Offsets verified against @adrena/abi v2.1.0-release39 on 2026-05-19 by
// reading all 4 main-pool custodies live (decimals/is_stable/last_update
// matched expected values, OI ratios matched Adrena's published long-bias).

import { Connection, PublicKey } from '@solana/web3.js';
import { CONFIG, CACHE_TTL } from '../config';
import type { Cache } from '../cache';

// --- Constants ---

export const ADRENA_PROGRAM_ID = new PublicKey(
  '13gDzEXCdocbj8iAiqrScGo47NiSuYENGsRqi3SEAwet',
);

export const ADRENA_MAIN_POOL = new PublicKey(
  '4bQRutgDJs6vuh6ZcWaPVXiQaBzbHketjbCDjL4oRN34',
);

// Main-pool custody PDAs (from @adrena/abi configs/pools_manifest.json).
// On-chain custody order: [USDC, BONK, jitoSOL, WBTC].
export const ADRENA_CUSTODY = {
  USDC: new PublicKey('Dk523LZeDQbZtUwPEBjFXCd2Au1tD7mWZBJJmcgHktNk'),
  BONK: new PublicKey('8aJuzsgjxBnvRhDcfQBD7z4CUj7QoPEpaNwVd7KqsSk5'),
  jitoSOL: new PublicKey('GZ9XfWwgTRhkma2Y91Q9r1XKotNXYjBnKKabj19rhT71'),
  WBTC: new PublicKey('GFu3qS22mo6bAjg4Lr5R7L8pPgHq6GvbjJPKEHkbbs2c'),
} as const;

// Adrena uses wrapped assets — no native SOL/BTC/ETH custodies.
// User-facing markets map to wrapped variants:
//   SOL → jitoSOL exposure
//   BTC → WBTC exposure
//   BONK → BONK
//   ETH → unsupported on mainnet (return null)
export type AdrenaMarket = 'SOL' | 'BTC' | 'ETH' | 'BONK';
export type AdrenaTradableMarket = Exclude<AdrenaMarket, 'ETH'>;

const MARKET_TO_CUSTODY: Record<AdrenaTradableMarket, PublicKey> = {
  SOL: ADRENA_CUSTODY.jitoSOL,
  BTC: ADRENA_CUSTODY.WBTC,
  BONK: ADRENA_CUSTODY.BONK,
};

// --- Scaling constants ---

// borrow_rate_state.current_rate is per-hour, scaled by RATE_POWER = 1e9.
// APR = current_rate * 24 * 365 / RATE_POWER.
// (Opposite of Jupiter Perps where targetRateBps is already annualized.)
const RATE_POWER = 1_000_000_000n;
// size_usd, collateral_usd, exit_fee_usd, etc. are scaled by 1e6 (USD_DECIMALS).
const USD_SCALE = 1_000_000;
// Position.price uses PRICE_DECIMALS = 10 (Cortex::PRICE_DECIMALS in Adrena source).
// Verified against live Position accounts on 2026-05-27 — SOL entry $111, BTC entry $77K decode cleanly with 10^10.
const PRICE_SCALE = 10_000_000_000;

// --- Custody account layout (offsets from start of account data) ---
//
// All offsets after the 8-byte Anchor discriminator.
// Sub-struct sizes derived from IDL field shapes:
//   LimitedString = 32 ([u8;31] + u8)
//   PricingParams = 32 (u32+u32+u64+u64+u64)
//   Fees = 32 (9*u16 + [u8;6] + u64)
//   BorrowRateParams = 8 (u64)
//   FeesStats = 48 (6*u64)
//   VolumeStats = 48 (6*u64)
//   TradeStats = 32 (4*u64)
//   Assets = 24 (3*u64)
//   PositionsAccounting = 200 (11*u64 + 4*U128Split[16] + 1*StableLockedAmountStat[48])
//   BorrowRateState = 32 (u64 + i64 + U128Split[16])
const OFF = {
  decimals: 8 + 4,
  isStable: 8 + 5,
  // header(8) + flags(8) + 3 pubkeys(96) + 2 LimitedStrings(64) + Pricing(32) + Fees(32) = 240
  maxHourlyRate: 240,
  // maxHourlyRate ends at 248. +FeesStats(48) +VolumeStats(48) +TradeStats(32) = 376
  assetsCollateral: 376,
  assetsOwned: 384,
  assetsLocked: 392,
  // Assets ends at 400. PositionsAccounting layout: open_positions @ +0, size_usd @ +8.
  longOpenPositions: 400,
  longSizeUsd: 408,
  longBorrowSizeUsd: 416,
  longCollateralUsd: 480,
  shortOpenPositions: 600,
  shortSizeUsd: 608,
  shortBorrowSizeUsd: 616,
  shortCollateralUsd: 680,
  // Positions end at 800. BorrowRateState: current_rate @ +0, last_update @ +8.
  currentRate: 800,
  lastUpdate: 808,
  optimalUtilBps: 832,
} as const;

/**
 * Position account field offsets (after 8-byte Anchor discriminator).
 * Derived from adrena.json IDL Position struct, repr(C), bytemuck-serialized.
 * Verified live against on-chain position accounts on 2026-05-27.
 */
const POS_OFF = {
  bump: 8,
  side: 9,                  // u8: 0=None, 1=Long, 2=Short
  // padding bytes 10-15
  owner: 16,                // pubkey (32)
  pool: 48,                 // pubkey (32)
  custody: 80,              // pubkey (32)
  collateralCustody: 112,   // pubkey (32)
  openTime: 144,            // i64
  updateTime: 152,          // i64
  price: 160,               // u64 — entry price, scaled by 1e6
  sizeUsd: 168,             // u64 — scaled by 1e6
  borrowSizeUsd: 176,       // u64
  collateralUsd: 184,       // u64 — scaled by 1e6
  // unrealized_interest, cumulative_interest_snapshot, locked_amount, collateral_amount
  liquidationFeeUsd: 240,   // u64
  id: 248,                  // u64
} as const;

// --- Types ---

export type SkewLabel = 'long' | 'short' | 'balanced';
export type AdrenaCustodySymbol = 'USDC' | 'BONK' | 'jitoSOL' | 'WBTC';

/** Mint address of the underlying token for each tradable market. Used to fetch mark prices. */
export const ADRENA_COLLATERAL_MINT: Record<AdrenaTradableMarket, string> = {
  SOL: 'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn',   // jitoSOL
  BTC: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',   // WBTC (Portal)
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',  // BONK
};

/** A single decoded Adrena position. Matches the shape PerpsPositionData uses for Jupiter. */
export interface AdrenaPositionData {
  pool: string;
  custody: string;
  market_symbol: AdrenaTradableMarket;
  side: 'long' | 'short';
  size_usd: number;
  collateral_usd: number;
  leverage: number;
  entry_price_usd: number;
  mark_price_usd: number | null;
  unrealized_pnl_usd: number | null;
  unrealized_pnl_pct: number | null;
  open_time: number;
  update_time: number;
  age_hours: number;
  /** Adrena position-id. Distinguishes multiple positions on the same custody+side after re-opens. */
  id: number;
  borrow_size_usd: number;
  liquidation_fee_usd: number;
}

export interface AdrenaTraderProfile {
  address: string;
  has_positions: boolean;
  positions: AdrenaPositionData[];
  totals: {
    gross_exposure_usd: number;
    net_exposure_usd: number;
    total_collateral_usd: number;
    total_unrealized_pnl_usd: number;
    weighted_leverage: number;
  };
  fetched_at: number;
}

/** What our cross-venue enricher consumes for a single Adrena market. */
export interface AdrenaCustodyState {
  symbol: AdrenaCustodySymbol;
  market: AdrenaTradableMarket;       // user-facing market this custody represents
  custody: string;
  decimals: number;
  is_stable: boolean;
  borrow_rate: {
    /** Annualized percentage from per-hour current_rate. */
    apr_pct: number;
    /** Per-hour percentage (raw, for diagnostics). */
    hourly_pct: number;
    /** Cap from BorrowRateParams.max_hourly_borrow_interest_rate. */
    max_hourly_pct: number;
  };
  open_interest: {
    long_usd: number;
    short_usd: number;
    total_usd: number;
    long_pct: number;
    short_pct: number;
    net_skew: SkewLabel;
  };
  position_counts: {
    long: number;
    short: number;
  };
  pool_assets: {
    owned_tokens: number;
    locked_tokens: number;
    collateral_usd: number;
  };
  utilization_pct: number;
  optimal_utilization_bps: number;
  last_update: number;
}

// --- Helpers ---

function readU64(buf: Buffer, offset: number): bigint {
  return buf.readBigUInt64LE(offset);
}

function readI64(buf: Buffer, offset: number): bigint {
  return buf.readBigInt64LE(offset);
}

function bnToUsd(raw: bigint): number {
  return Number(raw) / USD_SCALE;
}

function classifySkew(longPct: number): SkewLabel {
  if (longPct >= 60) return 'long';
  if (longPct <= 40) return 'short';
  return 'balanced';
}

// --- Client ---

export class AdrenaClient {
  private conn: Connection;
  private cache: Cache;

  constructor(cache: Cache) {
    this.conn = new Connection(CONFIG.helius.rpcUrl, 'confirmed');
    this.cache = cache;
  }

  /**
   * Get Adrena custody state for a user-facing market.
   * Returns null if the market is not supported on Adrena (e.g. ETH).
   */
  async getMarket(market: AdrenaMarket): Promise<AdrenaCustodyState | null> {
    if (market === 'ETH') return null; // not supported on Adrena mainnet
    const custodyPk = MARKET_TO_CUSTODY[market];
    if (!custodyPk) return null;

    const cacheKey = `adrena:custody:${market}`;
    const cached = await this.cache.get<AdrenaCustodyState>(cacheKey);
    if (cached) return cached;

    const info = await this.conn.getAccountInfo(custodyPk);
    if (!info) return null;
    const buf = info.data;

    const decimals = buf.readUInt8(OFF.decimals);
    const isStable = buf.readUInt8(OFF.isStable) === 1;
    const maxHourlyRaw = readU64(buf, OFF.maxHourlyRate);
    const currentRateRaw = readU64(buf, OFF.currentRate);
    const lastUpdate = Number(readI64(buf, OFF.lastUpdate));
    const optimalUtilBps = Number(readU64(buf, OFF.optimalUtilBps));

    const owned = readU64(buf, OFF.assetsOwned);
    const locked = readU64(buf, OFF.assetsLocked);

    const longSizeUsd = bnToUsd(readU64(buf, OFF.longSizeUsd));
    const shortSizeUsd = bnToUsd(readU64(buf, OFF.shortSizeUsd));
    const longOpenPositions = Number(readU64(buf, OFF.longOpenPositions));
    const shortOpenPositions = Number(readU64(buf, OFF.shortOpenPositions));
    const longCollateralUsd = bnToUsd(readU64(buf, OFF.longCollateralUsd));
    const shortCollateralUsd = bnToUsd(readU64(buf, OFF.shortCollateralUsd));

    // APR computation: current_rate is per-hour, scaled by RATE_POWER=1e9.
    // aprPct = current_rate * 24 * 365 * 100 / RATE_POWER
    const aprBpsTimes100 = (currentRateRaw * 24n * 365n * 10_000n) / RATE_POWER;
    const aprPct = Number(aprBpsTimes100) / 100;
    const hourlyPct = aprPct / (24 * 365);
    const maxAprBpsTimes100 = (maxHourlyRaw * 24n * 365n * 10_000n) / RATE_POWER;
    const maxAprPct = Number(maxAprBpsTimes100) / 100;
    const maxHourlyPct = maxAprPct / (24 * 365);

    const totalOiUsd = longSizeUsd + shortSizeUsd;
    const longPct = totalOiUsd > 0 ? (longSizeUsd / totalOiUsd) * 100 : 0;
    const shortPct = totalOiUsd > 0 ? (shortSizeUsd / totalOiUsd) * 100 : 0;

    const ownedTokens = Number(owned) / 10 ** decimals;
    const lockedTokens = Number(locked) / 10 ** decimals;
    const utilizationPct = owned > 0n
      ? Number((locked * 10_000n) / owned) / 100
      : 0;

    const symbolMap: Record<AdrenaTradableMarket, AdrenaCustodySymbol> = {
      SOL: 'jitoSOL',
      BTC: 'WBTC',
      BONK: 'BONK',
    };

    const state: AdrenaCustodyState = {
      symbol: symbolMap[market],
      market,
      custody: custodyPk.toBase58(),
      decimals,
      is_stable: isStable,
      borrow_rate: {
        apr_pct: aprPct,
        hourly_pct: hourlyPct,
        max_hourly_pct: maxHourlyPct,
      },
      open_interest: {
        long_usd: longSizeUsd,
        short_usd: shortSizeUsd,
        total_usd: totalOiUsd,
        long_pct: longPct,
        short_pct: shortPct,
        net_skew: classifySkew(longPct),
      },
      position_counts: {
        long: longOpenPositions,
        short: shortOpenPositions,
      },
      pool_assets: {
        owned_tokens: ownedTokens,
        locked_tokens: lockedTokens,
        collateral_usd: longCollateralUsd + shortCollateralUsd,
      },
      utilization_pct: utilizationPct,
      optimal_utilization_bps: optimalUtilBps,
      last_update: lastUpdate,
    };

    await this.cache.set(cacheKey, state, CACHE_TTL.perpsMarket);
    return state;
  }

  /**
   * Fetch all open Adrena positions for a wallet via deterministic PDA lookup.
   * 6 PDAs (3 tradable markets × 2 sides), one getMultipleAccounts call.
   * Decodes via fixed-offset Borsh (same approach as custodies — avoids
   * Anchor 0.30 IDL incompat).
   *
   * @param markPrices optional map of collateral mint -> USD price for PnL.
   *                   If a mint price is missing, that position's PnL is null.
   */
  async getPositionsForWallet(
    address: string,
    markPrices?: Map<string, number | null>,
  ): Promise<AdrenaTraderProfile> {
    const cacheKey = `adrena:trader:${address}`;
    const cached = await this.cache.get<AdrenaTraderProfile>(cacheKey);
    if (cached) return cached;

    const owner = new PublicKey(address);
    const tradableMarkets: AdrenaTradableMarket[] = ['SOL', 'BTC', 'BONK'];
    const sides: Array<'long' | 'short'> = ['long', 'short'];

    // Derive 6 deterministic position PDAs (3 markets × 2 sides)
    const pdaTargets: Array<{
      pda: PublicKey;
      market: AdrenaTradableMarket;
      side: 'long' | 'short';
      custody: PublicKey;
    }> = [];

    for (const market of tradableMarkets) {
      const custody = MARKET_TO_CUSTODY[market];
      for (const side of sides) {
        const sideByte = side === 'long' ? 1 : 2;
        const [pda] = PublicKey.findProgramAddressSync(
          [
            Buffer.from('position'),
            owner.toBuffer(),
            ADRENA_MAIN_POOL.toBuffer(),
            custody.toBuffer(),
            Buffer.from([sideByte]),
          ],
          ADRENA_PROGRAM_ID,
        );
        pdaTargets.push({ pda, market, side, custody });
      }
    }

    // Single RPC batch read — null entries = position doesn't exist (closed or never opened)
    const accounts = await this.conn.getMultipleAccountsInfo(pdaTargets.map(t => t.pda));

    const positions: AdrenaPositionData[] = [];
    const nowSec = Math.floor(Date.now() / 1000);

    for (let i = 0; i < accounts.length; i++) {
      const info = accounts[i];
      if (!info) continue; // PDA not initialized → no position
      const target = pdaTargets[i];
      const buf = info.data;

      // Size 0 = closed but not yet reaped (defensive — Adrena typically reaps but be safe)
      const sizeUsdRaw = readU64(buf, POS_OFF.sizeUsd);
      if (sizeUsdRaw === 0n) continue;

      const collateralUsdRaw = readU64(buf, POS_OFF.collateralUsd);
      const entryPriceRaw = readU64(buf, POS_OFF.price);
      const openTime = Number(readI64(buf, POS_OFF.openTime));
      const updateTime = Number(readI64(buf, POS_OFF.updateTime));
      const id = Number(readU64(buf, POS_OFF.id));
      const borrowSizeRaw = readU64(buf, POS_OFF.borrowSizeUsd);
      const liqFeeRaw = readU64(buf, POS_OFF.liquidationFeeUsd);

      const size_usd = bnToUsd(sizeUsdRaw);
      const collateral_usd = bnToUsd(collateralUsdRaw);
      // Price uses PRICE_DECIMALS=10, not USD_DECIMALS=6
      const entry_price_usd = Number(entryPriceRaw) / PRICE_SCALE;
      const borrow_size_usd = bnToUsd(borrowSizeRaw);
      const liquidation_fee_usd = bnToUsd(liqFeeRaw);

      // PnL: needs current mark price for the collateral token
      const mint = ADRENA_COLLATERAL_MINT[target.market];
      const mark = markPrices?.get(mint) ?? null;
      let unrealized_pnl_usd: number | null = null;
      let unrealized_pnl_pct: number | null = null;
      if (mark !== null && entry_price_usd > 0 && size_usd > 0) {
        const sizeTokens = size_usd / entry_price_usd;
        const direction = target.side === 'long' ? 1 : -1;
        unrealized_pnl_usd = (mark - entry_price_usd) * direction * sizeTokens;
        unrealized_pnl_pct =
          collateral_usd > 0 ? (unrealized_pnl_usd / collateral_usd) * 100 : null;
      }

      const age_hours = openTime > 0 ? (nowSec - openTime) / 3600 : 0;

      positions.push({
        pool: ADRENA_MAIN_POOL.toBase58(),
        custody: target.custody.toBase58(),
        market_symbol: target.market,
        side: target.side,
        size_usd,
        collateral_usd,
        leverage: collateral_usd > 0 ? size_usd / collateral_usd : 0,
        entry_price_usd,
        mark_price_usd: mark,
        unrealized_pnl_usd,
        unrealized_pnl_pct,
        open_time: openTime,
        update_time: updateTime,
        age_hours,
        id,
        borrow_size_usd,
        liquidation_fee_usd,
      });
    }

    const gross = positions.reduce((s, p) => s + p.size_usd, 0);
    const net = positions.reduce((s, p) => s + p.size_usd * (p.side === 'long' ? 1 : -1), 0);
    const collat = positions.reduce((s, p) => s + p.collateral_usd, 0);
    const upnl = positions.reduce((s, p) => s + (p.unrealized_pnl_usd ?? 0), 0);
    const weightedLev = collat > 0 ? gross / collat : 0;

    const profile: AdrenaTraderProfile = {
      address,
      has_positions: positions.length > 0,
      positions,
      totals: {
        gross_exposure_usd: gross,
        net_exposure_usd: net,
        total_collateral_usd: collat,
        total_unrealized_pnl_usd: upnl,
        weighted_leverage: weightedLev,
      },
      fetched_at: Date.now(),
    };

    await this.cache.set(cacheKey, profile, CACHE_TTL.perpsTrader);
    return profile;
  }

  /** True if a market exists on Adrena mainnet. */
  static isMarketSupported(market: AdrenaMarket): boolean {
    return market !== 'ETH';
  }
}
