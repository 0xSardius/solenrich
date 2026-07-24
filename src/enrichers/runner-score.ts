/**
 * Runner scoring — PURE functions, no I/O. The math behind `runner-scan`.
 *
 * Detects the on-chain signature of a memecoin run *in progress*: not "is this
 * token up" (that's lagging) but "is buying ACCELERATING" — the second
 * derivative. A token already up 400% with decelerating buys is a distribution
 * risk, not an entry; this module says so out loud.
 *
 * Every ratio is short-window-rate ÷ long-window-rate, so 1.0 = steady state,
 * >1 = accelerating, <1 = decelerating.
 */

// --- Types ---

export type RunnerStage = 'IGNITING' | 'RUNNING' | 'PARABOLIC_LATE' | 'FADING' | 'QUIET';

export interface WindowTxns {
  buys: number;
  sells: number;
}

export interface RunnerScoreInput {
  txns: { m5: WindowTxns; h1: WindowTxns; h6: WindowTxns; h24: WindowTxns };
  volume: { m5: number; h1: number; h6: number; h24: number };
  price_change: { m5: number; h1: number; h6: number; h24: number };
  liquidity_usd: number;
  age_hours: number;
  /** % change in liquidity since our prior snapshot. Null on first sight of this mint. */
  liquidity_change_pct: number | null;
  /** % change in holder count since prior snapshot. Null when unavailable. */
  holder_growth_pct: number | null;
}

export interface RunnerMetrics {
  /** buys_m5 vs the per-5-min pace of the last hour. >1 = buying is speeding up. */
  buy_rate_accel_m5_h1: number | null;
  /** buys_h1 vs the per-hour pace of the last 6h. The slower-moving confirmation. */
  buy_rate_accel_h1_h6: number | null;
  buy_pressure_m5: number | null;
  buy_pressure_h1: number | null;
  buy_pressure_h6: number | null;
  /** volume_h1 vs the per-hour pace of the last 6h. */
  volume_accel: number | null;
  /** priceChange_h1 vs the per-hour pace over 6h, clamped to [0,10]. */
  price_velocity: number | null;
  holder_growth_pct: number | null;
  liquidity_change_pct: number | null;
  /** Mean USD per trade over the last hour — small values on high counts smell like wash trading. */
  avg_trade_usd: number | null;
  /** How many of {5m buy rate, 1h buy rate, volume} are meaningfully accelerating. */
  windows_accelerating: number;
}

export interface RunnerAssessment {
  metrics: RunnerMetrics;
  /** Composite 0–1. Weighted over available components, then penalised by guards. */
  runner_score: number;
  stage: RunnerStage;
  flags: string[];
  reasoning: string;
}

// --- Thresholds (named so the formatter/docs can stay in sync) ---

/** A ratio must clear this to count as "accelerating" — below it is noise. */
export const ACCEL_THRESHOLD = 1.2;
/** Minimum sample size before a ratio or pressure figure is trustworthy. */
const MIN_SAMPLE = 5;
/** Buy pressure at or above this is demand-dominated. */
const STRONG_PRESSURE = 0.6;
/** Below this, sellers are in control. */
const WEAK_PRESSURE = 0.45;
/** Sustained acceleration only reads as a run when buys clearly dominate. */
const RUNNING_PRESSURE = 0.55;
/** Minimum balanced flow for early acceleration to count as igniting. */
const IGNITING_PRESSURE = 0.5;
/** 24h gain at or above this, with decelerating buys, means the move already happened. */
const PARABOLIC_24H_PCT = 150;
/** Liquidity drop at or beyond this is an LP pull — never a runner. */
const LP_PULL_PCT = -25;

// --- Helpers ---

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function round(n: number, dp = 2): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Short-window rate ÷ long-window rate. Null when the baseline is too thin to trust. */
function accelRatio(shortCount: number, longCount: number, windowsPerLong: number): number | null {
  if (longCount < MIN_SAMPLE * windowsPerLong) return null;
  const pace = longCount / windowsPerLong;
  if (pace <= 0) return null;
  return round(clamp(shortCount / pace, 0, 20));
}

function buyPressure(t: WindowTxns): number | null {
  const total = t.buys + t.sells;
  if (total < MIN_SAMPLE) return null;
  return round(t.buys / total, 3);
}

/** Normalise a ratio to 0–1: `at` maps to 0, `at + span` maps to 1. */
function ramp(value: number | null, at: number, span: number): number | null {
  if (value == null) return null;
  return clamp((value - at) / span, 0, 1);
}

// --- Core ---

export function computeRunnerMetrics(input: RunnerScoreInput): RunnerMetrics {
  const { txns, volume, price_change } = input;

  const buy_rate_accel_m5_h1 = accelRatio(txns.m5.buys, txns.h1.buys, 12);
  const buy_rate_accel_h1_h6 = accelRatio(txns.h1.buys, txns.h6.buys, 6);

  const volume_accel =
    volume.h6 > 0 ? round(clamp(volume.h1 / (volume.h6 / 6), 0, 20)) : null;

  // Price velocity: only "rising faster than it was" counts. A token falling now
  // has zero upward velocity regardless of what it did earlier; a token rising
  // now off a flat/down 6h is a reversal, which we credit at a fixed 2.0 rather
  // than dividing by ~zero.
  let price_velocity: number | null;
  const h6Pace = price_change.h6 / 6;
  if (price_change.h1 <= 0) price_velocity = 0;
  else if (h6Pace > 0.1) price_velocity = round(clamp(price_change.h1 / h6Pace, 0, 10));
  else price_velocity = 2;

  const txnsH1 = txns.h1.buys + txns.h1.sells;
  const avg_trade_usd = txnsH1 > 0 && volume.h1 > 0 ? round(volume.h1 / txnsH1) : null;

  const windows_accelerating = [buy_rate_accel_m5_h1, buy_rate_accel_h1_h6, volume_accel].filter(
    (r): r is number => r != null && r > ACCEL_THRESHOLD,
  ).length;

  return {
    buy_rate_accel_m5_h1,
    buy_rate_accel_h1_h6,
    buy_pressure_m5: buyPressure(txns.m5),
    buy_pressure_h1: buyPressure(txns.h1),
    buy_pressure_h6: buyPressure(txns.h6),
    volume_accel,
    price_velocity,
    holder_growth_pct: input.holder_growth_pct,
    liquidity_change_pct: input.liquidity_change_pct,
    avg_trade_usd,
    windows_accelerating,
  };
}

export function assessRunner(input: RunnerScoreInput): RunnerAssessment {
  const m = computeRunnerMetrics(input);
  const flags: string[] = [];

  // --- Weighted composite over whatever components we actually have ---
  const accelParts = [
    ramp(m.buy_rate_accel_m5_h1, 1, 1.5),
    ramp(m.buy_rate_accel_h1_h6, 1, 1.5),
  ].filter((v): v is number => v != null);
  const accelComponent =
    accelParts.length > 0 ? accelParts.reduce((a, b) => a + b, 0) / accelParts.length : null;

  const components: Array<{ value: number | null; weight: number }> = [
    { value: accelComponent, weight: 0.3 },
    { value: ramp(m.buy_pressure_h1, 0.5, 0.25), weight: 0.25 },
    { value: ramp(m.volume_accel, 1, 1.5), weight: 0.2 },
    { value: ramp(m.price_velocity, 1, 2), weight: 0.15 },
    { value: m.holder_growth_pct != null ? clamp(m.holder_growth_pct / 20, 0, 1) : null, weight: 0.1 },
  ];

  const available = components.filter((c) => c.value != null);
  const totalWeight = available.reduce((s, c) => s + c.weight, 0);
  let score =
    totalWeight > 0
      ? available.reduce((s, c) => s + c.value! * c.weight, 0) / totalWeight
      : 0;

  // --- Flags ---
  if (m.buy_rate_accel_m5_h1 != null && m.buy_rate_accel_m5_h1 > ACCEL_THRESHOLD) flags.push('accelerating_5m');
  if (m.buy_rate_accel_h1_h6 != null && m.buy_rate_accel_h1_h6 > ACCEL_THRESHOLD) flags.push('accelerating_1h');
  if (m.volume_accel != null && m.volume_accel > 1.5) flags.push('volume_surge');
  if (m.buy_pressure_h1 != null && m.buy_pressure_h1 >= STRONG_PRESSURE) flags.push('strong_buy_pressure');
  const sellsDominating = m.buy_pressure_h1 != null && m.buy_pressure_h1 < WEAK_PRESSURE;
  if (sellsDominating) flags.push('sells_dominating');
  if (m.price_velocity != null && m.price_velocity > 1.5) flags.push('price_accelerating');
  if (input.price_change.h1 > 0 && input.price_change.h6 <= 0) flags.push('price_reversal');
  // Surface a big 24h run even when buying is still accelerating (so the stage
  // is not LATE). A buyer arriving at +900% is taking a very different trade
  // from one arriving at +30%, and should be told so either way.
  if (input.price_change.h24 >= PARABOLIC_24H_PCT) flags.push('up_big_24h');
  if (m.holder_growth_pct != null && m.holder_growth_pct >= 5) flags.push('holder_growth_strong');
  if (m.holder_growth_pct != null && m.holder_growth_pct <= -2) flags.push('holders_shrinking');
  if (m.liquidity_change_pct != null && m.liquidity_change_pct >= 10) flags.push('liquidity_added');
  if (input.age_hours < 1) flags.push('thin_history');
  if (input.liquidity_usd < 15_000) flags.push('low_liquidity');

  // Wash-trading smell: lots of transactions, trivial size each. On-chain counts
  // are cheap to fake; this is the cross-check the scope demands.
  const txnsH1 = input.txns.h1.buys + input.txns.h1.sells;
  const washSuspect = m.avg_trade_usd != null && m.avg_trade_usd < 25 && txnsH1 > 300;
  if (washSuspect) flags.push('wash_trade_risk');

  // --- Hard guards (these override the upside signal) ---
  const lpPulled = m.liquidity_change_pct != null && m.liquidity_change_pct <= LP_PULL_PCT;
  if (lpPulled) flags.push('liquidity_pulled');

  const dumping =
    m.buy_pressure_h1 != null && m.buy_pressure_h1 < WEAK_PRESSURE && input.price_change.h1 < -10;
  if (dumping) flags.push('dumping');

  const decelerating = m.buy_rate_accel_m5_h1 != null && m.buy_rate_accel_m5_h1 < 0.8;
  const alreadyRan = input.price_change.h24 >= PARABOLIC_24H_PCT && decelerating;
  if (alreadyRan) flags.push('already_ran');

  if (lpPulled) score *= 0.2;
  if (dumping) score *= 0.3;
  // Acceleration while sellers dominate is distribution, not accumulation — the
  // volume is real but it is people getting out. Without this, a token churning
  // at 43% buys outranks one accumulating at 85%, because raw acceleration
  // carries more weight than pressure alone.
  if (sellsDominating) score *= 0.4;
  if (alreadyRan) score *= 0.6;
  if (washSuspect) score *= 0.75;

  // --- Stage ---
  const pressure = m.buy_pressure_h1 ?? 0;
  let stage: RunnerStage;
  if (lpPulled || dumping) {
    stage = 'FADING';
  } else if (alreadyRan) {
    stage = 'PARABOLIC_LATE';
  } else if (m.windows_accelerating >= 2 && pressure >= RUNNING_PRESSURE) {
    stage = 'RUNNING';
  } else if (m.windows_accelerating >= 1 && pressure >= IGNITING_PRESSURE) {
    stage = 'IGNITING';
  } else {
    stage = 'QUIET';
  }

  return {
    metrics: m,
    runner_score: round(clamp(score, 0, 1), 3),
    stage,
    flags,
    reasoning: buildReasoning(stage, m, flags, input),
  };
}

// --- Narration ---

function buildReasoning(
  stage: RunnerStage,
  m: RunnerMetrics,
  flags: string[],
  input: RunnerScoreInput,
): string {
  const bits: string[] = [];

  if (m.buy_rate_accel_m5_h1 != null) {
    bits.push(
      `5m buy rate ${m.buy_rate_accel_m5_h1.toFixed(1)}× the hourly pace`,
    );
  }
  if (m.buy_rate_accel_h1_h6 != null) {
    bits.push(`1h buy rate ${m.buy_rate_accel_h1_h6.toFixed(1)}× the 6h pace`);
  }
  if (m.buy_pressure_h1 != null) {
    bits.push(`${(m.buy_pressure_h1 * 100).toFixed(0)}% of 1h trades are buys`);
  }
  if (m.volume_accel != null) {
    bits.push(`volume ${m.volume_accel.toFixed(1)}× the 6h pace`);
  }
  if (m.holder_growth_pct != null) {
    bits.push(`holders ${m.holder_growth_pct >= 0 ? '+' : ''}${m.holder_growth_pct.toFixed(1)}% since last scan`);
  }

  const detail = bits.length > 0 ? bits.join(', ') : 'insufficient transaction sample to measure velocity';

  const lead: Record<RunnerStage, string> = {
    RUNNING: `Sustained acceleration across ${m.windows_accelerating} windows`,
    IGNITING: 'Early acceleration on a single window — unconfirmed',
    PARABOLIC_LATE: `Already up ${input.price_change.h24.toFixed(0)}% in 24h with buying decelerating — entry risk high, this is distribution territory`,
    FADING: flags.includes('liquidity_pulled')
      ? 'Liquidity being pulled — treat as a rug/exit in progress, not a runner'
      : 'Sellers in control and price falling',
    QUIET: 'No meaningful acceleration',
  };

  const caveats: string[] = [];
  if (flags.includes('up_big_24h') && stage !== 'PARABOLIC_LATE') {
    caveats.push(
      `already up ${input.price_change.h24.toFixed(0)}% over 24h, so this is early to the current leg, not to the move`,
    );
  }
  if (flags.includes('wash_trade_risk')) caveats.push('transaction counts look wash-traded (tiny average trade size)');
  if (flags.includes('thin_history')) caveats.push('under an hour old, so every ratio is a small sample');
  if (flags.includes('low_liquidity')) caveats.push('liquidity is thin — exiting at size may not be possible');

  return `${lead[stage]}: ${detail}.${caveats.length > 0 ? ` Caveat: ${caveats.join('; ')}.` : ''}`;
}
