import { z } from 'zod';
import type { Cache } from '../cache';
import { StonkPairsInput, StonkRewardRiskInput, StonkYieldInput, StonkScreenerInput, StonkPreflightInput } from '../schemas/stonk';
import type { StonkFunClient, StonkPair } from '../sources/stonkfun';
import { normalizeCategory, type StonkIndex, type StonkCategory, type StonkIndexStatus } from '../enrichers/stonk-index';
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
  flywheel_active: boolean;
  status: string;
  age_days: number;
  holder_count: number;
  payout_count: number;
  last_payout_at: string | null;
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
  filters: { quote_mint: string | null; category: StonkCategory | null; min_holders: number | null; min_age_days: number | null; sort: string; limit: number };
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
      'Reward-coin health score (0-100) for a StonkFun reward-mode coin, from the chain not just the API: Token-2022 transfer-fee bps and cap, withdraw authority (must be StonkFun\'s distributor), zero-rate/unadopted detection, distributions to date and recency, flywheel, holder count and top-10 concentration, quote asset category, age, graduation. Zero-rate or unadopted coins score under 20. Call before buying a reward coin for its yield.',
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
      'Ranked screener across every StonkFun reward coin, served from a 10-minute ingest of the token list and rewards ledger. Filters: quote_mint, category (xstock, prestock, currency, leverage, solana, collectible, custom), min_holders, min_age_days. Sort by yield7d, yield30d, rewardsUsd, or volume24h. "Which coins pay holders in NVDAX?" is one call.',
    input: StonkScreenerInput,
    handler: async (ctx: { input: z.infer<typeof StonkScreenerInput> }) => {
      const input = ctx.input;
      const status: StonkIndexStatus = deps.index.status();
      const screened = deps.index.screen({
        quoteMint: input.quote_mint,
        category: input.category,
        minHolders: input.min_holders,
        minAgeDays: input.min_age_days,
        sort: input.sort,
        limit: input.limit,
      });
      const caveats: string[] = ['rewards_usd and yields price the quote asset at its current USD price'];
      if (status.rows === 0) caveats.unshift('index is warming up after a restart — rows fill in within a minute');
      if (status.seriesDays < 7) caveats.push(`yield windows are partial: ${status.seriesDays} day(s) of snapshots so far`);
      const data: StonkScreenerResult = {
        rows: screened.rows.map((r, i) => ({
          rank: i + 1,
          mint: r.mint,
          symbol: r.symbol,
          name: r.name,
          quote_mint: r.quoteMint,
          quote_symbol: r.quoteSymbol,
          quote_category: r.quoteCategory,
          quote_usd: r.quoteUsd,
          launchpad: r.launchpad,
          transfer_fee_bps: r.bps,
          flywheel_active: r.flywheelActive,
          status: r.status,
          age_days: r.ageDays,
          holder_count: r.holderCount,
          payout_count: r.payoutCount,
          last_payout_at: r.lastPayoutAt,
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
        })),
        matched: screened.matched,
        filters: {
          quote_mint: input.quote_mint ?? null,
          category: input.category ?? null,
          min_holders: input.min_holders ?? null,
          min_age_days: input.min_age_days ?? null,
          sort: input.sort,
          limit: input.limit,
        },
        index: { rows: status.rows, last_refresh_at: status.lastRefreshAt, series_days: status.seriesDays, oldest_point_at: status.oldestPointAt },
        caveats,
        next_steps: [
          'stonk-reward-risk on a candidate confirms the tax reaches holders (withdraw authority, zero-rate, adoption).',
          'stonk-yield gives the per-coin window math with caution flags.',
        ],
      };
      return { output: formatResponse(data, input.format, formatStonkScreenerBriefing) };
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
