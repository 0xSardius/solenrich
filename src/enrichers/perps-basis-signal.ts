// Basis-signal enricher — "Is there a profitable basis trade right now?"
//
// Computes the perp-vs-spot price gap across venues and surfaces the
// net-yield-after-borrow for each potential trade. Not the raw spread —
// the actual yield an agent would earn after paying the funding/borrow
// cost on the hedging side.
//
// Two venue archetypes generate different trade economics:
//   1. Funding-rate perps (Hyperliquid, dYdX v4) — sign-aware funding rate.
//      Short-perp + long-spot earns funding APR when funding > 0 (and vice
//      versa). Long-spot has no carrying cost. Net yield = funding APR.
//   2. Borrow-rate perps (Jupiter Perps, Adrena) — both sides pay borrow.
//      No funding-paid mechanism. Mark/spot gap doesn't translate to APR.
//      A short-perp + long-spot position pays borrow continuously, so
//      net yield = -borrow APR. Not a viable basis trade on its own.
//
// Buyers: delta-neutral yield agents, funding-rate arb bots, quant
// strategy bots, risk-managed portfolio agents.

import type { PerpsCrossVenueAnalyzer, CrossVenueMarket, VenueId } from './perps-cross-venue';
import type { PriceAggregator } from '../utils/price-aggregator';
import type { Cache } from '../cache';
import { CACHE_TTL } from '../config';

// --- Constants ---

// Underlying spot token mints for PriceAggregator. Same mapping used in
// perps-venue-comparison — kept inline for clarity in two places rather
// than introducing a shared module for four constants.
const SPOT_MINT: Record<CrossVenueMarket, string | null> = {
  SOL: 'So11111111111111111111111111111111111111112',     // Wrapped SOL
  BTC: '3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh',     // WBTC (Portal)
  ETH: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',     // ETH (Portal)
  BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',    // BONK
};

// --- Types ---

export type RateMechanism = 'funding-rate' | 'borrow-rate';
export type TradeDirection = 'short_perp_long_spot' | 'long_perp_short_spot' | null;

export interface BasisVenueRow {
  venue: VenueId;
  available: boolean;
  type: 'solana-onchain' | 'reference';
  rate_mechanism: RateMechanism;
  mark_price_usd: number | null;
  basis_bps: number | null;
  /** Sign-aware funding APR (reference venues) or borrow APR (Solana venues). */
  rate_apr_pct: number | null;
  trade: {
    direction: TradeDirection;
    /** APR earnable from funding payments (positive only for reference venues). */
    expected_yield_pct: number;
    /** APR paid as borrow cost on the hedging side. */
    cost_pct: number;
    net_yield_pct: number;
    viable: boolean;
    reasoning: string;
  };
  unavailable_reason?: string;
}

export interface PerpsBasisSignal {
  asset: CrossVenueMarket;
  spot: {
    price_usd: number;
    sources: number;
    spread_pct: number;
  } | null;
  checked_at: number;
  min_yield_apr_pct: number;
  venues: BasisVenueRow[];
  opportunities: BasisVenueRow[]; // venues where trade.viable && trade.net_yield_pct >= threshold
  best_trade: {
    venue: VenueId;
    direction: TradeDirection;
    net_yield_pct: number;
  } | null;
  summary: string;
}

// --- Analyzer ---

export class PerpsBasisAnalyzer {
  constructor(
    private cross: PerpsCrossVenueAnalyzer,
    private priceAggregator: PriceAggregator,
    private cache: Cache,
  ) {}

  async analyze(
    asset: CrossVenueMarket,
    min_yield_apr_pct = 5,
  ): Promise<PerpsBasisSignal> {
    const cacheKey = `perps-basis-signal:${asset}:${min_yield_apr_pct}`;
    const cached = await this.cache.get<PerpsBasisSignal>(cacheKey);
    if (cached) return cached;

    // Two parallel fetches:
    //   1. Cross-venue funding (marks + per-venue APRs)
    //   2. Spot price via PriceAggregator
    const spotMint = SPOT_MINT[asset];
    const [crossData, spotPrice] = await Promise.all([
      this.cross.analyze(asset, true),
      spotMint ? this.priceAggregator.getPrice(spotMint) : Promise.resolve(null),
    ]);

    const spot = spotPrice && spotPrice.price > 0
      ? {
          price_usd: spotPrice.price,
          sources: spotPrice.sources,
          spread_pct: spotPrice.spread_pct,
        }
      : null;

    const venues: BasisVenueRow[] = crossData.venues.map((q) => {
      const mark = q.mark_price_usd;
      const basis_bps = (mark && spot)
        ? Math.round(((mark - spot.price_usd) / spot.price_usd) * 10_000)
        : null;

      const mechanism: RateMechanism = q.type === 'reference' ? 'funding-rate' : 'borrow-rate';

      // Reference venues store sign-aware funding on borrow_apr_long.
      // (Positive funding = longs pay. We mapped short to -funding in cross-venue.)
      // For trade math we want the raw funding rate, so derive it from long APR.
      const rate_apr_pct = q.borrow_apr_long;

      const trade = this.computeTrade(q, mechanism, rate_apr_pct);

      const row: BasisVenueRow = {
        venue: q.venue,
        available: q.available,
        type: q.type,
        rate_mechanism: mechanism,
        mark_price_usd: mark,
        basis_bps,
        rate_apr_pct,
        trade,
        unavailable_reason: q.unavailable_reason,
      };
      return row;
    });

    // Filter to viable opportunities above threshold
    const opportunities = venues.filter(
      (v) => v.available && v.trade.viable && v.trade.net_yield_pct >= min_yield_apr_pct,
    );

    // Best trade = highest net yield among viable opportunities
    let best_trade: PerpsBasisSignal['best_trade'] = null;
    if (opportunities.length > 0) {
      const top = opportunities.reduce((a, b) =>
        b.trade.net_yield_pct > a.trade.net_yield_pct ? b : a,
      );
      best_trade = {
        venue: top.venue,
        direction: top.trade.direction,
        net_yield_pct: top.trade.net_yield_pct,
      };
    }

    const summary = this.buildSummary(asset, venues, opportunities, best_trade, min_yield_apr_pct, spot);

    const out: PerpsBasisSignal = {
      asset,
      spot,
      checked_at: Date.now(),
      min_yield_apr_pct,
      venues,
      opportunities,
      best_trade,
      summary,
    };

    await this.cache.set(cacheKey, out, CACHE_TTL.perpsMarket);
    return out;
  }

  /**
   * Trade economics per venue archetype.
   *
   * Reference (funding-rate):
   *   funding > 0 → longs pay shorts → short_perp_long_spot earns +funding APR
   *   funding < 0 → shorts pay longs → long_perp_short_spot earns +|funding| APR
   *   Long-spot side has no carrying cost. Net yield = abs(funding APR).
   *
   * Solana (borrow-rate):
   *   Both sides pay borrow APR. No funding-income mechanism. Short-perp +
   *   long-spot continuously pays borrow on the perp leg. Net yield = -borrow.
   *   Marked as not viable for basis trading on its own.
   */
  private computeTrade(
    quote: { venue: VenueId; available: boolean; type: 'solana-onchain' | 'reference' },
    mechanism: RateMechanism,
    rate_apr_pct: number | null,
  ): BasisVenueRow['trade'] {
    if (!quote.available || rate_apr_pct === null) {
      return {
        direction: null,
        expected_yield_pct: 0,
        cost_pct: 0,
        net_yield_pct: 0,
        viable: false,
        reasoning: quote.available
          ? 'No rate data available for this venue.'
          : 'Venue not available for this market.',
      };
    }

    if (mechanism === 'borrow-rate') {
      // Solana pool perps: both sides pay borrow. No funding income.
      return {
        direction: null,
        expected_yield_pct: 0,
        cost_pct: Math.abs(rate_apr_pct),
        net_yield_pct: -Math.abs(rate_apr_pct),
        viable: false,
        reasoning: `Pool perps charge ${rate_apr_pct.toFixed(2)}% APR borrow on both sides. No funding-income mechanism — basis trade not viable on its own.`,
      };
    }

    // Reference venue: sign-aware funding rate.
    if (rate_apr_pct > 0) {
      return {
        direction: 'short_perp_long_spot',
        expected_yield_pct: rate_apr_pct,
        cost_pct: 0,
        net_yield_pct: rate_apr_pct,
        viable: true,
        reasoning: `Funding +${rate_apr_pct.toFixed(2)}% APR — longs pay shorts. Short the perp, hold spot.`,
      };
    }
    if (rate_apr_pct < 0) {
      return {
        direction: 'long_perp_short_spot',
        expected_yield_pct: -rate_apr_pct,
        cost_pct: 0,
        net_yield_pct: -rate_apr_pct,
        viable: true,
        reasoning: `Funding ${rate_apr_pct.toFixed(2)}% APR — shorts pay longs. Long the perp, short spot (note: shorting spot requires borrow elsewhere — verify before execution).`,
      };
    }
    return {
      direction: null,
      expected_yield_pct: 0,
      cost_pct: 0,
      net_yield_pct: 0,
      viable: false,
      reasoning: 'Funding rate is zero — no basis yield available.',
    };
  }

  private buildSummary(
    asset: CrossVenueMarket,
    venues: BasisVenueRow[],
    opportunities: BasisVenueRow[],
    best_trade: PerpsBasisSignal['best_trade'],
    threshold: number,
    spot: PerpsBasisSignal['spot'],
  ): string {
    if (!spot) {
      return `No spot price available for ${asset}. Basis comparison requires both spot and at least one perp mark.`;
    }
    if (opportunities.length === 0) {
      const referenceVenues = venues.filter((v) => v.available && v.rate_mechanism === 'funding-rate');
      if (referenceVenues.length === 0) {
        return `No basis-trade opportunities above ${threshold}% APR threshold for ${asset}. Solana venues charge borrow on both sides; no reference venues available.`;
      }
      const tops = referenceVenues
        .slice()
        .sort((a, b) => Math.abs(b.rate_apr_pct ?? 0) - Math.abs(a.rate_apr_pct ?? 0))
        .slice(0, 2);
      const detail = tops
        .map((v) => `${v.venue} (${(v.rate_apr_pct ?? 0).toFixed(2)}% APR)`)
        .join(', ');
      return `No basis trades above ${threshold}% APR. Current reference rates: ${detail}.`;
    }
    if (best_trade) {
      const venueLabel = best_trade.venue;
      const dir = best_trade.direction === 'short_perp_long_spot'
        ? 'short perp, long spot'
        : 'long perp, short spot';
      return `${venueLabel} offers ${best_trade.net_yield_pct.toFixed(2)}% net yield (${dir}). ${opportunities.length} opportunity${opportunities.length === 1 ? '' : ' s'} above ${threshold}% threshold.`;
    }
    return `Basis-trade scan complete for ${asset}. ${opportunities.length} opportunities above ${threshold}% threshold.`;
  }
}
