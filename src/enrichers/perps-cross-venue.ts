// Cross-venue perps funding enricher.
//
// Aggregates borrow/funding rates across:
//   - Solana on-chain venues: Jupiter Perps, Adrena
//   - Cross-chain reference: Hyperliquid, dYdX v4
//
// Returns per-venue rates + best-entry recommendation per side + cross-chain
// basis + arbitrage opportunities.
//
// Designed as a foundation — additional Solana venues (Phoenix, Bullet) and
// reference venues fold in here as cheap follow-on sessions. The shape is
// stable across additions: each new venue gets its own VenueQuote entry, and
// best_entry / arbitrage_opportunities recompute automatically.

import { parallelFetch } from '../utils/parallel';
import type { JupiterPerpsClient } from '../sources/jupiter-perps';
import type { AdrenaClient, AdrenaMarket } from '../sources/adrena';
import type { PerpReferenceClient, ReferenceMarket } from '../sources/perp-reference';
import type { FlashPerpsClient, FlashMarket } from '../sources/flash-perps';
import type { Cache } from '../cache';
import { CACHE_TTL } from '../config';

export type CrossVenueMarket = 'SOL' | 'BTC' | 'ETH' | 'BONK';
export type VenueId = 'jupiter-perps' | 'adrena' | 'flash' | 'hyperliquid' | 'dydx-v4';

export interface VenueQuote {
  venue: VenueId;
  available: boolean;
  /** Annualized borrow/funding APR for longs (percent). */
  borrow_apr_long: number | null;
  /** Annualized borrow/funding APR for shorts (percent). */
  borrow_apr_short: number | null;
  /** Total OI on the venue in USD (long + short). */
  open_interest_usd: number | null;
  /** Pool utilization (Solana venues only). null on CEX-style reference venues. */
  utilization_pct: number | null;
  /** Long-heavy / short-heavy / balanced. */
  skew: 'long-heavy' | 'short-heavy' | 'balanced' | 'unknown';
  /** Mark or oracle price USD if available. */
  mark_price_usd: number | null;
  /** Reason this venue can't quote (e.g. "Market not supported on Adrena"). */
  unavailable_reason?: string;
  /** Venue type — helps consumers reason about cross-chain vs same-chain. */
  type: 'solana-onchain' | 'reference';
  notes?: string[];
}

export interface BestEntry {
  long: { venue: VenueId | null; apr: number | null; reasoning: string };
  short: { venue: VenueId | null; apr: number | null; reasoning: string };
}

export interface BasisInfo {
  /** Spread between Jupiter mark and Hyperliquid mark, in basis points. Positive = Jupiter premium. */
  jupiter_vs_hyperliquid_bps: number | null;
  /** Spread between Adrena mark and Hyperliquid mark, in basis points. */
  adrena_vs_hyperliquid_bps: number | null;
  summary: string;
}

export interface ArbitrageOpportunity {
  type: 'venue_spread' | 'cross_chain_basis';
  description: string;
  spread_apr_pct: number;
  long_venue: VenueId;
  short_venue: VenueId;
}

export interface CrossVenueFunding {
  market: CrossVenueMarket;
  checked_at: number;
  venues: VenueQuote[];
  best_entry: BestEntry;
  basis: BasisInfo;
  arbitrage_opportunities: ArbitrageOpportunity[];
}

const SKEW_LONG_PCT = 60;
const SKEW_SHORT_PCT = 40;
const ARB_MIN_SPREAD_PCT = 5; // surface if APR spread between two venues for same side > 5 pts

function classifySkew(longPct: number): VenueQuote['skew'] {
  if (longPct >= SKEW_LONG_PCT) return 'long-heavy';
  if (longPct <= SKEW_SHORT_PCT) return 'short-heavy';
  return 'balanced';
}

function aprDelta(a: number, b: number): number {
  return Math.abs(a - b);
}

export class PerpsCrossVenueAnalyzer {
  constructor(
    private jupiter: JupiterPerpsClient,
    private adrena: AdrenaClient,
    private reference: PerpReferenceClient,
    private flash: FlashPerpsClient,
    private cache: Cache,
  ) {}

  async analyze(
    market: CrossVenueMarket,
    includeReference = true,
  ): Promise<CrossVenueFunding> {
    const cacheKey = `cross-venue-funding:${market}:${includeReference ? 'with-ref' : 'no-ref'}`;
    const cached = await this.cache.get<CrossVenueFunding>(cacheKey);
    if (cached) return cached;

    // Run all venue fetches in parallel — each is independent.
    const tasks = [
      { name: 'jupiter', fn: () => this.jupiter.getMarketStructure() },
      { name: 'adrena', fn: () => this.adrena.getMarket(market as AdrenaMarket) },
      { name: 'flash', fn: () => this.flash.getMarket(market as FlashMarket) },
    ];
    if (includeReference) {
      tasks.push(
        { name: 'reference', fn: () => this.reference.getBoth(market as ReferenceMarket) as any },
      );
    }

    const results = await parallelFetch<any>(tasks, 6000);

    const venues: VenueQuote[] = [];

    // --- Jupiter Perps ---
    const jupiterMarket = results.jupiter?.markets?.find((m: any) => m.symbol === market);
    if (jupiterMarket) {
      const longApr = jupiterMarket.borrow_rate.annualized_pct;
      // Jupiter uses single borrow APR per pool — same for long and short directionally
      // (utilization-based; both sides pay it). Use the same value for both.
      venues.push({
        venue: 'jupiter-perps',
        available: true,
        type: 'solana-onchain',
        borrow_apr_long: longApr,
        borrow_apr_short: longApr,
        open_interest_usd: jupiterMarket.open_interest.total_usd,
        utilization_pct: jupiterMarket.utilization_pct,
        skew: classifySkew(jupiterMarket.open_interest.long_pct),
        mark_price_usd: jupiterMarket.mark_price_usd,
      });
    } else if (market === 'BONK') {
      venues.push({
        venue: 'jupiter-perps',
        available: false,
        type: 'solana-onchain',
        borrow_apr_long: null,
        borrow_apr_short: null,
        open_interest_usd: null,
        utilization_pct: null,
        skew: 'unknown',
        mark_price_usd: null,
        unavailable_reason: 'BONK not tradable on Jupiter Perps (only SOL/BTC/ETH).',
      });
    } else {
      venues.push({
        venue: 'jupiter-perps',
        available: false,
        type: 'solana-onchain',
        borrow_apr_long: null,
        borrow_apr_short: null,
        open_interest_usd: null,
        utilization_pct: null,
        skew: 'unknown',
        mark_price_usd: null,
        unavailable_reason: 'Jupiter Perps fetch failed.',
      });
    }

    // --- Adrena ---
    const adrenaState = results.adrena;
    if (market === 'ETH') {
      venues.push({
        venue: 'adrena',
        available: false,
        type: 'solana-onchain',
        borrow_apr_long: null,
        borrow_apr_short: null,
        open_interest_usd: null,
        utilization_pct: null,
        skew: 'unknown',
        mark_price_usd: null,
        unavailable_reason: 'ETH not supported on Adrena mainnet (no native or wrapped ETH custody).',
      });
    } else if (adrenaState) {
      const wrappedNote = market === 'SOL'
        ? 'Adrena SOL exposure is via jitoSOL custody.'
        : market === 'BTC'
          ? 'Adrena BTC exposure is via WBTC custody.'
          : undefined;
      venues.push({
        venue: 'adrena',
        available: true,
        type: 'solana-onchain',
        borrow_apr_long: adrenaState.borrow_rate.apr_pct,
        borrow_apr_short: adrenaState.borrow_rate.apr_pct,
        open_interest_usd: adrenaState.open_interest.total_usd,
        utilization_pct: adrenaState.utilization_pct,
        skew: classifySkew(adrenaState.open_interest.long_pct),
        mark_price_usd: null, // Adrena oracle not yet wired — would need separate oracle read
        notes: wrappedNote ? [wrappedNote] : undefined,
      });
    } else {
      venues.push({
        venue: 'adrena',
        available: false,
        type: 'solana-onchain',
        borrow_apr_long: null,
        borrow_apr_short: null,
        open_interest_usd: null,
        utilization_pct: null,
        skew: 'unknown',
        mark_price_usd: null,
        unavailable_reason: 'Adrena fetch failed.',
      });
    }

    // --- Flash Trade (pool perp, Jupiter-lineage; borrow rate read on-chain) ---
    const flashMarket = results.flash;
    if (flashMarket && flashMarket.borrow_apr_pct !== null) {
      venues.push({
        venue: 'flash',
        available: true,
        type: 'solana-onchain',
        // Pool perp — both sides pay the same utilization-based borrow rate.
        borrow_apr_long: flashMarket.borrow_apr_pct,
        borrow_apr_short: flashMarket.borrow_apr_pct,
        open_interest_usd: null,
        utilization_pct: flashMarket.utilization_pct,
        skew: 'unknown',
        mark_price_usd: flashMarket.mark_price_usd,
        notes: ['Flash OI/skew live in separate Market accounts — borrow rate + utilization wired; OI pending.'],
      });
    } else {
      venues.push({
        venue: 'flash',
        available: false,
        type: 'solana-onchain',
        borrow_apr_long: null,
        borrow_apr_short: null,
        open_interest_usd: null,
        utilization_pct: null,
        skew: 'unknown',
        mark_price_usd: flashMarket?.mark_price_usd ?? null,
        unavailable_reason: flashMarket ? 'Flash borrow-rate read failed.' : `${market} not available on Flash.`,
      });
    }

    // --- Reference venues (Hyperliquid + dYdX v4) ---
    const refSnaps = results.reference as {
      hyperliquid: any; dydx: any;
    } | null;
    if (refSnaps) {
      // Hyperliquid
      if (refSnaps.hyperliquid) {
        const hl = refSnaps.hyperliquid;
        // CEX-style funding: longs pay funding when positive, shorts receive (and vice versa).
        // borrow_apr_long = funding (positive = longs pay)
        // borrow_apr_short = -funding (negative funding cost when funding is positive = shorts earn)
        venues.push({
          venue: 'hyperliquid',
          available: true,
          type: 'reference',
          borrow_apr_long: hl.annualized_pct,
          borrow_apr_short: -hl.annualized_pct,
          open_interest_usd: hl.open_interest_usd,
          utilization_pct: null,
          skew: 'unknown',
          mark_price_usd: hl.mark_price_usd,
        });
      }
      // dYdX v4
      if (refSnaps.dydx) {
        const dx = refSnaps.dydx;
        venues.push({
          venue: 'dydx-v4',
          available: true,
          type: 'reference',
          borrow_apr_long: dx.annualized_pct,
          borrow_apr_short: -dx.annualized_pct,
          open_interest_usd: dx.open_interest_usd,
          utilization_pct: null,
          skew: 'unknown',
          mark_price_usd: dx.oracle_price_usd,
        });
      }
    }

    // --- Best entry per side ---
    const solanaVenues = venues.filter(v => v.available && v.type === 'solana-onchain');

    let bestLong: { venue: VenueId; apr: number } | null = null;
    let bestShort: { venue: VenueId; apr: number } | null = null;
    for (const v of solanaVenues) {
      if (v.borrow_apr_long !== null && (!bestLong || v.borrow_apr_long < bestLong.apr)) {
        bestLong = { venue: v.venue, apr: v.borrow_apr_long };
      }
      if (v.borrow_apr_short !== null && (!bestShort || v.borrow_apr_short < bestShort.apr)) {
        bestShort = { venue: v.venue, apr: v.borrow_apr_short };
      }
    }

    const best_entry: BestEntry = {
      long: bestLong
        ? {
            venue: bestLong.venue,
            apr: bestLong.apr,
            reasoning: this.entryReasoning('long', bestLong, solanaVenues),
          }
        : {
            venue: null,
            apr: null,
            reasoning: `No Solana venue available for ${market} longs.`,
          },
      short: bestShort
        ? {
            venue: bestShort.venue,
            apr: bestShort.apr,
            reasoning: this.entryReasoning('short', bestShort, solanaVenues),
          }
        : {
            venue: null,
            apr: null,
            reasoning: `No Solana venue available for ${market} shorts.`,
          },
    };

    // --- Basis: Jupiter/Adrena marks vs Hyperliquid (reference oracle) ---
    const hlMark = venues.find(v => v.venue === 'hyperliquid')?.mark_price_usd ?? null;
    const jupiterMark = venues.find(v => v.venue === 'jupiter-perps')?.mark_price_usd ?? null;
    const adrenaMark = venues.find(v => v.venue === 'adrena')?.mark_price_usd ?? null;

    const jupVsHl = (jupiterMark && hlMark)
      ? Math.round(((jupiterMark - hlMark) / hlMark) * 10_000)
      : null;
    const adrenaVsHl = (adrenaMark && hlMark)
      ? Math.round(((adrenaMark - hlMark) / hlMark) * 10_000)
      : null;

    const basisLines: string[] = [];
    if (jupVsHl !== null) {
      basisLines.push(
        `Jupiter mark trades ${jupVsHl >= 0 ? '+' : ''}${jupVsHl}bps vs Hyperliquid ${jupVsHl >= 0 ? 'premium' : 'discount'}`,
      );
    }
    if (adrenaVsHl !== null) {
      basisLines.push(
        `Adrena mark trades ${adrenaVsHl >= 0 ? '+' : ''}${adrenaVsHl}bps vs Hyperliquid`,
      );
    }
    const basis: BasisInfo = {
      jupiter_vs_hyperliquid_bps: jupVsHl,
      adrena_vs_hyperliquid_bps: adrenaVsHl,
      summary: basisLines.length > 0
        ? basisLines.join('. ') + '.'
        : 'Mark price comparison unavailable (one or more venue marks missing).',
    };

    // --- Arbitrage opportunities (>5pt APR spread across Solana venues) ---
    const arbitrage_opportunities: ArbitrageOpportunity[] = [];
    for (let i = 0; i < solanaVenues.length; i++) {
      for (let j = i + 1; j < solanaVenues.length; j++) {
        const a = solanaVenues[i];
        const b = solanaVenues[j];
        if (a.borrow_apr_long === null || b.borrow_apr_long === null) continue;
        const delta = aprDelta(a.borrow_apr_long, b.borrow_apr_long);
        if (delta >= ARB_MIN_SPREAD_PCT) {
          const cheap = a.borrow_apr_long < b.borrow_apr_long ? a : b;
          const expensive = a.borrow_apr_long < b.borrow_apr_long ? b : a;
          arbitrage_opportunities.push({
            type: 'venue_spread',
            spread_apr_pct: delta,
            long_venue: cheap.venue,
            short_venue: expensive.venue,
            description: `${expensive.venue} borrows at ${(expensive.borrow_apr_long ?? 0).toFixed(2)}% APR vs ${cheap.venue} at ${(cheap.borrow_apr_long ?? 0).toFixed(2)}% APR — ${delta.toFixed(2)}pt spread for same-side hedge.`,
          });
        }
      }
    }

    // Cross-chain basis (Solana onchain venue vs reference)
    if (refSnaps?.hyperliquid && jupiterMark) {
      const refLongApr = refSnaps.hyperliquid.annualized_pct;
      const jupLongApr = venues.find(v => v.venue === 'jupiter-perps')?.borrow_apr_long ?? null;
      if (jupLongApr !== null) {
        const delta = aprDelta(jupLongApr, refLongApr);
        if (delta >= ARB_MIN_SPREAD_PCT) {
          arbitrage_opportunities.push({
            type: 'cross_chain_basis',
            spread_apr_pct: delta,
            long_venue: jupLongApr < refLongApr ? 'jupiter-perps' : 'hyperliquid',
            short_venue: jupLongApr < refLongApr ? 'hyperliquid' : 'jupiter-perps',
            description: `Jupiter ${jupLongApr.toFixed(2)}% vs Hyperliquid ${refLongApr.toFixed(2)}% (${delta.toFixed(2)}pt cross-chain spread).`,
          });
        }
      }
    }

    const out: CrossVenueFunding = {
      market,
      checked_at: Date.now(),
      venues,
      best_entry,
      basis,
      arbitrage_opportunities,
    };

    await this.cache.set(cacheKey, out, CACHE_TTL.perpsMarket);
    return out;
  }

  private entryReasoning(
    side: 'long' | 'short',
    best: { venue: VenueId; apr: number },
    solanaVenues: VenueQuote[],
  ): string {
    const others = solanaVenues.filter(v => v.venue !== best.venue && (side === 'long' ? v.borrow_apr_long !== null : v.borrow_apr_short !== null));
    if (others.length === 0) {
      return `${best.venue} is the only available Solana venue. APR: ${best.apr.toFixed(2)}%.`;
    }
    const next = others
      .map(v => ({ venue: v.venue, apr: side === 'long' ? v.borrow_apr_long! : v.borrow_apr_short! }))
      .sort((a, b) => a.apr - b.apr)[0];
    const delta = Math.abs(best.apr - next.apr);
    return `${best.venue} at ${best.apr.toFixed(2)}% APR — ${delta.toFixed(2)}pts cheaper than ${next.venue} (${next.apr.toFixed(2)}%).`;
  }
}
