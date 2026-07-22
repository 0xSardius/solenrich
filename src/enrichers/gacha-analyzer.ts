import { CACHE_TTL } from '../config';
import type { Cache } from '../cache';
import type { CollectorCryptClient, GachaMachine } from '../sources/collector-crypt';
import type { GachaEvScanInputType } from '../schemas/gacha';

// Gacha EV analyzer — turns Jupiter Gacha / Collector Crypt pack data into a
// net-of-exit-mechanics verdict.
//
// The platform advertises a gross `ev` (rarity-weighted expected INSURED value)
// that sits ~10% above pack price by design — which reads as "+EV". But the only
// GUARANTEED exit is instant-buyback at 85–93% of insured value (≤72h), which
// pulls the realizable EV to roughly −5% (the house edge). Selling on the
// marketplace can recover close to insured value (minus a 2% fee) but is not
// guaranteed to fill. This enricher makes that fork explicit.

/** Marketplace seller fee: 1% platform + 1% royalty. */
const MARKETPLACE_FEE = 0.02;
/** Instant-buyback payout is capped per card at this USDC amount. */
const BUYBACK_CAP_USDC = 40_000;

export type GachaVerdict = 'POSITIVE_EV' | 'HOUSE_EDGE' | 'NEGATIVE_EV';

export interface GachaExitLeg {
  /** Net expected value after this exit path's haircut/fees. */
  net_ev: number;
  /** Edge vs pack price, in %. */
  edge_pct: number;
}

export interface GachaMachineVerdict {
  code: string;
  name: string;
  franchise: 'pokemon' | 'onepiece' | 'other';
  price: number;
  gross_ev: number;
  gross_edge_pct: number;
  buyback: GachaExitLeg & { payout_pct: number; capped: boolean };
  marketplace: GachaExitLeg & { fee_pct: number };
  verdict: GachaVerdict;
  /** Share of remaining stock in the rare+epic tiers — higher = richer upside. */
  high_tier_stock_share: number;
  total_stock: number;
}

export interface GachaEvScan {
  scanned_at: string;
  franchise: string;
  exit_strategy: string;
  min_edge_pct: number | null;
  machine_count: number;
  machines: GachaMachineVerdict[];
  best: GachaMachineVerdict | null;
  summary: {
    positive_ev_count: number;
    house_edge_count: number;
    negative_ev_count: number;
    note: string;
  };
}

function franchiseOf(code: string): 'pokemon' | 'onepiece' | 'other' {
  if (code.startsWith('pokemon')) return 'pokemon';
  if (code.startsWith('onepiece')) return 'onepiece';
  return 'other';
}

function pct(part: number, whole: number): number {
  return whole > 0 ? (part - whole) / whole * 100 : 0;
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

export class GachaAnalyzer {
  private client: CollectorCryptClient;
  private cache: Cache;

  constructor(client: CollectorCryptClient, cache: Cache) {
    this.client = client;
    this.cache = cache;
  }

  async scan(input: GachaEvScanInputType): Promise<GachaEvScan> {
    const { franchise, exit_strategy, machine, min_edge_pct } = input;
    const cacheKey = `gacha:scan:${franchise}:${exit_strategy}:${machine ?? 'all'}:${min_edge_pct ?? 'none'}`;
    const cached = await this.cache.get<GachaEvScan>(cacheKey);
    if (cached) return cached;

    const all = await this.client.getMachines();

    const filtered = all.filter((m) => {
      if (m.public === false) return false;
      if (machine && m.code !== machine) return false;
      if (franchise !== 'all' && franchiseOf(m.code) !== franchise) return false;
      return true;
    });

    let machines = filtered.map((m) => this.evaluate(m));

    // Rank by the chosen exit path's edge, best first.
    const rankKey = (v: GachaMachineVerdict) =>
      exit_strategy === 'buyback' ? v.buyback.edge_pct : v.marketplace.edge_pct;
    machines.sort((a, b) => rankKey(b) - rankKey(a));

    if (min_edge_pct !== undefined) {
      machines = machines.filter((v) => rankKey(v) >= min_edge_pct);
    }

    const summary = {
      positive_ev_count: machines.filter((v) => v.verdict === 'POSITIVE_EV').length,
      house_edge_count: machines.filter((v) => v.verdict === 'HOUSE_EDGE').length,
      negative_ev_count: machines.filter((v) => v.verdict === 'NEGATIVE_EV').length,
      note:
        'Gross EV is expected INSURED value and overstates realizable EV. Instant-buyback (guaranteed, ≤72h) pays 85–93% of insured value — the true cash floor. Marketplace exit recovers ~insured value minus a 2% fee but is not guaranteed to fill. Most individual pulls land below pack price (gacha negative-skew); EV is an average. NFA.',
    };

    const result: GachaEvScan = {
      scanned_at: new Date().toISOString(),
      franchise,
      exit_strategy,
      min_edge_pct: min_edge_pct ?? null,
      machine_count: machines.length,
      machines,
      best: machines[0] ?? null,
      summary,
    };

    await this.cache.set(cacheKey, result, CACHE_TTL.gacha);
    return result;
  }

  private evaluate(m: GachaMachine): GachaMachineVerdict {
    const grossEv = m.ev ?? 0;
    const price = m.price ?? 0;

    const buybackNet = grossEv * (m.instantBuyback / 100);
    const marketplaceNet = grossEv * (1 - MARKETPLACE_FEE);

    const marketplaceEdge = pct(marketplaceNet, price);
    const buybackEdge = pct(buybackNet, price);

    // Verdict on realizable value: NEGATIVE if even the best-case marketplace
    // exit loses; POSITIVE if even the guaranteed buyback floor wins; otherwise
    // HOUSE_EDGE (the normal gacha case — guaranteed exit loses, marketplace
    // exit is positive but needs a buyer).
    let verdict: GachaVerdict;
    if (marketplaceEdge <= 0) verdict = 'NEGATIVE_EV';
    else if (buybackEdge >= 0) verdict = 'POSITIVE_EV';
    else verdict = 'HOUSE_EDGE';

    const stock = m.stock ?? { common: 0, uncommon: 0, rare: 0, epic: 0 };
    const totalStock = stock.common + stock.uncommon + stock.rare + stock.epic;
    const highTierShare = totalStock > 0 ? (stock.rare + stock.epic) / totalStock : 0;

    return {
      code: m.code,
      name: m.name,
      franchise: franchiseOf(m.code),
      price: round(price),
      gross_ev: round(grossEv),
      gross_edge_pct: round(pct(grossEv, price)),
      buyback: {
        payout_pct: m.instantBuyback,
        net_ev: round(buybackNet),
        edge_pct: round(buybackEdge),
        capped: buybackNet > BUYBACK_CAP_USDC,
      },
      marketplace: {
        fee_pct: MARKETPLACE_FEE * 100,
        net_ev: round(marketplaceNet),
        edge_pct: round(marketplaceEdge),
      },
      verdict,
      high_tier_stock_share: round(highTierShare, 3),
      total_stock: totalStock,
    };
  }
}
