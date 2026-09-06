import { z } from 'zod';
import type { Cache } from '../cache';
import { StonkPairsInput, StonkRewardRiskInput, StonkYieldInput, StonkScreenerInput, StonkPreflightInput, StonkGemsInput, StonkLaunchIntelInput } from '../schemas/stonk';
import type { StonkFunClient, StonkPair } from '../sources/stonkfun';
import { normalizeCategory, type StonkIndex, type StonkCategory, type StonkIndexStatus, type StonkScreenerRow } from '../enrichers/stonk-index';
import type { GemStage, PayoutStatus, QuoteStats } from '../enrichers/stonk-gems';
import type { StonkRewardRiskAnalyzer } from '../enrichers/stonk-reward-risk';
import type { StonkYieldAnalyzer } from '../enrichers/stonk-yield';
import type { StonkPreflightAnalyzer } from '../enrichers/stonk-preflight';
import { formatResponse } from '../formatters';
import {
  formatStonkPairsBriefing,
  formatStonkRewardRiskBriefing,
  formatStonkYieldBriefing,
  formatStonkScreenerBriefing,
  formatStonkPreflightBriefing,
  formatStonkGemsBriefing,
  formatStonkLaunchIntelBriefing,
} from '../formatters/llm-stonk';

type AddEntrypoint = (def: any) => void;

/**
 * Categories an autonomous launcher may pair against. Everything with a
 * public price reference plus custom mints; collectible/leverage quotes are
 * excluded because their price and liquidity are not something an agent can
 * reason about from the pair record alone.
 */
export const AGENT_LAUNCHABLE_CATEGORIES: StonkCategory[] = ['xstock', 'prestock', 'currency', 'solana', 'custom'];

export interface StonkPairRow {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  category: StonkCategory;
  category_raw: string;
  category_label: string;
  token_program: string;
  launchable: boolean;
  launch_lab_ready: boolean | null;
  symbol_ambiguous: boolean;
  is_agent_launchable: boolean;
}

export interface StonkPairsResult {
  pairs: StonkPairRow[];
  total: number;
  agent_launchable_count: number;
  allowed_categories: StonkCategory[];
  by_category: Record<string, number>;
  filters: { category: StonkCategory | null; launchable_only: boolean };
  source: string;
  next_steps: string[];
}

export interface StonkScreenerRowOut {
  rank: number;
  mint: string;
  symbol: string;
  name: string;
  quote_mint: string;
  quote_symbol: string;
  quote_category: StonkCategory;
  quote_usd: number | null;
  launchpad: string;
  transfer_fee_bps: number | null;
  /** Buy + sell tax cost in % — the hurdle before slippage. Null for legacy no-tax coins. */
  round_trip_pct: number | null;
  flywheel_active: boolean;
  status: string;
  age_days: number;
  holder_count: number;
  payout_count: number;
  last_payout_at: string | null;
  hours_since_last_payout: number | null;
  payout_status: PayoutStatus;
  paying_24h: boolean;
  live: boolean;
  distributed_tokens: number;
  rewards_usd: number | null;
  yield_7d_pct: number | null;
  yield_30d_pct: number | null;
  window_7d_actual_days: number | null;
  window_30d_actual_days: number | null;
  price_usd: number;
  market_cap_usd: number;
  volume_24h_usd: number;
  price_change_24h_pct: number | null;
}

export interface StonkScreenerResult {
  rows: StonkScreenerRowOut[];
  matched: number;
  filters: { quote_mint: string | null; category: StonkCategory | null; min_holders: number | null; min_age_days: number | null; max_age_days: number | null; min_volume_24h_usd: number | null; max_market_cap_usd: number | null; paying_only: boolean; live_only: boolean; sort: string; limit: number };
  index: { rows: number; last_refresh_at: string | null; series_days: number; oldest_point_at: string | null };
  caveats: string[];
  next_steps: string[];
}

export function toPairRow(p: StonkPair): StonkPairRow {
  const category = normalizeCategory(p.category);
  const ready = typeof p.launchLabReady === 'boolean' ? p.launchLabReady : null;
  return {
    mint: p.mint,
    symbol: p.symbol,
    name: p.name,
    decimals: p.decimals,
    category,
    category_raw: p.category,
    category_label: p.categoryLabel,
    token_program: p.tokenProgram,
    launchable: p.launchable === true,
    launch_lab_ready: ready,
    symbol_ambiguous: p.symbolAmbiguous === true,
    is_agent_launchable: p.launchable === true && ready === true && AGENT_LAUNCHABLE_CATEGORIES.includes(category),
  };
}

export function buildPairsResult(pairs: StonkPair[], filters: { category?: StonkCategory; launchable_only: boolean }): StonkPairsResult {
  const rows = pairs.map(toPairRow);
  const byCategory: Record<string, number> = {};
  for (const r of rows) byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
  const filtered = rows
    .filter((r) => !filters.category || r.category === filters.category)
    .filter((r) => !filters.launchable_only || r.is_agent_launchable)
    .sort((a, b) => Number(b.is_agent_launchable) - Number(a.is_agent_launchable) || a.category.localeCompare(b.category) || a.symbol.localeCompare(b.symbol));
  return {
    pairs: filtered,
    total: rows.length,
    agent_launchable_count: rows.filter((r) => r.is_agent_launchable).length,
    allowed_categories: AGENT_LAUNCHABLE_CATEGORIES,
    by_category: byCategory,
    filters: { category: filters.category ?? null, launchable_only: filters.launchable_only },
    source: 'stonkfun.xyz /api/public/v1/pairs (cached 5 min)',
    next_steps: [
      'Pick a quote with is_agent_launchable=true, then GET /launchlab/pricing?quoteMint=<mint> on StonkFun for the exact curve constants.',
      'Run stonk-launch-preflight on the unsigned transaction before broadcasting.',
      'stonk-screener shows which reward coins on that quote already pay holders.',
    ],
  };
}

export function registerStonkEntrypoints(
  addEntrypoint: AddEntrypoint,
  deps: {
    client: StonkFunClient;
    index: StonkIndex;
    rewardRisk: StonkRewardRiskAnalyzer;
    yieldAnalyzer: StonkYieldAnalyzer;
    preflight: StonkPreflightAnalyzer;
    cache: Cache;
  },
) {
  // --- stonk-pairs (FREE) ----------------------------------------------------
  addEntrypoint({
    key: 'stonk-pairs',
    description:
      'FREE. Quote assets a StonkFun launch can be paired against (xStocks, pre-stocks, currencies, custom mints), with normalized categories and an is_agent_launchable flag (launchable + LaunchLab-ready + allowed category). Call this before sizing or preflighting a launch.',
    input: StonkPairsInput,
    handler: async (ctx: { input: z.infer<typeof StonkPairsInput> }) => {
      const input = ctx.input;
      const pairs = await deps.client.getPairs();
      const data = buildPairsResult(pairs, { category: input.category, launchable_only: input.launchable_only });
      return { output: formatResponse(data, input.format, formatStonkPairsBriefing) };
    },
  });

  // --- stonk-reward-risk -----------------------------------------------------
  addEntrypoint({
    key: 'stonk-reward-risk',
    description:
      'Payout status for a StonkFun reward coin — what a holder observes: PAYING (payout in the last 24h), STALE, NEVER, or NOT_REWARD — plus trading cost (tax bps, round-trip %) and a 0-100 health score read from the chain: fee bps and cap, withdraw authority (must be StonkFun\'s distributor), fee mutability, distributions and recency, flywheel, holders and concentration, quote category, age. Call before sizing a reward-coin position.',
    input: StonkRewardRiskInput,
    handler: async (ctx: { input: z.infer<typeof StonkRewardRiskInput> }) => {
      const input = ctx.input;
      const data = await deps.rewardRisk.analyze(input.mint);
      return { output: formatResponse(data, input.format, (d) => d.llm_brief) };
    },
  });

  // --- stonk-yield -------------------------------------------------------------
  addEntrypoint({
    key: 'stonk-yield',
    description:
      'Trailing 7d / 30d / lifetime holder yield for a StonkFun reward coin: rewards distributed in the quote asset, priced in USD, divided by average market cap over the window, annualized with an explicit caution flag when the window is under 7 days. Also returns quote exposure — what a holder is economically long (the coin plus the quote asset) and the reward asset.',
    input: StonkYieldInput,
    handler: async (ctx: { input: z.infer<typeof StonkYieldInput> }) => {
      const input = ctx.input;
      const data = await deps.yieldAnalyzer.analyze(input.mint);
      return { output: formatResponse(data, input.format, formatStonkYieldBriefing) };
    },
  });

  // --- stonk-screener ----------------------------------------------------------
  addEntrypoint({
    key: 'stonk-screener',
    description:
      'Screen every StonkFun reward coin from a 10-minute index. Per row: payout status (PAYING / STALE / NEVER), hours since last payout, live flag (traded AND paid in 24h), round-trip transfer-tax cost, holders, rewards USD, yields, volume, mcap, 24h change. Filters: quote_mint, category, holders, age, volume, market cap, paying_only, live_only. Sort by volume24h (default), lastPayout, holders, priceChange24h, or yield. "Which coins on NVDAX paid holders today?" is one call.',
    input: StonkScreenerInput,
    handler: async (ctx: { input: z.infer<typeof StonkScreenerInput> }) => {
      const input = ctx.input;
      const status: StonkIndexStatus = deps.index.status();
      const screened = deps.index.screen({
        quoteMint: input.quote_mint,
        category: input.category,
        minHolders: input.min_holders,
        minAgeDays: input.min_age_days,
        maxAgeDays: input.max_age_days,
        minVolume24hUsd: input.min_volume_24h_usd,
        maxMarketCapUsd: input.max_market_cap_usd,
        payingOnly: input.paying_only,
        liveOnly: input.live_only,
        sort: input.sort,
        limit: input.limit,
      });
      const caveats: string[] = [
        'rewards_usd and yields price the quote asset at its current USD price',
        'round_trip_pct is the transfer tax paid on a buy plus a sell (2 × bps), before slippage — a trade must clear it to break even',
      ];
      if (status.rows === 0) caveats.unshift('index is warming up after a restart — rows fill in within a minute');
      if (status.seriesDays < 7) caveats.push(`yield windows are partial: ${status.seriesDays} day(s) of snapshots so far`);
      const data: StonkScreenerResult = {
        rows: screened.rows.map((r, i) => toScreenerRowOut(r, i + 1)),
        matched: screened.matched,
        filters: {
          quote_mint: input.quote_mint ?? null,
          category: input.category ?? null,
          min_holders: input.min_holders ?? null,
          min_age_days: input.min_age_days ?? null,
          max_age_days: input.max_age_days ?? null,
          min_volume_24h_usd: input.min_volume_24h_usd ?? null,
          max_market_cap_usd: input.max_market_cap_usd ?? null,
          paying_only: input.paying_only,
          live_only: input.live_only,
          sort: input.sort,
          limit: input.limit,
        },
        index: { rows: status.rows, last_refresh_at: status.lastRefreshAt, series_days: status.seriesDays, oldest_point_at: status.oldestPointAt },
        caveats,
        next_steps: [
          'stonk-gems ranks the young, paying, still-small coins in this set — the "find" call.',
          'stonk-reward-risk on a candidate gives payout status and the on-chain tax config.',
          'trenches-check / exit-signal for the trade itself; both now price the transfer tax.',
        ],
      };
      return { output: formatResponse(data, input.format, formatStonkScreenerBriefing) };
    },
  });

  // --- stonk-gems -----------------------------------------------------------
  addEntrypoint({
    key: 'stonk-gems',
    description:
      'Gem finder over every StonkFun reward coin: which look early, real, and paying? Scores 0-100 from the 10-minute index — recent holder payout, holders (found but not saturated), market cap headroom, 24h turnover, age, momentum (not yet parabolic), quote-asset strength, flywheel. Stages GEM / WATCH / NOISE / DEAD with plain reasons and warnings per coin, plus the round-trip tax cost. Filters: quote_mint, category, max_age_days, min_holders, max_market_cap_usd. Milliseconds.',
    input: StonkGemsInput,
    handler: async (ctx: { input: z.infer<typeof StonkGemsInput> }) => {
      const input = ctx.input;
      const status: StonkIndexStatus = deps.index.status();
      const found = deps.index.gems({
        quoteMint: input.quote_mint,
        category: input.category,
        maxAgeDays: input.max_age_days,
        minHolders: input.min_holders,
        maxMarketCapUsd: input.max_market_cap_usd,
        limit: input.limit,
      });
      const caveats: string[] = [
        'A ranking of what looks early and real on the tape, not a safety verdict and not a price prediction. Thresholds come from a 2026-09-06 measurement over 8,000 reward coins (45% traded in 24h, 13% paid in 24h, median holders 2). NFA.',
        'round_trip_pct is the transfer tax on a buy plus a sell (2 × bps), before slippage — the hurdle a trade must clear.',
      ];
      if (status.rows === 0) caveats.unshift('index is warming up after a restart — rows fill in within a minute');
      const data: StonkGemsResult = {
        gems: found.gems.map((r, i) => ({
          rank: i + 1,
          mint: r.mint,
          symbol: r.symbol,
          name: r.name,
          quote_mint: r.quoteMint,
          quote_symbol: r.quoteSymbol,
          quote_category: r.quoteCategory,
          gem_score: r.gem.score,
          stage: r.gem.stage,
          reasons: r.gem.reasons,
          warnings: r.gem.warnings,
          payout_status: r.payoutStatus,
          hours_since_last_payout: r.hoursSinceLastPayout,
          payout_count: r.payoutCount,
          transfer_fee_bps: r.bps,
          round_trip_pct: r.roundTripPct,
          holder_count: r.holderCount,
          age_days: r.ageDays,
          price_usd: r.priceUsd,
          market_cap_usd: r.marketCapUsd,
          volume_24h_usd: r.volume24hUsd,
          turnover_24h_pct: r.marketCapUsd > 0 ? Math.round((r.volume24hUsd / r.marketCapUsd) * 1000) / 10 : null,
          price_change_24h_pct: r.priceChange24h,
          flywheel_active: r.flywheelActive,
          rewards_usd: r.rewardsUsd != null ? Math.round(r.rewardsUsd * 100) / 100 : null,
          yield_7d_pct: r.yield7dPct,
          launchpad: r.launchpad,
          status: r.status,
        })),
        scanned: found.scanned,
        passed_filters: found.passedFilters,
        stage_counts: found.stageCounts,
        filters: {
          quote_mint: input.quote_mint ?? null,
          category: input.category ?? null,
          max_age_days: input.max_age_days,
          min_holders: input.min_holders,
          max_market_cap_usd: input.max_market_cap_usd,
          limit: input.limit,
        },
        index: { rows: status.rows, last_refresh_at: status.lastRefreshAt, series_days: status.seriesDays, oldest_point_at: status.oldestPointAt },
        caveats,
        next_steps: [
          'trenches-check on a GEM for velocity + smart-money + attention confluence (tax-aware).',
          'stonk-reward-risk for payout status and the on-chain fee config before sizing.',
          'exit-signal while you hold it — reports net PnL after the sell-side tax.',
        ],
      };
      return { output: formatResponse(data, input.format, formatStonkGemsBriefing) };
    },
  });

  // --- stonk-launch-intel ----------------------------------------------------
  addEntrypoint({
    key: 'stonk-launch-intel',
    description:
      'What to launch on StonkFun, and against what. Per quote asset: coins, launches (24h / 7d), share trading today, share paying holders today, survival past day 3, volume, median holders and mcap, 100 vs 300 bps tax mix with trading and paying rates, crowding, and a 0-100 demand score. Plus overall stats and plain recommendations. Sort by demand, survival, volume, launches, or paying. Milliseconds.',
    input: StonkLaunchIntelInput,
    handler: async (ctx: { input: z.infer<typeof StonkLaunchIntelInput> }) => {
      const input = ctx.input;
      const status: StonkIndexStatus = deps.index.status();
      const all = deps.index.quoteStats();
      const data = buildLaunchIntel(all, { category: input.category, minCoins: input.min_coins, sort: input.sort, limit: input.limit }, status);
      return { output: formatResponse(data, input.format, formatStonkLaunchIntelBriefing) };
    },
  });

  // --- stonk-launch-preflight ---------------------------------------------------
  addEntrypoint({
    key: 'stonk-launch-preflight',
    description:
      'Preflight a self-built Raydium LaunchLab launch before broadcasting: decodes the initialize instruction from your unsigned transaction and diffs every parameter against StonkFun\'s /launchlab/pricing for that quote and mode — GlobalConfig, platform id per mode, curve type, supply, totalSellA, raise, 6-decimal Token-2022 base mint, quote token program, vesting, curve-rule account appended last, and for reward mode the transfer-fee option, tier, and cap (catches Raydium\'s transferFeeBasePoints / maxinumFee spelling). Returns ok, mismatches with fixes, warnings. A mismatched pool is never adopted: the tax goes to nobody.',
    input: StonkPreflightInput,
    handler: async (ctx: { input: z.infer<typeof StonkPreflightInput> }) => {
      const input = ctx.input;
      const data = await deps.preflight.preflight({
        unsignedTransaction: input.unsigned_transaction,
        quoteMint: input.quote_mint,
        mode: input.mode,
        launchParams: input.launch_params,
      });
      return { output: formatResponse(data, input.format, formatStonkPreflightBriefing) };
    },
  });
}

// --- Output shapes + pure builders for the new endpoints ---------------------

export function toScreenerRowOut(r: StonkScreenerRow, rank: number): StonkScreenerRowOut {
  return {
    rank,
    mint: r.mint,
    symbol: r.symbol,
    name: r.name,
    quote_mint: r.quoteMint,
    quote_symbol: r.quoteSymbol,
    quote_category: r.quoteCategory,
    quote_usd: r.quoteUsd,
    launchpad: r.launchpad,
    transfer_fee_bps: r.bps,
    round_trip_pct: r.roundTripPct,
    flywheel_active: r.flywheelActive,
    status: r.status,
    age_days: r.ageDays,
    holder_count: r.holderCount,
    payout_count: r.payoutCount,
    last_payout_at: r.lastPayoutAt,
    hours_since_last_payout: r.hoursSinceLastPayout,
    payout_status: r.payoutStatus,
    paying_24h: r.paying24h,
    live: r.live,
    distributed_tokens: r.distributedTokens,
    rewards_usd: r.rewardsUsd != null ? Math.round(r.rewardsUsd * 100) / 100 : null,
    yield_7d_pct: r.yield7dPct,
    yield_30d_pct: r.yield30dPct,
    window_7d_actual_days: r.window7dActualDays,
    window_30d_actual_days: r.window30dActualDays,
    price_usd: r.priceUsd,
    market_cap_usd: r.marketCapUsd,
    volume_24h_usd: r.volume24hUsd,
    price_change_24h_pct: r.priceChange24h,
  };
}

export interface StonkGemRowOut {
  rank: number;
  mint: string;
  symbol: string;
  name: string;
  quote_mint: string;
  quote_symbol: string;
  quote_category: StonkCategory;
  gem_score: number;
  stage: GemStage;
  reasons: string[];
  warnings: string[];
  payout_status: PayoutStatus;
  hours_since_last_payout: number | null;
  payout_count: number;
  transfer_fee_bps: number | null;
  round_trip_pct: number | null;
  holder_count: number;
  age_days: number;
  price_usd: number;
  market_cap_usd: number;
  volume_24h_usd: number;
  turnover_24h_pct: number | null;
  price_change_24h_pct: number | null;
  flywheel_active: boolean;
  rewards_usd: number | null;
  yield_7d_pct: number | null;
  launchpad: string;
  status: string;
}

export interface StonkGemsResult {
  gems: StonkGemRowOut[];
  scanned: number;
  passed_filters: number;
  stage_counts: Record<GemStage, number>;
  filters: { quote_mint: string | null; category: StonkCategory | null; max_age_days: number; min_holders: number; max_market_cap_usd: number; limit: number };
  index: { rows: number; last_refresh_at: string | null; series_days: number; oldest_point_at: string | null };
  caveats: string[];
  next_steps: string[];
}

export type LaunchIntelSort = 'demand' | 'survival' | 'volume' | 'launches' | 'paying';

export interface StonkLaunchIntelResult {
  quotes: Array<QuoteStats & { rank: number }>;
  overall: {
    coins: number;
    quotes: number;
    launches_24h: number;
    launches_7d: number;
    traded_24h: number;
    traded_share_24h: number;
    paying_24h: number;
    paying_share_24h: number;
    survival_3d: number | null;
    tax: {
      bps_100: { coins: number; traded_share: number | null; paying_share: number | null };
      bps_300: { coins: number; traded_share: number | null; paying_share: number | null };
    };
    by_category: Record<string, { quotes: number; coins: number; traded_share_24h: number; paying_share_24h: number }>;
  };
  recommendations: string[];
  filters: { category: StonkCategory | null; min_coins: number; sort: LaunchIntelSort; limit: number };
  index: { rows: number; last_refresh_at: string | null; series_days: number; oldest_point_at: string | null };
  caveats: string[];
  next_steps: string[];
}

/** Pure: rank quotes and derive overall stats + recommendations. Exported for tests. */
export function buildLaunchIntel(
  all: QuoteStats[],
  filters: { category?: StonkCategory; minCoins: number; sort: LaunchIntelSort; limit: number },
  status: StonkIndexStatus,
): StonkLaunchIntelResult {
  const pct = (x: number | null) => (x == null ? 'n/a' : `${(x * 100).toFixed(0)}%`);

  // Overall — over every quote, before filters.
  let coins = 0, l24 = 0, l7 = 0, traded = 0, paying = 0, older3 = 0, older3Traded = 0;
  let c100 = 0, c300 = 0, tr100 = 0, tr300 = 0, p100 = 0, p300 = 0;
  const byCat: Record<string, { quotes: number; coins: number; traded: number; paying: number }> = {};
  for (const q of all) {
    coins += q.coins; l24 += q.launches_24h; l7 += q.launches_7d; traded += q.traded_24h; paying += q.paying_24h;
    older3 += q.older_than_3d;
    if (q.survival_3d != null) older3Traded += Math.round(q.survival_3d * q.older_than_3d);
    c100 += q.tax_mix.bps_100; c300 += q.tax_mix.bps_300;
    if (q.traded_by_tax.bps_100 != null) tr100 += Math.round(q.traded_by_tax.bps_100 * q.tax_mix.bps_100);
    if (q.traded_by_tax.bps_300 != null) tr300 += Math.round(q.traded_by_tax.bps_300 * q.tax_mix.bps_300);
    if (q.paying_by_tax.bps_100 != null) p100 += Math.round(q.paying_by_tax.bps_100 * q.tax_mix.bps_100);
    if (q.paying_by_tax.bps_300 != null) p300 += Math.round(q.paying_by_tax.bps_300 * q.tax_mix.bps_300);
    const c = byCat[q.quote_category] ?? { quotes: 0, coins: 0, traded: 0, paying: 0 };
    c.quotes++; c.coins += q.coins; c.traded += q.traded_24h; c.paying += q.paying_24h;
    byCat[q.quote_category] = c;
  }
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const overall: StonkLaunchIntelResult['overall'] = {
    coins,
    quotes: all.length,
    launches_24h: l24,
    launches_7d: l7,
    traded_24h: traded,
    traded_share_24h: coins ? r3(traded / coins) : 0,
    paying_24h: paying,
    paying_share_24h: coins ? r3(paying / coins) : 0,
    survival_3d: older3 ? r3(older3Traded / older3) : null,
    tax: {
      bps_100: { coins: c100, traded_share: c100 ? r3(tr100 / c100) : null, paying_share: c100 ? r3(p100 / c100) : null },
      bps_300: { coins: c300, traded_share: c300 ? r3(tr300 / c300) : null, paying_share: c300 ? r3(p300 / c300) : null },
    },
    by_category: Object.fromEntries(
      Object.entries(byCat).map(([k, v]) => [k, { quotes: v.quotes, coins: v.coins, traded_share_24h: v.coins ? r3(v.traded / v.coins) : 0, paying_share_24h: v.coins ? r3(v.paying / v.coins) : 0 }]),
    ),
  };

  // Ranked quotes.
  const key = (q: QuoteStats): number =>
    filters.sort === 'survival' ? (q.survival_3d ?? -1)
    : filters.sort === 'volume' ? q.volume_24h_usd
    : filters.sort === 'launches' ? q.launches_7d
    : filters.sort === 'paying' ? q.paying_share_24h
    : q.demand_score;
  const ranked = all
    .filter((q) => q.coins >= filters.minCoins)
    .filter((q) => !filters.category || q.quote_category === filters.category)
    .sort((a, b) => key(b) - key(a) || b.volume_24h_usd - a.volume_24h_usd)
    .slice(0, filters.limit)
    .map((q, i) => ({ ...q, rank: i + 1 }));

  // Recommendations — plain sentences an agent can act on.
  const recs: string[] = [];
  const eligible = [...all].filter((q) => q.coins >= Math.max(filters.minCoins, 10));
  const proven = eligible.filter((q) => !q.is_new).sort((a, b) => b.demand_score - a.demand_score);
  for (const q of proven.slice(0, 3)) {
    recs.push(`${q.quote_symbol} (${q.quote_category}): ${pct(q.traded_share_24h)} of its ${q.coins} coins traded today, ${pct(q.survival_3d)} still trade past day 3, ${q.launches_7d} launches this week${q.crowding != null ? ` (${q.crowding} per coin traded)` : ''} — demand ${q.demand_score}/100.`);
  }
  const fresh = eligible.filter((q) => q.is_new).sort((a, b) => b.traded_share_24h - a.traded_share_24h || b.coins - a.coins).slice(0, 3);
  if (fresh.length) {
    recs.push(`New this week, no 3-day survival yet: ${fresh.map((q) => `${q.quote_symbol} (${q.coins} coins, ${pct(q.traded_share_24h)} traded today)`).join(', ')}. Early-shelf attention is real but unproven — demand capped at 80 until coins age past day 3.`);
  }
  const crowded = [...all].filter((q) => q.coins >= 50 && q.crowding != null && q.crowding >= 3).sort((a, b) => (b.crowding ?? 0) - (a.crowding ?? 0))[0];
  if (crowded) recs.push(`Avoid ${crowded.quote_symbol}: ${crowded.launches_7d} launches this week for ${crowded.traded_24h} coins trading today (crowding ${crowded.crowding}) — the shelf is full.`);
  const t = overall.tax;
  if (t.bps_100.paying_share != null && t.bps_300.paying_share != null) {
    recs.push(`Tax level: 300 bps coins pay holders ${pct(t.bps_300.paying_share)} of the time vs ${pct(t.bps_100.paying_share)} at 100 bps, but 100 bps coins trade more (${pct(t.bps_100.traded_share)} vs ${pct(t.bps_300.traded_share)}). Pick 300 for a yield story, 100 for trading volume.`);
  }
  const cats = Object.entries(overall.by_category).filter(([, v]) => v.coins >= 50).sort((a, b) => b[1].traded_share_24h - a[1].traded_share_24h);
  if (cats.length) recs.push(`Category with the most trading per launch: ${cats[0][0]} (${pct(cats[0][1].traded_share_24h)} of ${cats[0][1].coins} coins traded today).`);

  return {
    quotes: ranked,
    overall,
    recommendations: recs,
    filters: { category: filters.category ?? null, min_coins: filters.minCoins, sort: filters.sort, limit: filters.limit },
    index: { rows: status.rows, last_refresh_at: status.lastRefreshAt, series_days: status.seriesDays, oldest_point_at: status.oldestPointAt },
    caveats: [
      'Survival and demand are 24h/3d activity measures on the index, not returns. A quote can be busy and still lose money for launchers.',
      'Launches attributed to a quote include coins whose pool has since gone quiet; traded/paying shares are the honest denominator.',
      status.rows === 0 ? 'index is warming up after a restart — rows fill in within a minute' : `index: ${status.rows} reward coins${status.lastRefreshAt ? `, refreshed ${status.lastRefreshAt}` : ''}`,
    ],
    next_steps: [
      'stonk-pairs (free) confirms the quote is launchable right now and gives the exact pricing doc to fetch.',
      'stonk-launch-preflight on the unsigned transaction before broadcasting — a mismatched pool is never adopted.',
      'stonk-gems shows what a winning launch on that quote looks like today.',
    ],
  };
}
