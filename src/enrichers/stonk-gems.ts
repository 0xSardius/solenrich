import type { StonkIndexRow, StonkCategory } from './stonk-index';

// Pure scoring over StonkFun index rows. Two products share this file:
//
//  - stonk-gems: "which reward coins look early, real, and paying?" A gem is
//    young, already paying holders, small enough to still move, with real
//    turnover and a quote asset that attracts traders. No I/O — the index
//    rows already hold everything the score needs.
//  - stonk-launch-intel: "what should I launch, and against what?" Per-quote
//    aggregates: launches, share still trading, share paying, survival past
//    day three, median holders, tax mix. Computed from the same rows.
//
// Measured 2026-09-06 over 8,000 reward coins (the numbers the thresholds
// come from): 45.5% traded in the last 24h, 12.7% paid a reward in the last
// 24h, median holders 2, 557 coins over $10K volume, 119 with 500+ holders.
// Of coins older than 3 days, 13.6% still traded. 300 bps coins pay more
// often (17.8%) than 100 bps coins (7.6%). Quote choice dominates: ZEC-paired
// coins traded 87% of the time vs 25% for the most-launched xStock quote.

export const H24_MS = 86_400_000;

export type GemStage = 'GEM' | 'WATCH' | 'NOISE' | 'DEAD';

export interface GemAssessment {
  score: number;
  stage: GemStage;
  reasons: string[];
  warnings: string[];
}

/** Per-quote context the gem score uses (from quoteStats). */
export interface QuoteContext {
  /** Share (0–1) of this quote's coins that traded in the last 24h. */
  tradedShare24h: number;
  coins: number;
}

export function hoursSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.round(((now - t) / 3_600_000) * 10) / 10;
}

/** Payout status: the thing a holder observes. */
export type PayoutStatus = 'PAYING' | 'STALE' | 'NEVER' | 'NOT_REWARD';

export function payoutStatus(row: Pick<StonkIndexRow, 'mode' | 'payoutCount' | 'lastPayoutAt'>, now: number): PayoutStatus {
  if (row.mode !== 'reward') return 'NOT_REWARD';
  if (row.payoutCount <= 0) return 'NEVER';
  const h = hoursSince(row.lastPayoutAt, now);
  return h != null && h <= 24 ? 'PAYING' : 'STALE';
}

/**
 * Score one reward coin for gem-ness. Heuristic, deterministic, documented.
 * Exported for tests; thresholds are constants so they can be tuned from the
 * outcome tape later.
 */
export function scoreGem(row: StonkIndexRow, now: number, quote: QuoteContext | null): GemAssessment {
  const reasons: string[] = [];
  const warnings: string[] = [];
  let score = 0;

  const ageDays = (now - Date.parse(row.createdAt)) / H24_MS;
  const hSincePayout = hoursSince(row.lastPayoutAt, now);
  const mcap = row.marketCapUsd;
  const vol = row.volume24hUsd;
  const turnover = mcap > 0 ? vol / mcap : 0;

  // Dead coins are not gems, whatever else they look like.
  if (vol <= 0) {
    return { score: 0, stage: 'DEAD', reasons: [], warnings: ['no volume in the last 24h'] };
  }

  // --- paying (max 25): the flywheel is real, not promised ----------------
  if (hSincePayout != null && hSincePayout <= 2) { score += 25; reasons.push(`paid holders ${hSincePayout}h ago`); }
  else if (hSincePayout != null && hSincePayout <= 6) { score += 22; reasons.push(`paid holders ${hSincePayout}h ago`); }
  else if (hSincePayout != null && hSincePayout <= 24) { score += 15; reasons.push(`paid holders ${hSincePayout}h ago`); }
  else if (row.payoutCount > 0) { score += 3; warnings.push(`last payout ${hSincePayout != null ? `${(hSincePayout / 24).toFixed(1)}d` : 'a while'} ago`); }
  else warnings.push('has never paid holders');

  // --- holders (max 12): discovered by some, not by everyone ---------------
  const h = row.holderCount;
  if (h >= 1000) { score += 8; reasons.push(`${h} holders — already discovered`); }
  else if (h >= 200) { score += 12; reasons.push(`${h} holders`); }
  else if (h >= 50) { score += 9; reasons.push(`${h} holders`); }
  else if (h >= 20) { score += 4; }
  else warnings.push(`only ${h} reward-receiving holders`);

  // --- size (max 15): room to move --------------------------------------
  if (mcap > 0 && mcap < 100_000) { score += 15; reasons.push(`mcap ${fmtUsd(mcap)} — early`); }
  else if (mcap < 1_000_000) { score += 12; reasons.push(`mcap ${fmtUsd(mcap)}`); }
  else if (mcap < 10_000_000) { score += 6; }
  else warnings.push(`mcap ${fmtUsd(mcap)} — the easy multiple is gone`);

  // --- turnover (max 15): volume relative to size -------------------------
  if (turnover >= 0.5) { score += 15; reasons.push(`24h turnover ${(turnover * 100).toFixed(0)}% of mcap`); }
  else if (turnover >= 0.2) { score += 10; reasons.push(`24h turnover ${(turnover * 100).toFixed(0)}% of mcap`); }
  else if (turnover >= 0.05) { score += 5; }
  else warnings.push(`thin turnover (${(turnover * 100).toFixed(1)}% of mcap in 24h)`);

  // --- age (max 10): young but past the first hours ---------------------
  if (ageDays < 0.25) { score += 3; warnings.push('under 6h old — most launches die in the first day'); }
  else if (ageDays < 1) { score += 6; }
  else if (ageDays <= 7) { score += 10; reasons.push(`${ageDays.toFixed(1)}d old`); }
  else if (ageDays <= 30) { score += 5; }

  // --- momentum (max 10, can go negative): moving, not already parabolic ---
  const chg = row.priceChange24h;
  if (chg != null) {
    if (chg >= 0 && chg <= 100) { score += 10; }
    else if (chg > 100 && chg <= 200) { score += 3; warnings.push(`+${chg.toFixed(0)}% in 24h — late to the first leg`); }
    else if (chg > 200 && chg <= 400) { score -= 5; warnings.push(`+${chg.toFixed(0)}% in 24h — the first leg is done`); }
    else if (chg > 400) { score -= 10; warnings.push(`+${chg.toFixed(0)}% in 24h — already ran`); }
    else if (chg < -30) { score -= 10; warnings.push(`${chg.toFixed(0)}% in 24h — falling`); }
    else score += 4;
  }

  // --- quote strength (max 10): does this quote attract traders? ---------
  if (quote) {
    if (quote.tradedShare24h >= 0.5) { score += 10; reasons.push(`${row.quoteSymbol} quote: ${(quote.tradedShare24h * 100).toFixed(0)}% of its coins traded today`); }
    else if (quote.tradedShare24h >= 0.25) { score += 5; }
    else warnings.push(`${row.quoteSymbol} quote: only ${(quote.tradedShare24h * 100).toFixed(0)}% of its ${quote.coins} coins traded today`);
  }

  // --- flywheel (3) -------------------------------------------------------
  if (row.flywheelActive) { score += 3; reasons.push('flywheel active'); }

  // Max = 25 + 12 + 15 + 15 + 10 + 10 + 10 + 3 = 100. Stages set so GEM is the
  // top slice of live candidates, not most of them (263/331 hit 100 on the
  // first cut with looser weights).
  score = Math.max(0, Math.min(100, Math.round(score)));
  const stage: GemStage = score >= 80 ? 'GEM' : score >= 62 ? 'WATCH' : 'NOISE';
  return { score, stage, reasons, warnings };
}

// --- Launch intel: per-quote aggregates ----------------------------------------

export interface QuoteStats {
  quote_mint: string;
  quote_symbol: string;
  quote_category: StonkCategory;
  coins: number;
  launches_24h: number;
  launches_7d: number;
  traded_24h: number;
  traded_share_24h: number;
  paying_24h: number;
  paying_share_24h: number;
  /** Coins older than 3 days that still traded in the last 24h, as a share of coins older than 3 days. */
  survival_3d: number | null;
  older_than_3d: number;
  live_24h: number;
  volume_24h_usd: number;
  holders_total: number;
  holders_median: number;
  market_cap_median_usd: number;
  tax_mix: { bps_100: number; bps_300: number; other: number };
  paying_by_tax: { bps_100: number | null; bps_300: number | null };
  traded_by_tax: { bps_100: number | null; bps_300: number | null };
  /** Launches in 7d per coin traded today — high = crowded shelf. */
  crowding: number | null;
  /** True when no coin on this quote is older than 3 days — survival is unknown, demand is capped at 80. */
  is_new: boolean;
  /** 0–100: traders per launch. Survival and traded-share up, crowding down. */
  demand_score: number;
}

export function quoteStats(rows: Iterable<StonkIndexRow>, now: number): QuoteStats[] {
  const by = new Map<string, StonkIndexRow[]>();
  for (const r of rows) {
    if (!r.quoteMint) continue;
    const arr = by.get(r.quoteMint) ?? [];
    arr.push(r);
    by.set(r.quoteMint, arr);
  }
  const out: QuoteStats[] = [];
  for (const [quoteMint, coins] of by) {
    const n = coins.length;
    let launches24 = 0, launches7 = 0, traded = 0, paying = 0, live = 0, older3 = 0, older3Traded = 0, vol = 0, holders = 0;
    let t100 = 0, t300 = 0, tOther = 0, p100 = 0, p300 = 0, tr100 = 0, tr300 = 0;
    const hs: number[] = []; const mc: number[] = [];
    for (const c of coins) {
      const age = now - Date.parse(c.createdAt);
      const isTraded = c.volume24hUsd > 0;
      const hp = hoursSince(c.lastPayoutAt, now);
      const isPaying = hp != null && hp <= 24;
      if (age <= H24_MS) launches24++;
      if (age <= 7 * H24_MS) launches7++;
      if (isTraded) traded++;
      if (isPaying) paying++;
      if (isTraded && isPaying) live++;
      if (age > 3 * H24_MS) { older3++; if (isTraded) older3Traded++; }
      vol += c.volume24hUsd; holders += c.holderCount;
      hs.push(c.holderCount); mc.push(c.marketCapUsd);
      if (c.bps === 100) { t100++; if (isPaying) p100++; if (isTraded) tr100++; }
      else if (c.bps === 300) { t300++; if (isPaying) p300++; if (isTraded) tr300++; }
      else tOther++;
    }
    const tradedShare = n ? traded / n : 0;
    const payingShare = n ? paying / n : 0;
    const survival = older3 > 0 ? older3Traded / older3 : null;
    const crowding = traded > 0 ? launches7 / traded : null;
    // Demand: traded share (40) + survival (40) + paying share (20), minus crowding.
    // A quote with no coin past day 3 has no survival evidence: half credit, capped at 80.
    let demand = tradedShare * 40 + (survival != null ? survival * 40 : tradedShare * 20) + payingShare * 20;
    if (crowding != null && crowding > 2) demand -= Math.min(20, (crowding - 2) * 5);
    demand = Math.max(0, Math.min(100, Math.round(demand)));
    const first = coins[0];
    out.push({
      quote_mint: quoteMint,
      quote_symbol: first.quoteSymbol,
      quote_category: first.quoteCategory,
      coins: n,
      launches_24h: launches24,
      launches_7d: launches7,
      traded_24h: traded,
      traded_share_24h: round3(tradedShare),
      paying_24h: paying,
      paying_share_24h: round3(payingShare),
      survival_3d: survival != null ? round3(survival) : null,
      older_than_3d: older3,
      live_24h: live,
      volume_24h_usd: Math.round(vol),
      holders_total: holders,
      holders_median: median(hs),
      market_cap_median_usd: Math.round(median(mc)),
      tax_mix: { bps_100: t100, bps_300: t300, other: tOther },
      paying_by_tax: { bps_100: t100 ? round3(p100 / t100) : null, bps_300: t300 ? round3(p300 / t300) : null },
      traded_by_tax: { bps_100: t100 ? round3(tr100 / t100) : null, bps_300: t300 ? round3(tr300 / t300) : null },
      crowding: crowding != null ? Math.round(crowding * 100) / 100 : null,
      is_new: survival == null,
      demand_score: demand,
    });
  }
  return out;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function fmtUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}
