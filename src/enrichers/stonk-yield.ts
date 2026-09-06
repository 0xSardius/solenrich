import { CACHE_TTL } from '../config';
import type { Cache } from '../cache';
import type { JupiterClient } from '../sources/jupiter';
import type { StonkFunClient } from '../sources/stonkfun';
import { trailingYield, normalizeCategory, type DayPoint, type StonkIndex, type StonkCategory } from './stonk-index';

// Holder yield for a StonkFun reward coin: rewards distributed in the quote
// asset over a trailing window, priced in USD, divided by the average market
// cap over that window. Windows come from the index's daily snapshots; the
// API itself keeps no per-window history. A window shorter than requested is
// reported with `caution` so an agent never annualizes a two-day sample as if
// it were a month.

export interface YieldWindow {
  window_days: number;
  /** How much history actually backs the figure. < window_days = partial. */
  actual_days: number | null;
  rewards_quote: number | null;
  rewards_usd: number | null;
  avg_market_cap_usd: number | null;
  yield_pct: number | null;
  annualized_pct: number | null;
  caution: boolean;
  caution_reason: string | null;
}

export interface StonkYieldResult {
  mint: string;
  symbol: string | null;
  name: string | null;
  mode: string | null;
  reward_asset: { mint: string | null; symbol: string | null; decimals: number | null; category: StonkCategory | null; usd_price: number | null };
  lifetime: YieldWindow;
  trailing_7d: YieldWindow;
  trailing_30d: YieldWindow;
  quote_exposure: {
    long: string[];
    reward_asset: string | null;
    note: string;
  };
  distributed_tokens_total: number | null;
  payout_count: number | null;
  holder_count: number | null;
  last_payout_at: string | null;
  market_cap_usd: number | null;
  age_days: number | null;
  history: { points: number; oldest_at: string | null; index_started: boolean };
  caveats: string[];
  next_steps: string[];
}

export interface YieldInputs {
  mint: string;
  symbol: string | null;
  name: string | null;
  mode: string | null;
  createdAt: string | null;
  launchMarketCapUsd: number | null;
  marketCapUsd: number | null;
  distributedTokens: number | null;
  payoutCount: number | null;
  holderCount: number | null;
  lastPayoutAt: string | null;
  quote: { mint: string | null; symbol: string | null; decimals: number | null; categoryRaw: string | null };
  quoteUsd: number | null;
  series: DayPoint[];
  now: number;
}

function annualize(yieldPct: number | null, actualDays: number | null): number | null {
  if (yieldPct == null || actualDays == null || actualDays <= 0) return null;
  return Math.round((yieldPct * (365 / actualDays)) * 100) / 100;
}

/** Pure window math. Exported for tests. */
export function computeYield(input: YieldInputs): Omit<StonkYieldResult, 'next_steps'> {
  const caveats: string[] = [];
  const dist = input.distributedTokens ?? 0;
  const mcapNow = input.marketCapUsd ?? 0;
  const ageDays = input.createdAt ? (input.now - Date.parse(input.createdAt)) / 86_400_000 : null;
  const series = [...input.series].sort((a, b) => a.t - b.t);

  if (input.quoteUsd == null) caveats.push('no USD price for the reward asset — USD and yield figures are null');
  caveats.push('rewards are priced at the CURRENT quote price, not the price at each payout');

  const build = (windowDays: number): YieldWindow => {
    let cautionReason: string | null = null;
    let points = series;
    // A coin younger than the window: the launch itself is the window start
    // (0 distributed, launch market cap) — strictly better than any later snapshot.
    if (ageDays != null && ageDays <= windowDays && input.createdAt) {
      const launchPoint: DayPoint = { t: Date.parse(input.createdAt), dist: 0, marketCapUsd: input.launchMarketCapUsd ?? mcapNow, holders: 0 };
      points = [launchPoint, ...series.filter((p) => p.t > launchPoint.t)];
      cautionReason = 'window starts at launch — coin is younger than the window';
    }
    const r = trailingYield(points, input.now, windowDays, dist, mcapNow, input.quoteUsd);
    if (r.actualDays == null) {
      const why = points.length ? 'under one hour of history — no yield yet' : 'no snapshot history covers this window yet — the index records one point per coin per day';
      return { window_days: windowDays, actual_days: null, rewards_quote: null, rewards_usd: null, avg_market_cap_usd: null, yield_pct: null, annualized_pct: null, caution: true, caution_reason: why };
    }
    const partial = r.actualDays < windowDays - 0.5;
    if (partial && !cautionReason) cautionReason = `only ${r.actualDays} days of history behind a ${windowDays}-day window`;
    const under7 = r.actualDays < 7;
    if (under7 && !cautionReason) cautionReason = `window under 7 days (${r.actualDays}d) — annualized figure is a projection, not a track record`;
    return {
      window_days: windowDays,
      actual_days: r.actualDays,
      rewards_quote: r.rewardsQuote,
      rewards_usd: r.rewardsUsd != null ? Math.round(r.rewardsUsd * 100) / 100 : null,
      avg_market_cap_usd: r.avgMcapUsd != null ? Math.round(r.avgMcapUsd) : null,
      yield_pct: r.yieldPct,
      annualized_pct: annualize(r.yieldPct, r.actualDays),
      caution: under7 || partial || cautionReason != null,
      caution_reason: cautionReason ?? (under7 ? 'window under 7 days' : null),
    };
  };

  // Lifetime: from launch to now, average market cap from whatever points exist.
  const lifetime: YieldWindow = (() => {
    if (ageDays == null || ageDays <= 0) {
      return { window_days: 0, actual_days: null, rewards_quote: null, rewards_usd: null, avg_market_cap_usd: null, yield_pct: null, annualized_pct: null, caution: true, caution_reason: 'launch date unknown' };
    }
    const mcaps = series.map((p) => p.marketCapUsd).filter((m) => m > 0);
    if (mcapNow > 0) mcaps.push(mcapNow);
    if (input.launchMarketCapUsd && input.launchMarketCapUsd > 0) mcaps.unshift(input.launchMarketCapUsd);
    const avg = mcaps.length ? mcaps.reduce((a, b) => a + b, 0) / mcaps.length : 0;
    const rewardsUsd = input.quoteUsd != null ? dist * input.quoteUsd : null;
    const yieldPct = rewardsUsd != null && avg > 0 ? Math.round((rewardsUsd / avg) * 100 * 10000) / 10000 : null;
    const actual = Math.round(ageDays * 100) / 100;
    const fewPoints = mcaps.length < 3;
    return {
      window_days: Math.ceil(ageDays),
      actual_days: actual,
      rewards_quote: dist,
      rewards_usd: rewardsUsd != null ? Math.round(rewardsUsd * 100) / 100 : null,
      avg_market_cap_usd: avg > 0 ? Math.round(avg) : null,
      yield_pct: yieldPct,
      annualized_pct: annualize(yieldPct, actual),
      caution: actual < 7 || fewPoints,
      caution_reason: actual < 7 ? 'coin younger than 7 days' : fewPoints ? 'average market cap from fewer than 3 observations' : null,
    };
  })();

  const quoteCategory = input.quote.categoryRaw ? normalizeCategory(input.quote.categoryRaw) : null;
  const quoteSymbol = input.quote.symbol;
  const memeSymbol = input.symbol ?? 'the coin';

  return {
    mint: input.mint,
    symbol: input.symbol,
    name: input.name,
    mode: input.mode,
    reward_asset: { mint: input.quote.mint, symbol: quoteSymbol, decimals: input.quote.decimals, category: quoteCategory, usd_price: input.quoteUsd },
    lifetime,
    trailing_7d: build(7),
    trailing_30d: build(30),
    quote_exposure: {
      long: [
        `${memeSymbol} (the coin itself)`,
        ...(quoteSymbol ? [`${quoteSymbol}${input.quote.categoryRaw ? ` (${input.quote.categoryRaw})` : ''}`] : []),
      ],
      reward_asset: quoteSymbol,
      note: quoteSymbol
        ? `${memeSymbol} is priced and pays rewards in ${quoteSymbol}. A holder is long both: the coin's price in USD moves with ${quoteSymbol}, and every reward accrues in ${quoteSymbol}.`
        : 'quote asset unknown',
    },
    distributed_tokens_total: input.distributedTokens,
    payout_count: input.payoutCount,
    holder_count: input.holderCount,
    last_payout_at: input.lastPayoutAt,
    market_cap_usd: input.marketCapUsd,
    age_days: ageDays != null ? Math.round(ageDays * 100) / 100 : null,
    history: { points: series.length, oldest_at: series.length ? new Date(series[0].t).toISOString() : null, index_started: series.length > 0 },
    caveats,
  };
}

export class StonkYieldAnalyzer {
  constructor(
    private readonly client: StonkFunClient,
    private readonly index: StonkIndex,
    private readonly jupiter: JupiterClient,
    private readonly cache: Cache,
  ) {}

  async analyze(mint: string): Promise<StonkYieldResult> {
    const cacheKey = `stonk:yield:${mint}`;
    const cached = await this.cache.get<StonkYieldResult>(cacheKey);
    if (cached) return cached;

    const now = Date.now();
    const [tokenData, rewardsData] = await Promise.all([this.client.getToken(mint), this.client.getTokenRewards(mint)]);
    if (!tokenData && !rewardsData) throw new Error(`StonkFun does not know mint ${mint}`);
    const token = tokenData?.token ?? null;
    const launch = tokenData?.launch ?? null;
    const rewards = rewardsData?.rewards ?? null;
    const row = this.index.getRow(mint);

    const quoteMint = rewardsData?.quote?.mint ?? token?.quote?.mint ?? row?.quoteMint ?? null;
    let quoteUsd = quoteMint ? this.index.getQuoteUsd(quoteMint) : null;
    if (quoteUsd == null && quoteMint) {
      try {
        const prices = await this.jupiter.getPrice([quoteMint]);
        quoteUsd = prices[quoteMint]?.price ?? null;
      } catch { /* leave null */ }
    }

    const distNow = rewards?.distributedTokens ?? row?.distributedTokens ?? null;
    const mcapNow = token?.market?.marketCapUsd ?? row?.marketCapUsd ?? null;
    // Fresh totals are a valid observation — seed today's point so a first
    // call starts the series for this coin even between ingest runs.
    if (distNow != null && mcapNow != null) {
      this.index.observe(mint, { t: now, dist: distNow, marketCapUsd: mcapNow, holders: rewards?.holderCount ?? row?.holderCount ?? 0 });
    }

    const computed = computeYield({
      mint,
      symbol: token?.symbol ?? launch?.symbol ?? row?.symbol ?? null,
      name: token?.name ?? launch?.name ?? row?.name ?? null,
      mode: token?.mode ?? rewardsData?.mode ?? row?.mode ?? null,
      createdAt: token?.createdAt ?? launch?.createdAt ?? row?.createdAt ?? null,
      launchMarketCapUsd: launch?.startMarketCapUsd ?? null,
      marketCapUsd: mcapNow,
      distributedTokens: distNow,
      payoutCount: rewards?.payoutCount ?? row?.payoutCount ?? null,
      holderCount: rewards?.holderCount ?? row?.holderCount ?? null,
      lastPayoutAt: rewards?.lastPayoutAt ?? row?.lastPayoutAt ?? null,
      quote: {
        mint: quoteMint,
        symbol: rewardsData?.quote?.symbol ?? token?.quote?.symbol ?? row?.quoteSymbol ?? null,
        decimals: rewardsData?.quote?.decimals ?? row?.quoteDecimals ?? null,
        categoryRaw: token?.quote?.category ?? row?.quoteCategoryRaw ?? null,
      },
      quoteUsd,
      series: this.index.getSeries(mint),
      now,
    });

    const result: StonkYieldResult = {
      ...computed,
      next_steps: [
        'stonk-reward-risk to confirm the tax actually reaches holders before trusting the yield.',
        'stonk-screener to compare this coin against every other reward coin on the same quote.',
      ],
    };
    if (computed.mode && computed.mode !== 'reward') result.caveats.unshift(`mode is ${computed.mode} — standard launches pay the creator, not holders`);
    await this.cache.set(cacheKey, result, CACHE_TTL.stonkYield);
    return result;
  }
}
