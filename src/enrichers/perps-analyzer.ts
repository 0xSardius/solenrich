// Perps analyzer — enriches raw Jupiter Perps data with risk flags and derived signals.
// Pure transformation layer over JupiterPerpsClient output. No external calls.

import type {
  JupiterPerpsClient,
  PerpsMarketStructure,
  PerpsMarketSnapshot,
  PerpsTraderProfile,
  PerpsPositionData,
} from '../sources/jupiter-perps';

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

export interface EnrichedPosition extends PerpsPositionData {
  flags: PositionRiskFlags;
}

export interface EnrichedTraderProfile {
  address: string;
  has_positions: boolean;
  profile: TraderProfile;
  directional_bias: 'long' | 'short' | 'neutral';
  positions: EnrichedPosition[];
  totals: PerpsTraderProfile['totals'] & {
    net_pnl_pct: number | null;
  };
  flags: {
    any_high_leverage: boolean;
    any_near_liquidation: boolean;
    concentrated_market: string | null; // if >80% of gross exposure in one market
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

function analyzePosition(p: PerpsPositionData): EnrichedPosition {
  const pnlPct = p.unrealized_pnl_pct;
  const flags: PositionRiskFlags = {
    high_leverage: p.leverage >= HIGH_LEVERAGE && p.leverage < EXTREME_LEVERAGE,
    extreme_leverage: p.leverage >= EXTREME_LEVERAGE,
    losing_collateral: pnlPct !== null && pnlPct <= LOSING_COLLATERAL_PCT && pnlPct > NEAR_LIQ_PCT,
    approaching_liquidation: pnlPct !== null && pnlPct <= NEAR_LIQ_PCT,
    stale_position: p.age_hours >= STALE_POSITION_DAYS * 24,
  };
  return { ...p, flags };
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
  constructor(private client: JupiterPerpsClient) {}

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
    // Always fetch market first so we have mark prices for PnL
    const market = await this.client.getMarketStructure();
    const marks = this.client.buildMarkPriceMap(market);
    const raw = await this.client.getPositionsForWallet(address, marks);

    const positions = raw.positions.map(analyzePosition);
    const profile = classifyTrader(positions);

    let directional_bias: 'long' | 'short' | 'neutral' = 'neutral';
    if (raw.totals.gross_exposure_usd > 0) {
      const netRatio = raw.totals.net_exposure_usd / raw.totals.gross_exposure_usd;
      if (netRatio >= 0.2) directional_bias = 'long';
      else if (netRatio <= -0.2) directional_bias = 'short';
    }

    // Market concentration — % of gross exposure in single market
    const perMarket = new Map<string, number>();
    for (const p of positions) {
      perMarket.set(p.market_symbol, (perMarket.get(p.market_symbol) ?? 0) + p.size_usd);
    }
    let concentrated_market: string | null = null;
    if (raw.totals.gross_exposure_usd > 0) {
      for (const [sym, size] of perMarket.entries()) {
        if (size / raw.totals.gross_exposure_usd >= 0.8) {
          concentrated_market = sym;
          break;
        }
      }
    }

    const net_pnl_pct =
      raw.totals.total_collateral_usd > 0
        ? (raw.totals.total_unrealized_pnl_usd / raw.totals.total_collateral_usd) * 100
        : null;

    return {
      address: raw.address,
      has_positions: raw.has_positions,
      profile,
      directional_bias,
      positions,
      totals: { ...raw.totals, net_pnl_pct },
      flags: {
        any_high_leverage: positions.some(p => p.flags.high_leverage || p.flags.extreme_leverage),
        any_near_liquidation: positions.some(p => p.flags.approaching_liquidation),
        concentrated_market,
      },
      fetched_at: raw.fetched_at,
    };
  }
}
