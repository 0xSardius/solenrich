// Venue-comparison enricher — "Where should I trade this market at this size?"
//
// Composes over the cross-venue funding analyzer (which already gathers
// Jupiter Perps + Adrena + Hyperliquid + dYdX state). Adds:
//   - Spot slippage estimate from Jupiter Quote at the requested size
//   - Per-venue fee assumption (v1: constants table)
//   - OI cap headroom for Solana venues (Jupiter only in v1; Adrena's max OI
//     fields aren't yet extracted from the custody decoder)
//   - First-hour borrow cost
//   - Total entry cost = slippage + fee + first-hour borrow
//   - Rankings by each metric + a recommendation string
//
// Buyers: routing/sizing agents (the Jupiter-for-perps-equivalent), risk
// managers, smarter query upgrades.

import type { JupiterClient } from '../sources/jupiter';
import type {
  CrossVenueFunding,
  CrossVenueMarket,
  PerpsCrossVenueAnalyzer,
  VenueId,
  VenueQuote,
} from './perps-cross-venue';
import type { Cache } from '../cache';
import { CACHE_TTL } from '../config';

// --- Constants ---

// Underlying spot token mints used as proxies for slippage probing via Jupiter
// Quote. We swap USDC → token at the requested size and read priceImpactPct.
const SPOT_MINT_FOR_SLIPPAGE: Record<CrossVenueMarket, string | null> = {
  SOL: 'So11111111111111111111111111111111111111112',     // Wrapped SOL
  BTC: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',     // WBTC (Portal)
  ETH: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',     // ETH (Portal)
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',    // BONK
};

// Venue fee assumptions (taker / entry fee, as percent of notional).
// v1 uses public-disclosure constants — read from venue config later.
const VENUE_FEE_PCT: Record<VenueId, number> = {
  'jupiter-perps': 0.06,    // 6bps open fee
  'adrena': 0.06,           // 6bps approximation
  'flash': 0.06,            // 6bps approximation (pool perp, similar structure)
  'hyperliquid': 0.025,     // 2.5bps taker
  'dydx-v4': 0.05,          // 5bps taker
};

const ARB_MIN_DELTA_PCT = 5; // recommendation flags spreads >5pt vs runner-up

// --- Types ---

export interface VenueComparisonRow {
  venue: VenueId;
  available: boolean;
  type: 'solana-onchain' | 'reference';
  borrow_apr_long: number | null;
  borrow_apr_short: number | null;
  open_interest_usd: number | null;
  oi_cap_headroom_usd: number | null;
  estimated_slippage_pct: number | null;
  fee_pct: number | null;
  first_hour_borrow_pct: number | null;
  total_entry_cost_pct: number | null;
  health: 'HEALTHY' | 'TILTED' | 'STRESSED' | 'unknown';
  flags: string[];
  unavailable_reason?: string;
}

export interface PerpsVenueComparison {
  market: CrossVenueMarket;
  size_usd: number;
  side: 'long' | 'short';
  spot_slippage_source: 'jupiter-quote' | 'unavailable';
  spot_slippage_pct: number | null;
  spot_slippage_tier_used: number | null; // which $-tier the estimate came from
  checked_at: number;
  venues: VenueComparisonRow[];
  rankings: {
    by_entry_cost: VenueId[];
    by_borrow_apr: VenueId[];
    by_headroom: VenueId[];
  };
  recommendation: {
    venue: VenueId | null;
    reasoning: string;
    warnings: string[];
  };
}

// --- Helpers ---

/**
 * Pick the smallest Jupiter slippage tier >= size_usd. If size exceeds all
 * tiers, use the largest tier impact (an underestimate flagged in the output).
 * Returns { pct, tier_used } or { pct: null, tier_used: null } if no data.
 */
function pickSlippageTier(
  estimates: Array<{ size_usd: number; price_impact_pct: number }>,
  size_usd: number,
): { pct: number | null; tier_used: number | null } {
  if (estimates.length === 0) return { pct: null, tier_used: null };
  const sorted = [...estimates].sort((a, b) => a.size_usd - b.size_usd);
  for (const tier of sorted) {
    if (tier.size_usd >= size_usd) {
      return { pct: tier.price_impact_pct * 100, tier_used: tier.size_usd };
    }
  }
  // size exceeds all tiers — use largest, flag as underestimate downstream
  const largest = sorted[sorted.length - 1];
  return { pct: largest.price_impact_pct * 100, tier_used: largest.size_usd };
}

function deriveOiCapHeadroom(
  market: CrossVenueMarket,
  venue: VenueId,
  side: 'long' | 'short',
  cross: CrossVenueFunding,
  jupiterMarketStructure: any,
): number | null {
  if (venue === 'jupiter-perps' && jupiterMarketStructure?.markets) {
    const m = jupiterMarketStructure.markets.find(
      (x: any) => x.symbol === market,
    );
    if (!m) return null;
    const cap = side === 'long'
      ? m.limits?.max_long_oi_usd
      : m.limits?.max_short_oi_usd;
    const current = side === 'long'
      ? m.open_interest?.long_usd
      : m.open_interest?.short_usd;
    if (cap === undefined || current === undefined) return null;
    return Math.max(0, cap - current);
  }
  // Adrena OI caps require decoding pricing.max_cumulative_*_position_size_usd
  // from the custody account, which our v1 decoder skips. Reference venues
  // don't publish hard OI caps in the data we currently fetch.
  return null;
}

function classifyHealth(
  q: VenueQuote,
  cross: CrossVenueFunding,
): 'HEALTHY' | 'TILTED' | 'STRESSED' | 'unknown' {
  if (!q.available) return 'unknown';
  // Reuse the existing skew + utilization signals from cross-venue analyzer.
  const flags: string[] = [];
  if (q.skew === 'long-heavy' || q.skew === 'short-heavy') flags.push('skew');
  if (q.utilization_pct !== null && q.utilization_pct >= 80) flags.push('util');
  if ((q.borrow_apr_long ?? 0) >= 50) flags.push('apr');
  if (flags.length >= 2) return 'STRESSED';
  if (flags.length === 1) return 'TILTED';
  return 'HEALTHY';
}

function buildFlags(row: VenueComparisonRow, size_usd: number): string[] {
  const flags: string[] = [];
  if (row.borrow_apr_long !== null && row.borrow_apr_long >= 50) {
    flags.push('elevated_borrow_rate');
  }
  if (row.oi_cap_headroom_usd !== null && row.oi_cap_headroom_usd < size_usd) {
    flags.push('insufficient_headroom');
  } else if (row.oi_cap_headroom_usd !== null && row.oi_cap_headroom_usd < size_usd * 2) {
    flags.push('low_headroom');
  }
  if (row.estimated_slippage_pct !== null && row.estimated_slippage_pct >= 1) {
    flags.push('high_slippage');
  }
  return flags;
}

// --- Analyzer ---

export class PerpsVenueComparator {
  constructor(
    private cross: PerpsCrossVenueAnalyzer,
    private jupiter: JupiterClient,
    private jupiterPerps: any, // JupiterPerpsClient — used for OI cap reads
    private cache: Cache,
  ) {}

  async compare(
    market: CrossVenueMarket,
    size_usd: number,
    side: 'long' | 'short',
  ): Promise<PerpsVenueComparison> {
    const cacheKey = `perps-venue-comparison:${market}:${size_usd}:${side}`;
    const cached = await this.cache.get<PerpsVenueComparison>(cacheKey);
    if (cached) return cached;

    // Run the three things we need in parallel:
    //   1. Cross-venue funding (already composes all 4 venue states)
    //   2. Jupiter spot quote for slippage at this size
    //   3. Jupiter Perps market structure (for OI cap headroom)
    const spotMint = SPOT_MINT_FOR_SLIPPAGE[market];
    const [crossData, slippageEstimates, jupiterStructure] = await Promise.all([
      this.cross.analyze(market, true),
      spotMint ? this.jupiter.getSlippageEstimates(spotMint) : Promise.resolve([]),
      this.jupiterPerps.getMarketStructure().catch(() => null),
    ]);

    const slippagePick = pickSlippageTier(slippageEstimates, size_usd);
    const spotSlippagePct = slippagePick.pct;
    const spotSlippageSource: 'jupiter-quote' | 'unavailable' =
      slippagePick.pct !== null ? 'jupiter-quote' : 'unavailable';

    // Build per-venue comparison rows
    const venues: VenueComparisonRow[] = crossData.venues.map((q) => {
      const apr = side === 'long' ? q.borrow_apr_long : q.borrow_apr_short;
      const fee = VENUE_FEE_PCT[q.venue] ?? null;
      const firstHourBorrowPct = apr !== null ? apr / (24 * 365) : null;
      const headroom = deriveOiCapHeadroom(market, q.venue, side, crossData, jupiterStructure);
      const slippageForVenue = q.available ? spotSlippagePct : null;

      const components = [slippageForVenue, fee, firstHourBorrowPct].filter(
        (x): x is number => x !== null,
      );
      const totalEntryCost = q.available && components.length === 3
        ? slippageForVenue! + fee! + firstHourBorrowPct!
        : null;

      const row: VenueComparisonRow = {
        venue: q.venue,
        available: q.available,
        type: q.type,
        borrow_apr_long: q.borrow_apr_long,
        borrow_apr_short: q.borrow_apr_short,
        open_interest_usd: q.open_interest_usd,
        oi_cap_headroom_usd: headroom,
        estimated_slippage_pct: slippageForVenue,
        fee_pct: fee,
        first_hour_borrow_pct: firstHourBorrowPct,
        total_entry_cost_pct: totalEntryCost,
        health: classifyHealth(q, crossData),
        flags: [],
        unavailable_reason: q.unavailable_reason,
      };
      row.flags = buildFlags(row, size_usd);
      return row;
    });

    // --- Rankings ---
    const ranked = <K extends keyof VenueComparisonRow>(
      key: K,
      direction: 'asc' | 'desc',
    ): VenueId[] =>
      venues
        .filter((v) => v.available && v[key] !== null)
        .slice()
        .sort((a, b) => {
          const av = a[key] as number;
          const bv = b[key] as number;
          return direction === 'asc' ? av - bv : bv - av;
        })
        .map((v) => v.venue);

    const rankings = {
      by_entry_cost: ranked('total_entry_cost_pct', 'asc'),
      by_borrow_apr: ranked(side === 'long' ? 'borrow_apr_long' : 'borrow_apr_short', 'asc'),
      by_headroom: ranked('oi_cap_headroom_usd', 'desc'),
    };

    // --- Recommendation ---
    const recommendation = this.buildRecommendation(venues, size_usd, side, rankings);

    const out: PerpsVenueComparison = {
      market,
      size_usd,
      side,
      spot_slippage_source: spotSlippageSource,
      spot_slippage_pct: spotSlippagePct,
      spot_slippage_tier_used: slippagePick.tier_used,
      checked_at: Date.now(),
      venues,
      rankings,
      recommendation,
    };

    await this.cache.set(cacheKey, out, CACHE_TTL.perpsMarket);
    return out;
  }

  private buildRecommendation(
    venues: VenueComparisonRow[],
    size_usd: number,
    side: 'long' | 'short',
    rankings: PerpsVenueComparison['rankings'],
  ): PerpsVenueComparison['recommendation'] {
    // Filter to Solana-onchain, available, with headroom for the size, prefer HEALTHY.
    const candidates = venues.filter(
      (v) =>
        v.available &&
        v.type === 'solana-onchain' &&
        v.total_entry_cost_pct !== null &&
        !v.flags.includes('insufficient_headroom'),
    );

    if (candidates.length === 0) {
      // Fall back to anything available
      const any = venues.filter((v) => v.available && v.type === 'solana-onchain');
      if (any.length === 0) {
        return {
          venue: null,
          reasoning: `No Solana venue available for ${side === 'long' ? 'longs' : 'shorts'} of this size.`,
          warnings: ['no_solana_venue'],
        };
      }
      return {
        venue: any[0].venue,
        reasoning: `${any[0].venue} is the only available Solana venue, but headroom is below requested size. Consider reducing position or using a reference venue.`,
        warnings: ['insufficient_headroom'],
      };
    }

    // Pick cheapest by total entry cost.
    const sorted = candidates.slice().sort(
      (a, b) => (a.total_entry_cost_pct ?? 0) - (b.total_entry_cost_pct ?? 0),
    );
    const best = sorted[0];
    const runnerUp = sorted[1];

    const warnings: string[] = [];
    if (best.health === 'STRESSED') warnings.push('best_venue_stressed');
    else if (best.health === 'TILTED') warnings.push('best_venue_tilted');
    if (best.flags.includes('low_headroom')) warnings.push('low_headroom');
    if (best.flags.includes('high_slippage')) warnings.push('high_slippage');

    let reasoning = `${best.venue} cheapest at ${(best.total_entry_cost_pct ?? 0).toFixed(3)}% total entry cost`;
    if (runnerUp) {
      const delta = (runnerUp.total_entry_cost_pct ?? 0) - (best.total_entry_cost_pct ?? 0);
      reasoning += ` (${delta.toFixed(3)}pt below ${runnerUp.venue} at ${(runnerUp.total_entry_cost_pct ?? 0).toFixed(3)}%)`;
    }
    if (best.oi_cap_headroom_usd !== null && best.oi_cap_headroom_usd > 0) {
      reasoning += `. Headroom: $${Math.round(best.oi_cap_headroom_usd).toLocaleString()}`;
    }
    if (best.health !== 'HEALTHY') {
      reasoning += ` — health: ${best.health}`;
    }
    reasoning += '.';

    return { venue: best.venue, reasoning, warnings };
  }
}
