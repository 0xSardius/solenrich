// Hyperliquid trader profiler. Reads a trader's live perp positions + PnL history
// from Hyperliquid's public on-chain state (via PerpReferenceClient) and classifies
// directional bias, leverage profile, and per-position risk.
//
// Note: Hyperliquid's clearinghouseState has no per-position entry timestamp, so
// classification is leverage/bias-based (not age-based like the Jupiter/Adrena
// PerpsAnalyzer). HL traders are EVM 0x addresses.

import type {
  PerpReferenceClient,
  HlPositionRaw,
  HlTraderState,
  HlPnl,
} from '../sources/perp-reference';

const HIGH_LEVERAGE = 20;
const EXTREME_LEVERAGE = 50;
const LOSING_PCT = -30;
const NEAR_LIQ_PNL_PCT = -70;
const NEAR_LIQ_DISTANCE_PCT = 5;   // within 5% of liquidation price
const CONCENTRATION_PCT = 80;

export interface HlPositionFlags {
  high_leverage: boolean;
  extreme_leverage: boolean;
  approaching_liquidation: boolean;
  losing: boolean;
}
export interface HlAnalyzedPosition extends HlPositionRaw {
  flags: HlPositionFlags;
}
export type HlProfile =
  | 'no_positions'
  | 'directional_long'
  | 'directional_short'
  | 'market_neutral'
  | 'diversified';

export interface HyperliquidTraderProfile {
  address: string;
  venue: 'hyperliquid';
  has_positions: boolean;
  account: {
    value_usd: number;
    total_notional_usd: number;
    margin_used_usd: number;
    withdrawable_usd: number;
  };
  profile: HlProfile;
  directional_bias: 'long' | 'short' | 'neutral';
  positions: HlAnalyzedPosition[];
  totals: {
    gross_notional_usd: number;
    net_notional_usd: number;
    total_unrealized_pnl_usd: number;
    weighted_leverage: number;
    position_count: number;
  };
  pnl: HlPnl | null;
  flags: {
    any_high_leverage: boolean;
    any_near_liquidation: boolean;
    concentrated_coin: string | null;
  };
  fetched_at: number;
}

function analyzePosition(p: HlPositionRaw): HlAnalyzedPosition {
  return {
    ...p,
    flags: {
      high_leverage: p.leverage >= HIGH_LEVERAGE && p.leverage < EXTREME_LEVERAGE,
      extreme_leverage: p.leverage >= EXTREME_LEVERAGE,
      approaching_liquidation:
        (p.distance_to_liq_pct !== null && p.distance_to_liq_pct < NEAR_LIQ_DISTANCE_PCT) ||
        p.pnl_pct <= NEAR_LIQ_PNL_PCT,
      losing: p.pnl_pct <= LOSING_PCT && p.pnl_pct > NEAR_LIQ_PNL_PCT,
    },
  };
}

function emptyProfile(address: string, pnl: HlPnl | null, now: number): HyperliquidTraderProfile {
  return {
    address,
    venue: 'hyperliquid',
    has_positions: false,
    account: { value_usd: 0, total_notional_usd: 0, margin_used_usd: 0, withdrawable_usd: 0 },
    profile: 'no_positions',
    directional_bias: 'neutral',
    positions: [],
    totals: {
      gross_notional_usd: 0,
      net_notional_usd: 0,
      total_unrealized_pnl_usd: 0,
      weighted_leverage: 0,
      position_count: 0,
    },
    pnl,
    flags: { any_high_leverage: false, any_near_liquidation: false, concentrated_coin: null },
    fetched_at: now,
  };
}

export class HyperliquidAnalyzer {
  constructor(private ref: PerpReferenceClient) {}

  async analyzeTrader(address: string): Promise<HyperliquidTraderProfile> {
    const now = Date.now();
    const [state, pnl] = await Promise.all([
      this.ref.getHlTraderState(address),
      this.ref.getHlPnl(address),
    ]);

    if (!state) return emptyProfile(address, pnl, now);

    const positions = state.positions.map(analyzePosition);
    if (positions.length === 0) {
      // Trader is flat but may still have PnL history + account value — keep them.
      const p = emptyProfile(address, pnl, now);
      p.account = {
        value_usd: state.account_value_usd,
        total_notional_usd: state.total_notional_usd,
        margin_used_usd: state.margin_used_usd,
        withdrawable_usd: state.withdrawable_usd,
      };
      return p;
    }

    let gross = 0, net = 0, upnl = 0, levNotional = 0;
    const byCoin = new Map<string, number>();
    for (const p of positions) {
      gross += p.notional_usd;
      net += p.dir === 'long' ? p.notional_usd : -p.notional_usd;
      upnl += p.unrealized_pnl_usd;
      levNotional += p.notional_usd * p.leverage;
      byCoin.set(p.coin, (byCoin.get(p.coin) ?? 0) + p.notional_usd);
    }
    const weightedLeverage = gross > 0 ? levNotional / gross : 0;
    const directional_bias = net > 0 ? 'long' : net < 0 ? 'short' : 'neutral';

    let concentrated: string | null = null;
    if (gross > 0) {
      for (const [coin, n] of byCoin) {
        if ((n / gross) * 100 >= CONCENTRATION_PCT) concentrated = coin;
      }
    }

    const netRatio = gross > 0 ? Math.abs(net) / gross : 0;
    let profile: HlProfile;
    if (netRatio < 0.3) profile = 'market_neutral';
    else if (positions.length <= 2 || netRatio >= 0.7) profile = net >= 0 ? 'directional_long' : 'directional_short';
    else profile = 'diversified';

    return {
      address,
      venue: 'hyperliquid',
      has_positions: true,
      account: {
        value_usd: state.account_value_usd,
        total_notional_usd: state.total_notional_usd,
        margin_used_usd: state.margin_used_usd,
        withdrawable_usd: state.withdrawable_usd,
      },
      profile,
      directional_bias,
      positions,
      totals: {
        gross_notional_usd: gross,
        net_notional_usd: net,
        total_unrealized_pnl_usd: upnl,
        weighted_leverage: weightedLeverage,
        position_count: positions.length,
      },
      pnl,
      flags: {
        any_high_leverage: positions.some((p) => p.flags.high_leverage || p.flags.extreme_leverage),
        any_near_liquidation: positions.some((p) => p.flags.approaching_liquidation),
        concentrated_coin: concentrated,
      },
      fetched_at: now,
    };
  }
}
