// Flash Trade perps on-chain client.
//
// Flash is a Jupiter-Perps-lineage pool perp (same Solana Labs reference fork —
// custody discriminator matches Jupiter's). Its IDL is new Anchor 0.30+ format
// (incompatible with our pinned Anchor 0.29, same as Adrena), so we read the
// custody account via fixed-offset Borsh — verified live against pool-data.
//
// Hybrid for efficiency: Flash's public REST (`flashapi.trade/pool-data`) gives
// utilization + price + custody discovery for free; we do ONE on-chain read per
// market for the live borrow rate (`borrow_rate_state.current_rate`, the one field
// not in REST).
//
// Open interest lives in separate `Market` accounts (one per pool × target
// custody × side), decoded from `collective_position` — see getMarketOI below.
//
// IMPORTANT (discovered 2026-07-07): Flash delegated its program accounts to
// MagicBlock ephemeral rollups — account OWNER is now the delegation program
// (DELeGG...), NOT the Flash program, so getProgramAccounts must target the
// delegation program. Account data layout and discriminators are unchanged.
// Mainnet state is the rollup's periodic commit, so reads can lag live rollup
// state slightly — acceptable at our 30s market-data cache granularity.

import { Connection, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { createHash } from 'node:crypto';
import { CONFIG, CACHE_TTL } from '../config';
import type { Cache } from '../cache';

export const FLASH_PROGRAM_ID = new PublicKey('FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn');
// MagicBlock delegation program — the current owner of Flash's accounts.
const DELEGATION_PROGRAM_ID = new PublicKey('DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh');

// Verified Custody Borsh offsets (account is 704B incl. 8-byte discriminator).
// borrow_rate_state.current_rate = live hourly borrow rate, scaled by RATE_POWER.
const CURRENT_RATE_OFFSET = 596;
const RATE_POWER = 1_000_000_000; // 1e9 — same convention as Jupiter Perps (verified vs the curve)

// Market account offsets (from src/idl/flash-perpetuals-idl.json, verified live
// 2026-07-07 — size_amount × avg entry price reconciles with size_usd exactly):
//   40  target_custody: pubkey
//   104 side: enum { None=0, Long=1, Short=2 }
//   126 collective_position.open_positions: u64
//   162 collective_position.size_usd: u64 (6-decimal USD)
const MARKET_DISCRIMINATOR = createHash('sha256').update('account:Market').digest().subarray(0, 8);
const MARKET_TARGET_CUSTODY_OFFSET = 40;
const MARKET_SIDE_OFFSET = 104;
const MARKET_OPEN_POSITIONS_OFFSET = 126;
const MARKET_SIZE_USD_OFFSET = 162;
const USD_DECIMALS = 6;

export type FlashMarket = 'SOL' | 'BTC' | 'ETH' | 'BONK';

export interface FlashMarketSnapshot {
  symbol: string;
  custody: string;
  mark_price_usd: number | null;
  utilization_pct: number;
  /** Annualized borrow APR (percent). null if the on-chain read failed. */
  borrow_apr_pct: number | null;
  borrow_hourly_pct: number | null;
  /** Deepest pool TVL for this symbol (the pool we sourced). */
  pool_tvl_usd: number;
  /** Long OI in USD across all pools for this symbol. null if the read failed. */
  oi_long_usd: number | null;
  /** Short OI in USD across all pools for this symbol. null if the read failed. */
  oi_short_usd: number | null;
  /** Open long + short position counts across all pools. */
  open_positions_long: number | null;
  open_positions_short: number | null;
}

interface PoolDataCustody {
  symbol: string;
  custodyAccount: string;
  utilizationUi: string;
  priceUi: string;
  totalUsdOwnedAmountUi: string;
}

export class FlashPerpsClient {
  private conn: Connection;
  constructor(private cache: Cache) {
    this.conn = new Connection(CONFIG.helius.rpcUrl, 'confirmed');
  }

  /** Flash public pool snapshots (utilization/price/custody pubkeys), cached. */
  private async getPoolData(): Promise<PoolDataCustody[] | null> {
    const cacheKey = 'flash:pool-data';
    const cached = await this.cache.get<PoolDataCustody[]>(cacheKey);
    if (cached) return cached;
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 6000);
      const res = await fetch('https://flashapi.trade/pool-data', { signal: controller.signal });
      clearTimeout(t);
      if (!res.ok) return null;
      const data = (await res.json()) as any;
      const out: PoolDataCustody[] = [];
      for (const pool of data?.pools ?? []) {
        for (const c of pool?.custodyStats ?? []) {
          out.push({
            symbol: c.symbol,
            custodyAccount: c.custodyAccount,
            utilizationUi: c.utilizationUi,
            priceUi: c.priceUi,
            totalUsdOwnedAmountUi: c.totalUsdOwnedAmountUi,
          });
        }
      }
      await this.cache.set(cacheKey, out, CACHE_TTL.perpsMarket);
      return out;
    } catch (err) {
      console.warn('[flash] pool-data fetch failed:', (err as Error).message);
      return null;
    }
  }

  /**
   * Per-custody OI aggregated from Flash `Market` accounts (one gPA for all
   * ~225 markets, cached). Keyed by target_custody base58.
   */
  private async getMarketOI(): Promise<Record<
    string,
    { long_usd: number; short_usd: number; long_pos: number; short_pos: number }
  > | null> {
    const cacheKey = 'flash:market-oi';
    const cached = await this.cache.get<Record<string, { long_usd: number; short_usd: number; long_pos: number; short_pos: number }>>(cacheKey);
    if (cached) return cached;
    try {
      const accounts = await this.conn.getProgramAccounts(DELEGATION_PROGRAM_ID, {
        filters: [{ memcmp: { offset: 0, bytes: bs58.encode(MARKET_DISCRIMINATOR) } }],
      });
      const out: Record<string, { long_usd: number; short_usd: number; long_pos: number; short_pos: number }> = {};
      for (const { account } of accounts) {
        const buf = account.data;
        if (buf.length < MARKET_SIZE_USD_OFFSET + 8) continue;
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
        const custody = new PublicKey(buf.subarray(MARKET_TARGET_CUSTODY_OFFSET, MARKET_TARGET_CUSTODY_OFFSET + 32)).toBase58();
        const side = buf[MARKET_SIDE_OFFSET];
        const positions = Number(dv.getBigUint64(MARKET_OPEN_POSITIONS_OFFSET, true));
        const sizeUsd = Number(dv.getBigUint64(MARKET_SIZE_USD_OFFSET, true)) / 10 ** USD_DECIMALS;
        if (!out[custody]) out[custody] = { long_usd: 0, short_usd: 0, long_pos: 0, short_pos: 0 };
        if (side === 1) { out[custody].long_usd += sizeUsd; out[custody].long_pos += positions; }
        else if (side === 2) { out[custody].short_usd += sizeUsd; out[custody].short_pos += positions; }
      }
      await this.cache.set(cacheKey, out, CACHE_TTL.perpsMarket);
      return out;
    } catch (err) {
      console.warn('[flash] market OI read failed:', (err as Error).message);
      return null;
    }
  }

  /** Read the live borrow rate from a custody account (on-chain, fixed-offset). */
  private async readBorrowRate(custody: string): Promise<{ apr_pct: number; hourly_pct: number } | null> {
    try {
      const acc = await this.conn.getAccountInfo(new PublicKey(custody));
      if (!acc || acc.data.length < CURRENT_RATE_OFFSET + 8) return null;
      const buf = acc.data;
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
      const currentRate = Number(dv.getBigUint64(CURRENT_RATE_OFFSET, true));
      const hourly = currentRate / RATE_POWER;
      return { hourly_pct: hourly * 100, apr_pct: hourly * 24 * 365 * 100 };
    } catch (err) {
      console.warn('[flash] borrow-rate read failed:', (err as Error).message);
      return null;
    }
  }

  /**
   * Market snapshot for a symbol. Picks the deepest-TVL custody for that symbol
   * (the main perp pool), reads utilization/price from REST + borrow rate on-chain.
   */
  async getMarket(symbol: FlashMarket): Promise<FlashMarketSnapshot | null> {
    const cacheKey = `flash:market:${symbol}`;
    const cached = await this.cache.get<FlashMarketSnapshot>(cacheKey);
    if (cached) return cached;

    const pd = await this.getPoolData();
    if (!pd) return null;

    let best: { custody: string; util: number; price: number; tvl: number } | null = null;
    const symbolCustodies: string[] = [];
    for (const c of pd) {
      if (c.symbol !== symbol) continue;
      symbolCustodies.push(c.custodyAccount);
      const tvl = Number(c.totalUsdOwnedAmountUi);
      if (!best || tvl > best.tvl) {
        best = { custody: c.custodyAccount, util: Number(c.utilizationUi), price: Number(c.priceUi), tvl };
      }
    }
    if (!best) return null;

    const [rate, oiByCustody] = await Promise.all([
      this.readBorrowRate(best.custody),
      this.getMarketOI(),
    ]);

    // OI aggregates across ALL pools that list this symbol (Flash runs
    // several pools per asset), not just the deepest one.
    let oi: { long_usd: number; short_usd: number; long_pos: number; short_pos: number } | null = null;
    if (oiByCustody) {
      oi = { long_usd: 0, short_usd: 0, long_pos: 0, short_pos: 0 };
      for (const c of symbolCustodies) {
        const m = oiByCustody[c];
        if (!m) continue;
        oi.long_usd += m.long_usd;
        oi.short_usd += m.short_usd;
        oi.long_pos += m.long_pos;
        oi.short_pos += m.short_pos;
      }
    }

    const snap: FlashMarketSnapshot = {
      symbol,
      custody: best.custody,
      mark_price_usd: Number.isFinite(best.price) && best.price > 0 ? best.price : null,
      utilization_pct: best.util,
      borrow_apr_pct: rate?.apr_pct ?? null,
      borrow_hourly_pct: rate?.hourly_pct ?? null,
      pool_tvl_usd: best.tvl,
      oi_long_usd: oi ? Math.round(oi.long_usd) : null,
      oi_short_usd: oi ? Math.round(oi.short_usd) : null,
      open_positions_long: oi ? oi.long_pos : null,
      open_positions_short: oi ? oi.short_pos : null,
    };
    await this.cache.set(cacheKey, snap, CACHE_TTL.perpsMarket);
    return snap;
  }
}
