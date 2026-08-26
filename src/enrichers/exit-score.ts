/**
 * Exit scoring — PURE functions, no I/O. The math behind `exit-signal`.
 *
 * The mirror image of runner-score. Runner-score asks "is buying accelerating"
 * (the entry question). This module asks "is the move over" (the exit
 * question): decelerating buys, sellers taking control, whales distributing,
 * liquidity leaving, holders leaving. A position holder cares about a
 * different set of failure modes than a buyer — most of all the rug in
 * progress, which must override every upside signal.
 *
 * Score semantics: 0 = no exit case, 1 = exit now. Verdicts map from the
 * score, but hard triggers (LP pull, active dump) force EXIT regardless.
 */

// --- Types ---

export type ExitVerdict = 'EXIT' | 'DERISK' | 'HOLD' | 'INSUFFICIENT_DATA';

export interface WindowTxns {
  buys: number;
  sells: number;
}

export interface WhaleFlowInput {
  net_flow_direction: 'accumulating' | 'distributing' | 'neutral';
  distributing_count: number;
  accumulating_count: number;
  whale_count: number;
  total_sell_volume_usd: number;
  total_buy_volume_usd: number;
}

export interface ExitScoreInput {
  txns: { m5: WindowTxns; h1: WindowTxns; h6: WindowTxns; h24: WindowTxns };
  volume: { m5: number; h1: number; h6: number; h24: number };
  price_change: { m5: number; h1: number; h6: number; h24: number };
  liquidity_usd: number;
  /** % change in liquidity since our prior snapshot. Null on first sight of this mint. */
  liquidity_change_pct: number | null;
  /** % change in holder count since prior snapshot. Null when unavailable. */
  holder_growth_pct: number | null;
  /** Top-holder flow over the whale-watch lookback. Null when the leg failed. */
  whale: WhaleFlowInput | null;
}

export interface ExitMetrics {
  /** Share of trades that are sells. 1 - buy pressure. */
  sell_pressure_m5: number | null;
  sell_pressure_h1: number | null;
  sell_pressure_h6: number | null;
  /** buys_m5 vs the per-5-min pace of the last hour. <1 = buying is slowing. */
  buy_rate_decel_m5_h1: number | null;
  /** buys_h1 vs the per-hour pace of the last 6h. The slower-moving confirmation. */
  buy_rate_decel_h1_h6: number | null;
  /** volume_h1 vs the per-hour pace of the last 6h. <1 = interest fading. */
  volume_decel: number | null;
  holder_growth_pct: number | null;
  liquidity_change_pct: number | null;
  /** Whale sell volume ÷ whale buy volume. >1 = top holders are net sellers. */
  whale_sell_buy_ratio: number | null;
  whale_distributing_count: number | null;
  whale_accumulating_count: number | null;
  /** How many independent exit signals fired (flags minus the positive ones). */
  signals_firing: number;
}

export interface ExitAssessment {
  metrics: ExitMetrics;
  /** Composite 0–1. Higher = stronger case for exiting. */
  exit_score: number;
  verdict: ExitVerdict;
  flags: string[];
  reasoning: string;
}

// --- Thresholds (named so the formatter/docs can stay in sync) ---

/** Sell share at or above this means sellers are in control. */
export const SELLERS_IN_CONTROL = 0.55;
/** A decel ratio below this counts as "slowing" — above it is noise. */
export const DECEL_THRESHOLD = 0.8;
/** Liquidity drop at or beyond this is an LP pull — exit, not analysis. */
export const LP_PULL_PCT = -25;
/** Liquidity drop at or beyond this is worth flagging even if not a pull. */
const LP_DECLINE_PCT = -10;
/** 24h gain at or above this with decelerating buys = the move already happened. */
const EXHAUSTION_24H_PCT = 150;
/** Minimum sample size before a pressure or ratio figure is trustworthy. */
const MIN_SAMPLE = 5;
/** Score at or above this → EXIT. */
export const EXIT_SCORE_THRESHOLD = 0.65;
/** Score at or above this → DERISK. */
export const DERISK_SCORE_THRESHOLD = 0.4;

// --- Helpers ---

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function sellPressure(t: WindowTxns): number | null {
  const total = t.buys + t.sells;
  if (total < MIN_SAMPLE) return null;
  return round(t.sells / total, 3);
}

/** Short-window rate ÷ long-window rate. Null when the baseline is too thin. */
function paceRatio(shortCount: number, longCount: number, windowsPerLong: number): number | null {
  if (longCount < MIN_SAMPLE * windowsPerLong) return null;
  const pace = longCount / windowsPerLong;
  if (pace <= 0) return null;
  return round(clamp(shortCount / pace, 0, 20));
}

/** Map a decel ratio to 0–1 exit weight: 1.0 → 0 (steady), 0.4 or less → 1. */
function decelWeight(ratio: number | null): number | null {
  if (ratio == null) return null;
  return clamp((1 - ratio) / 0.6, 0, 1);
}

// --- Core ---

export function computeExitMetrics(input: ExitScoreInput): ExitMetrics {
  const { txns, volume, whale } = input;

  const whale_sell_buy_ratio =
    whale != null && whale.total_buy_volume_usd + whale.total_sell_volume_usd > 0
      ? round(whale.total_sell_volume_usd / Math.max(whale.total_buy_volume_usd, 1))
      : null;

  return {
    sell_pressure_m5: sellPressure(txns.m5),
    sell_pressure_h1: sellPressure(txns.h1),
    sell_pressure_h6: sellPressure(txns.h6),
    buy_rate_decel_m5_h1: paceRatio(txns.m5.buys, txns.h1.buys, 12),
    buy_rate_decel_h1_h6: paceRatio(txns.h1.buys, txns.h6.buys, 6),
    volume_decel: volume.h6 > 0 ? round(clamp(volume.h1 / (volume.h6 / 6), 0, 20)) : null,
    holder_growth_pct: input.holder_growth_pct,
    liquidity_change_pct: input.liquidity_change_pct,
    whale_sell_buy_ratio,
    whale_distributing_count: whale?.distributing_count ?? null,
    whale_accumulating_count: whale?.accumulating_count ?? null,
    signals_firing: 0, // filled in by assessExit once flags exist
  };
}

export function assessExit(input: ExitScoreInput): ExitAssessment {
  const m = computeExitMetrics(input);
  const flags: string[] = [];
  const { whale } = input;

  // --- Components, weighted over whatever we actually have ---

  // Momentum loss: buying and volume slowing down.
  const decelParts = [
    decelWeight(m.buy_rate_decel_m5_h1),
    decelWeight(m.buy_rate_decel_h1_h6),
    decelWeight(m.volume_decel),
  ].filter((v): v is number => v != null);
  const momentumLoss =
    decelParts.length > 0 ? decelParts.reduce((a, b) => a + b, 0) / decelParts.length : null;

  // Sell pressure: 0.45 sell share → 0, 0.70 → 1.
  const pressureComponent =
    m.sell_pressure_h1 != null ? clamp((m.sell_pressure_h1 - 0.45) / 0.25, 0, 1) : null;

  // Whale distribution: sell/buy ratio 0.8 → 0, 3.0 → 1. Only meaningful when
  // whales actually traded in the window.
  const whaleComponent =
    m.whale_sell_buy_ratio != null ? clamp((m.whale_sell_buy_ratio - 0.8) / 2.2, 0, 1) : null;

  // Structural: liquidity leaving and holders leaving.
  const structuralParts: number[] = [];
  if (m.liquidity_change_pct != null && m.liquidity_change_pct < 0) {
    structuralParts.push(clamp(-m.liquidity_change_pct / 25, 0, 1));
  } else if (m.liquidity_change_pct != null) {
    structuralParts.push(0);
  }
  if (m.holder_growth_pct != null) {
    structuralParts.push(m.holder_growth_pct < 0 ? clamp(-m.holder_growth_pct / 10, 0, 1) : 0);
  }
  const structural =
    structuralParts.length > 0
      ? structuralParts.reduce((a, b) => a + b, 0) / structuralParts.length
      : null;

  // Divergence: price still up while sellers dominate = distribution into
  // strength; or a parabolic 24h move with buying already slowing.
  const distributionIntoStrength =
    m.sell_pressure_h1 != null && m.sell_pressure_h1 >= 0.5 && input.price_change.h1 > 5;
  const parabolicExhaustion =
    input.price_change.h24 >= EXHAUSTION_24H_PCT &&
    m.buy_rate_decel_m5_h1 != null &&
    m.buy_rate_decel_m5_h1 < DECEL_THRESHOLD;
  const divergence =
    m.sell_pressure_h1 != null ? (distributionIntoStrength || parabolicExhaustion ? 1 : 0) : null;

  const components: Array<{ value: number | null; weight: number }> = [
    { value: momentumLoss, weight: 0.25 },
    { value: pressureComponent, weight: 0.25 },
    { value: whaleComponent, weight: 0.2 },
    { value: structural, weight: 0.2 },
    { value: divergence, weight: 0.1 },
  ];

  const available = components.filter((c) => c.value != null);
  const totalWeight = available.reduce((s, c) => s + c.weight, 0);
  let score =
    totalWeight > 0 ? available.reduce((s, c) => s + c.value! * c.weight, 0) / totalWeight : 0;

  // --- Flags ---
  if (m.sell_pressure_h1 != null && m.sell_pressure_h1 >= SELLERS_IN_CONTROL) flags.push('sellers_dominating');
  if (m.buy_rate_decel_m5_h1 != null && m.buy_rate_decel_m5_h1 < DECEL_THRESHOLD) flags.push('buying_slowing_5m');
  if (m.buy_rate_decel_h1_h6 != null && m.buy_rate_decel_h1_h6 < DECEL_THRESHOLD) flags.push('buying_slowing_1h');
  if (m.volume_decel != null && m.volume_decel < DECEL_THRESHOLD) flags.push('volume_fading');
  if (distributionIntoStrength) flags.push('distribution_into_strength');
  if (parabolicExhaustion) flags.push('parabolic_exhaustion');
  if (m.holder_growth_pct != null && m.holder_growth_pct <= -2) flags.push('holders_leaving');
  if (m.liquidity_change_pct != null && m.liquidity_change_pct <= LP_DECLINE_PCT && m.liquidity_change_pct > LP_PULL_PCT) {
    flags.push('liquidity_declining');
  }
  if (whale && whale.net_flow_direction === 'distributing') flags.push('whales_distributing');
  if (input.liquidity_usd < 15_000) flags.push('thin_exit_liquidity');

  // Positive flags — a HOLD needs stated reasons too.
  if (m.sell_pressure_h1 != null && m.sell_pressure_h1 <= 0.4) flags.push('buyers_in_control');
  if (whale && whale.net_flow_direction === 'accumulating') flags.push('whales_accumulating');
  if (m.holder_growth_pct != null && m.holder_growth_pct >= 5) flags.push('holders_growing');
  if (m.liquidity_change_pct != null && m.liquidity_change_pct >= 10) flags.push('liquidity_added');

  // --- Hard triggers (override the composite) ---
  const lpPulled = m.liquidity_change_pct != null && m.liquidity_change_pct <= LP_PULL_PCT;
  if (lpPulled) flags.push('lp_pull');

  const dumping =
    m.sell_pressure_h1 != null && m.sell_pressure_h1 >= 0.6 && input.price_change.h1 < -10;
  if (dumping) flags.push('dumping');

  const whaleExodus =
    whale != null &&
    whale.net_flow_direction === 'distributing' &&
    whale.distributing_count >= 3 &&
    m.whale_sell_buy_ratio != null &&
    m.whale_sell_buy_ratio >= 2;
  if (whaleExodus) flags.push('whale_exodus');

  if (lpPulled) score = Math.max(score, 0.9);
  if (dumping) score = Math.max(score, 0.85);
  if (whaleExodus) score = Math.max(score, 0.7);

  const NEGATIVE_FLAGS = new Set([
    'sellers_dominating', 'buying_slowing_5m', 'buying_slowing_1h', 'volume_fading',
    'distribution_into_strength', 'parabolic_exhaustion', 'holders_leaving',
    'liquidity_declining', 'whales_distributing', 'lp_pull', 'dumping', 'whale_exodus',
  ]);
  m.signals_firing = flags.filter((f) => NEGATIVE_FLAGS.has(f)).length;

  // --- Verdict ---
  const noMarketRead =
    m.sell_pressure_h1 == null && m.sell_pressure_h6 == null && momentumLoss == null;
  let verdict: ExitVerdict;
  if (noMarketRead && whale == null) {
    verdict = 'INSUFFICIENT_DATA';
  } else if (lpPulled || dumping || score >= EXIT_SCORE_THRESHOLD) {
    verdict = 'EXIT';
  } else if (score >= DERISK_SCORE_THRESHOLD) {
    verdict = 'DERISK';
  } else {
    verdict = 'HOLD';
  }

  return {
    metrics: m,
    exit_score: round(clamp(score, 0, 1), 3),
    verdict,
    flags,
    reasoning: buildReasoning(verdict, m, flags, input),
  };
}

// --- Narration ---

function buildReasoning(
  verdict: ExitVerdict,
  m: ExitMetrics,
  flags: string[],
  input: ExitScoreInput,
): string {
  if (verdict === 'INSUFFICIENT_DATA') {
    return 'Not enough trade activity to read the market and no whale flow available. No basis for an exit call either way.';
  }

  const bits: string[] = [];
  if (m.sell_pressure_h1 != null) {
    bits.push(`${(m.sell_pressure_h1 * 100).toFixed(0)}% of 1h trades are sells`);
  }
  if (m.buy_rate_decel_m5_h1 != null) {
    bits.push(`5m buy rate at ${m.buy_rate_decel_m5_h1.toFixed(1)}× the hourly pace`);
  }
  if (m.volume_decel != null) {
    bits.push(`volume at ${m.volume_decel.toFixed(1)}× the 6h pace`);
  }
  if (m.whale_sell_buy_ratio != null && (m.whale_distributing_count ?? 0) + (m.whale_accumulating_count ?? 0) > 0) {
    bits.push(
      `top holders: ${m.whale_distributing_count} distributing vs ${m.whale_accumulating_count} accumulating (sell/buy volume ${m.whale_sell_buy_ratio.toFixed(1)}×)`,
    );
  }
  if (m.liquidity_change_pct != null) {
    bits.push(`liquidity ${m.liquidity_change_pct >= 0 ? '+' : ''}${m.liquidity_change_pct.toFixed(1)}% since last look`);
  }
  if (m.holder_growth_pct != null) {
    bits.push(`holders ${m.holder_growth_pct >= 0 ? '+' : ''}${m.holder_growth_pct.toFixed(1)}%`);
  }
  const detail = bits.length > 0 ? bits.join(', ') : 'thin trade sample';

  let lead: string;
  if (flags.includes('lp_pull')) {
    lead = 'Liquidity is being pulled — treat as a rug in progress and exit immediately';
  } else if (flags.includes('dumping')) {
    lead = 'Active dump: sellers control the tape and price is falling';
  } else if (flags.includes('whale_exodus')) {
    lead = 'Top holders are exiting together';
  } else if (verdict === 'EXIT') {
    lead = `${m.signals_firing} exit signals firing at once`;
  } else if (verdict === 'DERISK') {
    lead = flags.includes('distribution_into_strength')
      ? 'Price holds up but the flow underneath is sellers — distribution into strength'
      : 'Momentum is deteriorating but not gone — a partial exit pays for the risk';
  } else {
    lead = 'Momentum intact — no exit case in the current tape';
  }

  const caveats: string[] = [];
  if (flags.includes('thin_exit_liquidity')) {
    caveats.push('liquidity is thin — exiting at size will move the price, derisk in steps');
  }
  if (flags.includes('parabolic_exhaustion')) {
    caveats.push(`up ${input.price_change.h24.toFixed(0)}% in 24h with buying slowing — late-move risk`);
  }

  return `${lead}: ${detail}.${caveats.length > 0 ? ` Caveat: ${caveats.join('; ')}.` : ''}`;
}
