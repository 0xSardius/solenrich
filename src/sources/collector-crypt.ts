import { CACHE_TTL } from '../config';
import type { Cache } from '../cache';

// Collector Crypt Gacha Machine API — the backend behind Jupiter Gacha
// (tokenized graded trading-card packs). Public, no auth for read endpoints.
// Base: https://gacha.collectorcrypt.com  (docs.collectorcrypt.com/gacha/api)
//
// `/api/machines` returns every live pack machine in one call with price, the
// platform's rarity-weighted expected insured value (`ev`), pull odds, live
// per-rarity stock, tier value ranges, and the guaranteed instant-buyback
// percentage. That single endpoint is all `gacha-ev-scan` needs.

const BASE_URL = 'https://gacha.collectorcrypt.com';

export interface GachaOdds {
  common: number;
  uncommon: number;
  rare: number;
  epic: number;
}

export interface GachaTierRange {
  start: number;
  end: number;
}

export interface GachaMachine {
  code: string;
  name: string;
  shortName?: string;
  price: number;
  contains: number;
  /** Guaranteed instant-buyback payout as a percentage of insured value (e.g. 85). */
  instantBuyback: number;
  turboMode?: boolean;
  public?: boolean;
  /** Platform target EV (design anchor, typically ~110% of price). */
  targetEv?: number;
  /** Current rarity-weighted expected insured value (gross, pre-exit-haircut). */
  ev: number;
  odds: GachaOdds;
  tierRanges: Record<keyof GachaOdds, GachaTierRange>;
  /** Remaining inventory per rarity tier. */
  stock: Record<keyof GachaOdds, number>;
}

export class CollectorCryptClient {
  private cache: Cache;

  constructor(cache: Cache) {
    this.cache = cache;
  }

  /** All live gacha machines. Cached briefly — ev/stock drift as packs open. */
  async getMachines(): Promise<GachaMachine[]> {
    const cacheKey = 'gacha:machines';
    const cached = await this.cache.get<GachaMachine[]>(cacheKey);
    if (cached) return cached;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(`${BASE_URL}/api/machines`, {
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`collector-crypt machines HTTP ${res.status}`);
      const raw = (await res.json()) as { machines?: GachaMachine[] };
      const machines = Array.isArray(raw.machines) ? raw.machines : [];
      await this.cache.set(cacheKey, machines, CACHE_TTL.gacha);
      return machines;
    } finally {
      clearTimeout(timer);
    }
  }
}
