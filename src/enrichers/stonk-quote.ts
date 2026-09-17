import type { Cache } from '../cache';
import { CACHE_TTL } from '../config';
import type { StonkRewardRiskAnalyzer, RewardRiskResult } from './stonk-reward-risk';
import type { StonkYieldAnalyzer, StonkYieldResult, YieldWindow } from './stonk-yield';
import type { TokenAnalyzer, TokenEnrichment } from './token-analyzer';
import type { PayoutStatus } from './stonk-gems';

// `stonk-quote` — the cost of one StonkFun trade at one size, and what the
// position is expected to pay back while you hold it. No swap. Composes three
// analyzers that already exist (reward-risk, yield, token) into the number a
// trading agent sizes with:
//
//   entry cost  = transfer tax on the buy + price impact at size
//   exit cost   = transfer tax on the sell + price impact at size
//   round trip  = both; breakeven move = what price must do to cover it
//   expected payout over the hold = holder yield per week × size × weeks
//   net         = expected payout − round trip → PAYS / MARGINAL / COSTS
//
// The yield window is picked from what the snapshot series actually covers,
// never annualized from a two-day sample. Every estimate names its basis.

export type QuoteVerdict = 'PAYS' | 'MARGINAL' | 'COSTS' | 'NOT_PAYING' | 'UNKNOWN';

export interface CostLeg {
  tax_pct: number;
  tax_usd: number;
  price_impact_pct: number | null;
  price_impact_usd: number | null;
  /** Tax + impact, in % of size and USD. Impact null → tax only, flagged in caveats. */
  total_pct: number;
  total_usd: number;
}

export interface StonkQuoteResult {
  mint: string;
  symbol: string | null;
  name: string | null;
  quote: { mint: string | null; symbol: string | null; category: string | null };
  size_usd: number;
  hold_days: number;
  payout_status: PayoutStatus;
  price_usd: number | null;
  tokens_at_size: number | null;
  entry: CostLeg;
  exit: CostLeg;
  round_trip: { cost_pct: number; cost_usd: number; breakeven_move_pct: number };
  eligibility: {
    /** Your share of every payout = size / market cap. */
    share_of_supply_pct: number | null;
    /** Estimated payout to this position per distribution batch, in USD. */
    est_usd_per_payout: number | null;
    dust_risk: boolean;
    note: string;
  };
  expected_payout: {
    basis: '7d' | '30d' | 'lifetime' | null;
    basis_actual_days: number | null;
    yield_pct_per_week: number | null;
    usd_per_week: number | null;
    usd_over_hold: number | null;
    reward_asset: string | null;
    caution: boolean;
    caution_reason: string | null;
  };
  net: {
    usd_over_hold: number | null;
    pct_of_size: number | null;
    /** Days of holding at the observed payout rate to cover the round trip. */
    breakeven_hold_days: number | null;
    verdict: QuoteVerdict;
  };
  market: { market_cap_usd: number | null; volume_24h_usd: number | null; liquidity_usd: number | null; holders: number | null };
  reasoning: string;
  warnings: string[];
  caveats: string[];
  next_steps: string[];
  last_updated: string;
}

/** Log-interpolate price impact at `size` from the fixed-size estimates ($100/$1K/$10K/$100K). */
export function impactAtSize(estimates: Array<{ size_usd: number; price_impact_pct: number }> | undefined, size: number): number | null {
  const pts = (estimates ?? []).filter((e) => e.size_usd > 0 && Number.isFinite(e.price_impact_pct)).sort((a, b) => a.size_usd - b.size_usd);
  if (!pts.length) return null;
  const abs = (p: { price_impact_pct: number }) => Math.abs(p.price_impact_pct);
  if (size <= pts[0].size_usd) return round2(abs(pts[0]) * (size / pts[0].size_usd));
  if (size >= pts[pts.length - 1].size_usd) return round2(abs(pts[pts.length - 1]));
  for (let i = 1; i < pts.length; i++) {
    if (size <= pts[i].size_usd) {
      const a = pts[i - 1], b = pts[i];
      const t = (Math.log(size) - Math.log(a.size_usd)) / (Math.log(b.size_usd) - Math.log(a.size_usd));
      return round2(abs(a) + (abs(b) - abs(a)) * t);
    }
  }
  return round2(abs(pts[pts.length - 1]));
}

/** Pick the yield window with enough real history, preferring the shortest that is complete. */
export function pickYieldBasis(y: Pick<StonkYieldResult, 'trailing_7d' | 'trailing_30d' | 'lifetime'>): { basis: StonkQuoteResult['expected_payout']['basis']; window: YieldWindow | null } {
  const ok = (w: YieldWindow, minDays: number) => w.yield_pct != null && w.actual_days != null && w.actual_days >= minDays;
  if (ok(y.trailing_7d, 6.5)) return { basis: '7d', window: y.trailing_7d };
  if (ok(y.trailing_30d, 6.5)) return { basis: '30d', window: y.trailing_30d };
  if (ok(y.lifetime, 1)) return { basis: 'lifetime', window: y.lifetime };
  return { basis: null, window: null };
}

export interface QuoteInputs {
  mint: string;
  sizeUsd: number;
  holdDays: number;
  risk: Omit<RewardRiskResult, 'llm_brief'> | RewardRiskResult;
  yld: StonkYieldResult | null;
  token: TokenEnrichment | null;
  now: number;
}

/** Pure: the whole quote from the three analyzer results. Exported for tests. */
export function buildStonkQuote(i: QuoteInputs): StonkQuoteResult {
  const warnings: string[] = [];
  const caveats: string[] = [];
  const { risk, yld, token } = i;

  const bps = risk.trading_cost.bps ?? token?.transfer_tax?.bps ?? 0;
  const taxPct = round2(bps / 100);
  const price = token?.price_usd && token.price_usd > 0 ? token.price_usd : risk.market.price_usd ?? null;
  const mcap = token?.market_cap && token.market_cap > 0 ? token.market_cap : risk.market.market_cap_usd ?? null;

  const impact = impactAtSize(token?.slippage_estimates, i.sizeUsd);
  if (impact == null) caveats.push('No slippage estimate available at this size — entry and exit costs are tax only; real cost is higher.');
  else caveats.push('Exit price impact is assumed equal to entry impact at the same size; a thinner book at exit time costs more.');

  const leg = (): CostLeg => {
    const taxUsd = round2(i.sizeUsd * (taxPct / 100));
    const impUsd = impact != null ? round2(i.sizeUsd * (impact / 100)) : null;
    const totalPct = round2(taxPct + (impact ?? 0));
    return { tax_pct: taxPct, tax_usd: taxUsd, price_impact_pct: impact, price_impact_usd: impUsd, total_pct: totalPct, total_usd: round2(taxUsd + (impUsd ?? 0)) };
  };
  const entry = leg();
  const exit = leg();
  const rtPct = round2(entry.total_pct + exit.total_pct);
  const rtUsd = round2(entry.total_usd + exit.total_usd);
  // Price must rise enough that (1 + m)(1 − exit) ≥ 1 + entry, i.e. m ≈ entry + exit + entry·exit.
  const e = entry.total_pct / 100, x = exit.total_pct / 100;
  const breakeven = round2(((1 + e) / (1 - x) - 1) * 100);

  // --- eligibility: pro-rata share of every payout --------------------------
  const share = mcap && mcap > 0 ? (i.sizeUsd / mcap) * 100 : null;
  let estPerPayout: number | null = null;
  if (yld && share != null) {
    const lt = yld.lifetime;
    if (lt.rewards_usd != null && yld.payout_count && yld.payout_count > 0) {
      estPerPayout = round6((lt.rewards_usd / yld.payout_count) * (share / 100));
    }
  }
  // Dust = the per-payout share is under 100 base units of the quote token, i.e.
  // it rounds toward nothing at the token's decimals. Payouts on busy coins land
  // every minute, so a tiny per-payout figure is normal; only sub-unit is dust.
  const quoteUsd = yld?.reward_asset.usd_price ?? null;
  const quoteDecimals = yld?.reward_asset.decimals ?? null;
  const dust = estPerPayout != null && quoteUsd != null && quoteUsd > 0 && quoteDecimals != null
    ? estPerPayout < (quoteUsd / 10 ** quoteDecimals) * 100
    : false;
  const eligibility: StonkQuoteResult['eligibility'] = {
    share_of_supply_pct: share != null ? round4(share) : null,
    est_usd_per_payout: estPerPayout,
    dust_risk: dust,
    note: 'StonkFun publishes no minimum holding; payouts are pro-rata by balance. Share = size ÷ market cap. Amounts too small for the quote token\'s decimals are not delivered.',
  };
  if (dust) warnings.push(`At $${i.sizeUsd} your share of a typical payout is under 100 base units of ${yld?.reward_asset.symbol ?? 'the quote asset'} — it can round to nothing.`);

  // --- expected payout over the hold ----------------------------------------
  const picked = yld ? pickYieldBasis(yld) : { basis: null, window: null };
  let weeklyPct: number | null = null;
  if (picked.window && picked.window.yield_pct != null && picked.window.actual_days) {
    weeklyPct = round4((picked.window.yield_pct / picked.window.actual_days) * 7);
  }
  const usdPerWeek = weeklyPct != null ? round2(i.sizeUsd * (weeklyPct / 100)) : null;
  const usdOverHold = usdPerWeek != null ? round2(usdPerWeek * (i.holdDays / 7)) : null;
  const expected: StonkQuoteResult['expected_payout'] = {
    basis: picked.basis,
    basis_actual_days: picked.window?.actual_days ?? null,
    yield_pct_per_week: weeklyPct,
    usd_per_week: usdPerWeek,
    usd_over_hold: usdOverHold,
    reward_asset: yld?.reward_asset.symbol ?? risk.rewards.reward_asset ?? null,
    caution: picked.window?.caution ?? true,
    caution_reason: picked.window?.caution_reason ?? (picked.basis ? null : 'no yield window with enough history'),
  };
  if (picked.basis === 'lifetime') caveats.push('Expected payout is scaled from lifetime yield because the 7d/30d snapshot windows are not complete yet.');
  if (!picked.basis) caveats.push('No payout history to project from — expected payout is unknown, not zero.');

  // --- net + verdict ---------------------------------------------------------
  let verdict: QuoteVerdict;
  let netUsd: number | null = null;
  let netPct: number | null = null;
  let breakevenDays: number | null = null;
  if (risk.payout_status === 'NOT_REWARD' || risk.payout_status === 'NEVER') {
    verdict = 'NOT_PAYING';
    warnings.push(risk.payout_status === 'NEVER' ? 'This coin has never paid holders — the tax is a pure cost today.' : 'Nothing on this mint pays holders — the round trip is a pure cost.');
  } else if (usdOverHold == null) {
    verdict = 'UNKNOWN';
  } else {
    netUsd = round2(usdOverHold - rtUsd);
    netPct = round2((netUsd / i.sizeUsd) * 100);
    breakevenDays = usdPerWeek && usdPerWeek > 0 ? round2((rtUsd / usdPerWeek) * 7) : null;
    verdict = usdOverHold >= rtUsd * 1.5 ? 'PAYS' : usdOverHold >= rtUsd ? 'MARGINAL' : 'COSTS';
    if (risk.payout_status === 'STALE') warnings.push(`Payouts are STALE (last ${risk.rewards.hours_since_last_payout != null ? `${(risk.rewards.hours_since_last_payout / 24).toFixed(1)}d` : 'a while'} ago) — the projection assumes they resume.`);
  }
  if (bps === 0) caveats.push('No transfer tax on this mint: entry and exit cost is price impact only.');

  const sym = risk.symbol ? `$${risk.symbol}` : i.mint.slice(0, 6);
  const reasoning =
    verdict === 'PAYS' ? `${sym} at $${i.sizeUsd}: round trip costs ${rtPct}% ($${rtUsd}); at the observed ${expected.basis} payout rate the position earns ≈$${usdOverHold} in ${expected.reward_asset ?? 'the quote asset'} over ${i.holdDays} days, covering the trip in ≈${breakevenDays} days.`
    : verdict === 'MARGINAL' ? `${sym} at $${i.sizeUsd}: expected payout over ${i.holdDays} days (≈$${usdOverHold}) barely covers the ${rtPct}% round trip ($${rtUsd}). Needs price to do the work or a longer hold (≈${breakevenDays} days to break even on payouts alone).`
    : verdict === 'COSTS' ? `${sym} at $${i.sizeUsd}: the ${rtPct}% round trip ($${rtUsd}) is more than the ≈$${usdOverHold} the position is expected to be paid over ${i.holdDays} days. Payouts alone do not justify the trade; price must move ${breakeven}% just to break even.`
    : verdict === 'NOT_PAYING' ? `${sym} does not pay holders right now. Every trade pays ${rtPct}% round trip for nothing but price exposure.`
    : `${sym}: round trip costs ${rtPct}% ($${rtUsd}) at $${i.sizeUsd}; there is no payout history yet to say what the hold earns.`;

  return {
    mint: i.mint,
    symbol: risk.symbol,
    name: risk.name,
    quote: { mint: risk.quote.mint, symbol: risk.quote.symbol, category: risk.quote.category },
    size_usd: i.sizeUsd,
    hold_days: i.holdDays,
    payout_status: risk.payout_status,
    price_usd: price,
    tokens_at_size: price && price > 0 ? round4((i.sizeUsd * (1 - entry.total_pct / 100)) / price) : null,
    entry,
    exit,
    round_trip: { cost_pct: rtPct, cost_usd: rtUsd, breakeven_move_pct: breakeven },
    eligibility,
    expected_payout: expected,
    net: { usd_over_hold: netUsd, pct_of_size: netPct, breakeven_hold_days: breakevenDays, verdict },
    market: {
      market_cap_usd: mcap,
      volume_24h_usd: token?.volume_24h ?? risk.market.volume_24h_usd ?? null,
      liquidity_usd: token?.liquidity ?? null,
      holders: risk.holders.count ?? yld?.holder_count ?? null,
    },
    reasoning,
    warnings,
    caveats: [
      ...caveats,
      'A cost and payout estimate at one size, not a price forecast. Payout rates change with volume; the tax does not. Not financial advice.',
    ],
    next_steps: [
      'trenches-check on the mint for velocity + smart-money + attention before entering.',
      'exit-signal with entry_price_usd while holding — reports PnL net of the sell-side tax.',
      'stonk-yield for the full window math behind expected_payout.',
    ],
    last_updated: new Date(i.now).toISOString(),
  };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round4(n: number): number { return Math.round(n * 10000) / 10000; }
function round6(n: number): number { return Math.round(n * 1e6) / 1e6; }

export class StonkQuoteAnalyzer {
  constructor(
    private readonly rewardRisk: StonkRewardRiskAnalyzer,
    private readonly yieldAnalyzer: StonkYieldAnalyzer,
    private readonly tokenAnalyzer: TokenAnalyzer,
    private readonly cache: Cache,
  ) {}

  async quote(mint: string, sizeUsd: number, holdDays: number): Promise<StonkQuoteResult> {
    const cacheKey = `stonk:quote:${mint}:${sizeUsd}:${holdDays}`;
    const cached = await this.cache.get<StonkQuoteResult>(cacheKey);
    if (cached) return cached;

    const [riskRes, yieldRes, tokenRes] = await Promise.allSettled([
      this.rewardRisk.analyze(mint),
      this.yieldAnalyzer.analyze(mint),
      this.tokenAnalyzer.enrich(mint, false),
    ]);
    if (riskRes.status === 'rejected') throw new Error(`reward-risk leg failed: ${riskRes.reason instanceof Error ? riskRes.reason.message : String(riskRes.reason)}`);

    const result = buildStonkQuote({
      mint,
      sizeUsd,
      holdDays,
      risk: riskRes.value,
      yld: yieldRes.status === 'fulfilled' ? yieldRes.value : null,
      token: tokenRes.status === 'fulfilled' ? tokenRes.value : null,
      now: Date.now(),
    });
    if (yieldRes.status === 'rejected') result.caveats.unshift('Yield leg FAILED this call — expected payout is unknown.');
    if (tokenRes.status === 'rejected') result.caveats.unshift('Token leg FAILED this call — no slippage estimate; costs are tax only.');

    await this.cache.set(cacheKey, result, CACHE_TTL.stonkQuote);
    return result;
  }
}
