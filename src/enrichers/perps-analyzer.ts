// Perps analyzer — enriches raw Jupiter Perps + Adrena data with risk flags and derived signals.
// Pure transformation layer over upstream client output. Modest fan-out (one parallel call
// to each venue + price fetch for Adrena collateral mints) but no orchestration.

import type {
  JupiterPerpsClient,
  PerpsMarketStructure,
  PerpsMarketSnapshot,
  PerpsTraderProfile,
  PerpsPositionData,
} from '../sources/jupiter-perps';
import type {
  AdrenaClient,
  AdrenaPositionData,
  AdrenaTraderProfile,
} from '../sources/adrena';
import { ADRENA_COLLATERAL_MINT } from '../sources/adrena';
import type { JupiterClient } from '../sources/jupiter';

export type MarketHealth = 'HEALTHY' | 'TILTED' | 'STRESSED';
export type TraderProfile = 'no_positions' | 'scalper' | 'swing_trader' | 'position_trader';

export interface MarketRiskFlags {
  extreme_long_skew: boolean;
  extreme_short_skew: boolean;
  high_utilization: boolean;
  near_long_oi_cap: boolean;
  near_short_oi_cap: boolean;
  elevated_borrow_rate: boolean;
}

export interface EnrichedMarketSnapshot extends PerpsMarketSnapshot {
  flags: MarketRiskFlags;
  long_headroom_usd: number;
  short_headroom_usd: number;
  health: MarketHealth;
  notes: string[];
}

export interface EnrichedMarketStructure {
  pool: string;
  markets: EnrichedMarketSnapshot[];
  totals: PerpsMarketStructure['totals'];
  overall_health: MarketHealth;
  summary_notes: string[];
  fetched_at: number;
}

export interface PositionRiskFlags {
  high_leverage: boolean;       // leverage > 20x
  extreme_leverage: boolean;    // leverage > 50x
  losing_collateral: boolean;   // uPnL < -30% of collateral
  approaching_liquidation: boolean; // uPnL < -70% of collateral
  stale_position: boolean;      // open > 30 days
}

export type PerpVenue = 'jupiter' | 'adrena';

export interface EnrichedPosition extends PerpsPositionData {
  flags: PositionRiskFlags;
  venue: PerpVenue;
}

export interface VenueTotals {
  gross_exposure_usd: number;
  net_exposure_usd: number;
  total_collateral_usd: number;
  total_unrealized_pnl_usd: number;
  weighted_leverage: number;
  net_pnl_pct: number | null;
}

export interface VenueBreakdown {
  has_positions: boolean;
  positions: EnrichedPosition[];
  totals: VenueTotals;
  /** Per-venue notes when relevant (e.g. Adrena BONK position with no mark price). */
  notes: string[];
}

export interface EnrichedTraderProfile {
  address: string;
  /** True if any position exists on any venue. */
  has_positions: boolean;
  profile: TraderProfile;
  directional_bias: 'long' | 'short' | 'neutral';
  /** All positions across all venues, each tagged with `venue`. */
  positions: EnrichedPosition[];
  /** Combined totals across all venues. */
  totals: VenueTotals;
  /** Per-venue breakdown. Always present even when a venue has no positions. */
  by_venue: Record<PerpVenue, VenueBreakdown>;
  flags: {
    any_high_leverage: boolean;
    any_near_liquidation: boolean;
    concentrated_market: string | null; // if >80% of gross exposure in one market
    multi_venue: boolean;               // positions on both Jupiter and Adrena
  };
  fetched_at: number;
}

// --- Thresholds ---
const EXTREME_SKEW_PCT = 75;      // long_pct or short_pct above this = extreme
const HIGH_UTIL_PCT = 80;
const NEAR_CAP_PCT = 85;           // oi / max_oi above this
const ELEVATED_APR_PCT = 50;       // annualized borrow > 50%
const HIGH_LEVERAGE = 20;
const EXTREME_LEVERAGE = 50;
const LOSING_COLLATERAL_PCT = -30;
const NEAR_LIQ_PCT = -70;
const STALE_POSITION_DAYS = 30;
const SCALPER_MAX_AGE_HOURS = 24;
const SWING_MAX_AGE_HOURS = 24 * 14; // 2 weeks

// --- Market analyzer ---

function analyzeMarketSnapshot(m: PerpsMarketSnapshot): EnrichedMarketSnapshot {
  const notes: string[] = [];

  const flags: MarketRiskFlags = {
    extreme_long_skew: m.open_interest.long_pct >= EXTREME_SKEW_PCT,
    extreme_short_skew: m.open_interest.short_pct >= EXTREME_SKEW_PCT,
    high_utilization: m.utilization_pct >= HIGH_UTIL_PCT,
    near_long_oi_cap:
      m.limits.max_long_oi_usd > 0 &&
      (m.open_interest.long_usd / m.limits.max_long_oi_usd) * 100 >= NEAR_CAP_PCT,
    near_short_oi_cap:
      m.limits.max_short_oi_usd > 0 &&
      (m.open_interest.short_usd / m.limits.max_short_oi_usd) * 100 >= NEAR_CAP_PCT,
    elevated_borrow_rate: m.borrow_rate.annualized_pct >= ELEVATED_APR_PCT,
  };

  const long_headroom_usd = Math.max(0, m.limits.max_long_oi_usd - m.open_interest.long_usd);
  const short_headroom_usd = Math.max(0, m.limits.max_short_oi_usd - m.open_interest.short_usd);

  if (flags.extreme_long_skew) notes.push(`${m.symbol} longs dominate (${m.open_interest.long_pct.toFixed(0)}%)`);
  if (flags.extreme_short_skew) notes.push(`${m.symbol} shorts dominate (${m.open_interest.short_pct.toFixed(0)}%)`);
  if (flags.near_long_oi_cap) notes.push(`${m.symbol} near long OI cap (${long_headroom_usd.toLocaleString(undefined, { maximumFractionDigits: 0 })} USD left)`);
  if (flags.near_short_oi_cap) notes.push(`${m.symbol} near short OI cap (${short_headroom_usd.toLocaleString(undefined, { maximumFractionDigits: 0 })} USD left)`);
  if (flags.high_utilization) notes.push(`${m.symbol} pool utilization ${m.utilization_pct.toFixed(1)}%`);
  if (flags.elevated_borrow_rate) notes.push(`${m.symbol} elevated borrow: ${m.borrow_rate.annualized_pct.toFixed(1)}% APR`);

  let health: MarketHealth = 'HEALTHY';
  const flagCount =
    Number(flags.extreme_long_skew) +
    Number(flags.extreme_short_skew) +
    Number(flags.high_utilization) +
    Number(flags.near_long_oi_cap) +
    Number(flags.near_short_oi_cap) +
    Number(flags.elevated_borrow_rate);
  if (flagCount >= 3) health = 'STRESSED';
  else if (flagCount >= 1) health = 'TILTED';

  return {
    ...m,
    flags,
    long_headroom_usd,
    short_headroom_usd,
    health,
    notes,
  };
}

// --- Trader analyzer ---

function analyzePosition(p: PerpsPositionData, venue: PerpVenue): EnrichedPosition {
  const pnlPct = p.unrealized_pnl_pct;
  const flags: PositionRiskFlags = {
    high_leverage: p.leverage >= HIGH_LEVERAGE && p.leverage < EXTREME_LEVERAGE,
    extreme_leverage: p.leverage >= EXTREME_LEVERAGE,
    losing_collateral: pnlPct !== null && pnlPct <= LOSING_COLLATERAL_PCT && pnlPct > NEAR_LIQ_PCT,
    approaching_liquidation: pnlPct !== null && pnlPct <= NEAR_LIQ_PCT,
    stale_position: p.age_hours >= STALE_POSITION_DAYS * 24,
  };
  return { ...p, flags, venue };
}

/** Build VenueTotals from raw venue totals + a computed net_pnl_pct. */
function buildVenueTotals(t: {
  gross_exposure_usd: number;
  net_exposure_usd: number;
  total_collateral_usd: number;
  total_unrealized_pnl_usd: number;
  weighted_leverage: number;
}): VenueTotals {
  return {
    ...t,
    net_pnl_pct:
      t.total_collateral_usd > 0
        ? (t.total_unrealized_pnl_usd / t.total_collateral_usd) * 100
        : null,
  };
}

/** Adrena AdrenaPositionData is structurally identical to PerpsPositionData for our analyzer. */
function adrenaToPosData(p: AdrenaPositionData): PerpsPositionData {
  return {
    pool: p.pool,
    custody: p.custody,
    market_symbol: p.market_symbol,
    side: p.side,
    size_usd: p.size_usd,
    collateral_usd: p.collateral_usd,
    leverage: p.leverage,
    entry_price_usd: p.entry_price_usd,
    mark_price_usd: p.mark_price_usd,
    unrealized_pnl_usd: p.unrealized_pnl_usd,
    unrealized_pnl_pct: p.unrealized_pnl_pct,
    realized_pnl_usd: 0, // Adrena doesn't surface this in the per-position record we read
    open_time: p.open_time,
    update_time: p.update_time,
    age_hours: p.age_hours,
  };
}

function classifyTrader(positions: EnrichedPosition[]): TraderProfile {
  if (positions.length === 0) return 'no_positions';
  const avgAge = positions.reduce((s, p) => s + p.age_hours, 0) / positions.length;
  if (avgAge <= SCALPER_MAX_AGE_HOURS) return 'scalper';
  if (avgAge <= SWING_MAX_AGE_HOURS) return 'swing_trader';
  return 'position_trader';
}

// --- Public API ---

export class PerpsAnalyzer {
  constructor(
    private client: JupiterPerpsClient,
    private adrena: AdrenaClient,
    private jupiter: JupiterClient,
  ) {}

  async analyzeMarket(): Promise<EnrichedMarketStructure> {
    const raw = await this.client.getMarketStructure();
    const markets = raw.markets.map(analyzeMarketSnapshot);

    const healths = markets.map(m => m.health);
    let overall_health: MarketHealth = 'HEALTHY';
    if (healths.some(h => h === 'STRESSED')) overall_health = 'STRESSED';
    else if (healths.some(h => h === 'TILTED')) overall_health = 'TILTED';

    const summary_notes = markets.flatMap(m => m.notes);

    return {
      pool: raw.pool,
      markets,
      totals: raw.totals,
      overall_health,
      summary_notes,
      fetched_at: raw.fetched_at,
    };
  }

  async analyzeTrader(address: string): Promise<EnrichedTraderProfile> {
    // Phase 1: fetch what's needed for mark prices in parallel.
    //   - Jupiter Perps market structure (mark prices for SOL/BTC/ETH custodies)
    //   - Adrena collateral prices via Jupiter aggregator (jitoSOL/WBTC/BONK)
    const adrenaMints = Object.values(ADRENA_COLLATERAL_MINT);
    const [market, adrenaPriceMap] = await Promise.all([
      this.client.getMarketStructure(),
      this.jupiter.getPrice(adrenaMints).catch(() => ({} as Record<string, { price: number }>)),
    ]);

    const jupiterMarks = this.client.buildMarkPriceMap(market);
    const adrenaMarks = new Map<string, number | null>();
    for (const mint of adrenaMints) {
      const p = adrenaPriceMap[mint];
      adrenaMarks.set(mint, p && p.price > 0 ? p.price : null);
    }

    // Phase 2: fetch positions on each venue in parallel.
    const [jupRaw, adrRaw] = await Promise.all([
      this.client.getPositionsForWallet(address, jupiterMarks),
      this.adrena.getPositionsForWallet(address, adrenaMarks),
    ]);

    // Per-venue enriched breakdown
    const jupPositions = jupRaw.positions.map(p => analyzePosition(p, 'jupiter'));
    const adrPositions = adrRaw.positions.map(p =>
      analyzePosition(adrenaToPosData(p), 'adrena'),
    );

    const adrenaNotes: string[] = [];
    for (const p of adrPositions) {
      if (p.mark_price_usd === null) {
        adrenaNotes.push(
          `${p.market_symbol} ${p.side} position — mark price unavailable, PnL not computed`,
        );
      }
    }

    const by_venue: Record<PerpVenue, VenueBreakdown> = {
      jupiter: {
        has_positions: jupRaw.has_positions,
        positions: jupPositions,
        totals: buildVenueTotals(jupRaw.totals),
        notes: [],
      },
      adrena: {
        has_positions: adrRaw.has_positions,
        positions: adrPositions,
        totals: buildVenueTotals(adrRaw.totals),
        notes: adrenaNotes,
      },
    };

    // Combined view
    const positions = [...jupPositions, ...adrPositions];
    const profile = classifyTrader(positions);

    const combinedTotalsRaw = {
      gross_exposure_usd:
        jupRaw.totals.gross_exposure_usd + adrRaw.totals.gross_exposure_usd,
      net_exposure_usd: jupRaw.totals.net_exposure_usd + adrRaw.totals.net_exposure_usd,
      total_collateral_usd:
        jupRaw.totals.total_collateral_usd + adrRaw.totals.total_collateral_usd,
      total_unrealized_pnl_usd:
        jupRaw.totals.total_unrealized_pnl_usd + adrRaw.totals.total_unrealized_pnl_usd,
      weighted_leverage: 0, // computed below
    };
    combinedTotalsRaw.weighted_leverage =
      combinedTotalsRaw.total_collateral_usd > 0
        ? combinedTotalsRaw.gross_exposure_usd / combinedTotalsRaw.total_collateral_usd
        : 0;
    const totals = buildVenueTotals(combinedTotalsRaw);

    let directional_bias: 'long' | 'short' | 'neutral' = 'neutral';
    if (totals.gross_exposure_usd > 0) {
      const netRatio = totals.net_exposure_usd / totals.gross_exposure_usd;
      if (netRatio >= 0.2) directional_bias = 'long';
      else if (netRatio <= -0.2) directional_bias = 'short';
    }

    // Market concentration — % of gross exposure in single market (across venues)
    const perMarket = new Map<string, number>();
    for (const p of positions) {
      perMarket.set(p.market_symbol, (perMarket.get(p.market_symbol) ?? 0) + p.size_usd);
    }
    let concentrated_market: string | null = null;
    if (totals.gross_exposure_usd > 0) {
      for (const [sym, size] of perMarket.entries()) {
        if (size / totals.gross_exposure_usd >= 0.8) {
          concentrated_market = sym;
          break;
        }
      }
    }

    return {
      address,
      has_positions: positions.length > 0,
      profile,
      directional_bias,
      positions,
      totals,
      by_venue,
      flags: {
        any_high_leverage: positions.some(p => p.flags.high_leverage || p.flags.extreme_leverage),
        any_near_liquidation: positions.some(p => p.flags.approaching_liquidation),
        concentrated_market,
        multi_venue: jupRaw.has_positions && adrRaw.has_positions,
      },
      fetched_at: Math.max(jupRaw.fetched_at, adrRaw.fetched_at),
    };
  }
}
