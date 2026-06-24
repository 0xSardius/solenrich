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
// Open interest (in separate `Market` accounts / collective_position) is a planned
// follow-up — see docs/solana-perps-landscape.md.

import { Connection, PublicKey } from '@solana/web3.js';
import { CONFIG, CACHE_TTL } from '../config';
import type { Cache } from '../cache';

export const FLASH_PROGRAM_ID = new PublicKey('FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn');

// Verified Custody Borsh offsets (account is 704B incl. 8-byte discriminator).
// borrow_rate_state.current_rate = live hourly borrow rate, scaled by RATE_POWER.
const CURRENT_RATE_OFFSET = 596;
const RATE_POWER = 1_000_000_000; // 1e9 — same convention as Jupiter Perps (verified vs the curve)

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
    for (const c of pd) {
      if (c.symbol !== symbol) continue;
      const tvl = Number(c.totalUsdOwnedAmountUi);
      if (!best || tvl > best.tvl) {
        best = { custody: c.custodyAccount, util: Number(c.utilizationUi), price: Number(c.priceUi), tvl };
      }
    }
    if (!best) return null;

    const rate = await this.readBorrowRate(best.custody);
    const snap: FlashMarketSnapshot = {
      symbol,
      custody: best.custody,
      mark_price_usd: Number.isFinite(best.price) && best.price > 0 ? best.price : null,
      utilization_pct: best.util,
      borrow_apr_pct: rate?.apr_pct ?? null,
      borrow_hourly_pct: rate?.hourly_pct ?? null,
      pool_tvl_usd: best.tvl,
    };
    await this.cache.set(cacheKey, snap, CACHE_TTL.perpsMarket);
    return snap;
  }
}
