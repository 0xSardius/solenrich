import type { Cache } from '../cache';
import { CACHE_TTL } from '../config';
import { formatTimestamp } from '../utils/normalize';
import type { DexScreenerClient } from '../sources/dexscreener';
import type { BirdeyeClient } from '../sources/birdeye';
import type { WhaleWatcher } from './whale-watch';
import {
  aggregatePairs,
  MIN_SNAPSHOT_AGE_MS,
  SNAPSHOT_TTL_S,
  type Snapshot,
} from './runner-detector';
import { assessExit, type ExitMetrics, type ExitVerdict } from './exit-score';
import { netPnlAfterExitTaxPct, type TransferTax, type TransferTaxReader } from '../sources/token-2022';

// --- Types ---

export interface ExitPosition {
  entry_price_usd: number;
  /** Unrealized % move from entry to current price. Null when price unavailable. */
  unrealized_pnl_pct: number | null;
  /** Unrealized % after paying the sell-side transfer tax. Equals unrealized_pnl_pct when the mint has no tax. */
  net_pnl_after_exit_tax_pct: number | null;
}

export interface ExitSignalResult {
  mint: string;
  symbol: string | null;
  name: string | null;
  price_usd: number | null;
  liquidity_usd: number | null;
  market_cap_usd: number | null;
  price_change_h1_pct: number | null;
  price_change_h24_pct: number | null;
  buys_h1: number | null;
  sells_h1: number | null;
  exit_score: number;
  verdict: ExitVerdict;
  flags: string[];
  metrics: ExitMetrics;
  whales: {
    net_flow_direction: 'accumulating' | 'distributing' | 'neutral';
    whale_count: number;
    distributing_count: number;
    accumulating_count: number;
    total_sell_volume_usd: number;
    total_buy_volume_usd: number;
    lookback_hours: number;
  } | null;
  /** Present only when the caller supplied entry_price_usd. */
  position: ExitPosition | null;
  /** Token-2022 transfer tax as an exit cost. Null = no tax or read unavailable. */
  transfer_tax: TransferTax | null;
  reasoning: string;
  /** Minutes since the prior snapshot the liquidity/holder deltas cover. Null on first look. */
  delta_window_minutes: number | null;
  caveats: string[];
  last_updated: string;
}

/** Whale-watch parameters: balance floor + how far back to read flow. */
const WHALE_THRESHOLD_USD = 10_000;
const WHALE_LOOKBACK_H = 24;

// --- Class ---

/**
 * `exit-signal` — the sell-side verdict. Every other trenches endpoint answers
 * "should I enter"; this one answers "I hold it — should I get out?"
 *
 * Four legs, each degrading independently:
 *  1. Market tape (DexScreener): sell pressure, buy-rate deceleration,
 *     volume fade, distribution-into-strength divergence.
 *  2. Snapshot deltas (shared `runner:snap:{mint}` rails): liquidity trend,
 *     holder churn. Fill in on repeat calls 5+ minutes apart.
 *  3. Top-holder flow (whale-watch): who among the largest holders is
 *     distributing vs accumulating over the last 24h.
 *  4. Holder count (Birdeye, optional).
 *
 * Unlike runner-scan this works on tokens of ANY age — a position does not
 * stop needing an exit read after the fresh-launch window closes.
 */
export class ExitSignalAnalyzer {
  constructor(
    private dexscreener: DexScreenerClient,
    private whaleWatcher: WhaleWatcher,
    private cache: Cache,
    private birdeye?: BirdeyeClient,
    private taxReader?: TransferTaxReader,
  ) {}

  async analyze(mint: string, entryPriceUsd?: number): Promise<ExitSignalResult> {
    // The market read is caller-independent — cache it under the mint alone and
    // apply the caller's position context after retrieval.
    const cacheKey = `exit:signal:${mint}`;
    const cached = await this.cache.get<ExitSignalResult>(cacheKey);
    if (cached) return withPosition(cached, entryPriceUsd);

    const [pairsLeg, whaleLeg, holderLeg, taxLeg] = await Promise.allSettled([
      this.dexscreener.getPairsBatch([mint]),
      this.whaleWatcher.enrich(mint, WHALE_THRESHOLD_USD, WHALE_LOOKBACK_H),
      this.birdeye ? this.birdeye.getTokenOverview(mint) : Promise.resolve(null),
      this.taxReader ? this.taxReader.get(mint) : Promise.resolve(null),
    ]);
    const transferTax = taxLeg.status === 'fulfilled' ? taxLeg.value : null;

    const caveats: string[] = [];

    // --- Market tape leg ---
    const pairs = pairsLeg.status === 'fulfilled' ? pairsLeg.value : [];
    if (pairsLeg.status === 'rejected') {
      caveats.push('Market leg FAILED (DexScreener unreachable) — verdict omits sell pressure and momentum.');
    }
    const agg = aggregatePairs(pairs).find((a) => a.mint === mint) ?? null;
    if (!agg && pairsLeg.status === 'fulfilled') {
      caveats.push('No DexScreener pairs found — token is untradable or delisted. If you hold it, that IS the exit signal: liquidity to sell into may not exist.');
    }

    // --- Snapshot deltas (shared rails with runner-scan / trenches-check) ---
    const now = Date.now();
    const prior = await this.cache.get<Snapshot>(`runner:snap:${mint}`).catch(() => null);
    const priorAgeMs = prior ? now - prior.t : null;
    const useDelta = prior != null && priorAgeMs != null && priorAgeMs >= MIN_SNAPSHOT_AGE_MS;

    const holderNow =
      holderLeg.status === 'fulfilled' && typeof (holderLeg.value as any)?.holder === 'number'
        ? ((holderLeg.value as any).holder as number)
        : null;

    const liquidity_change_pct =
      useDelta && agg && prior!.liquidity_usd > 0
        ? Math.round(((agg.liquidity_usd - prior!.liquidity_usd) / prior!.liquidity_usd) * 1000) / 10
        : null;
    const holder_growth_pct =
      useDelta && holderNow != null && prior!.holder_count != null && prior!.holder_count > 0
        ? Math.round(((holderNow - prior!.holder_count) / prior!.holder_count) * 1000) / 10
        : null;

    if (agg && !useDelta) {
      caveats.push('No prior snapshot for this token — liquidity-trend and holder-churn are null. Call again in 5+ minutes and they fill in (rug detection needs the second look).');
    }

    // Refresh the shared snapshot so the NEXT call (or scan) has a baseline.
    if (agg && (prior == null || now - prior.t >= MIN_SNAPSHOT_AGE_MS)) {
      const snap: Snapshot = { t: now, liquidity_usd: agg.liquidity_usd, holder_count: holderNow };
      this.cache
        .set(`runner:snap:${mint}`, snap, SNAPSHOT_TTL_S)
        .catch((err) => console.warn(`[exit-signal] snapshot write failed for ${mint}: ${err}`));
    }

    // --- Whale flow leg ---
    const whaleData = whaleLeg.status === 'fulfilled' ? whaleLeg.value : null;
    if (whaleLeg.status === 'rejected') {
      caveats.push('Whale leg FAILED this call — verdict omits top-holder flow.');
    }
    const whales: ExitSignalResult['whales'] =
      whaleData && whaleData.holders_source !== 'unavailable'
        ? {
            net_flow_direction: whaleData.net_flow_direction,
            whale_count: whaleData.whale_count,
            distributing_count: whaleData.whales.filter((w) => w.flow_direction === 'distributing').length,
            accumulating_count: whaleData.whales.filter((w) => w.flow_direction === 'accumulating').length,
            total_sell_volume_usd: Math.round(whaleData.whales.reduce((s, w) => s + w.sell_volume_usd, 0)),
            total_buy_volume_usd: Math.round(whaleData.whales.reduce((s, w) => s + w.buy_volume_usd, 0)),
            lookback_hours: WHALE_LOOKBACK_H,
          }
        : null;
    if (whaleData && whaleData.holders_source === 'unavailable') {
      caveats.push('Top-holder list unavailable for this token — verdict omits whale flow.');
    }

    // --- Score ---
    const assessment = assessExit({
      txns: agg?.txns ?? {
        m5: { buys: 0, sells: 0 }, h1: { buys: 0, sells: 0 },
        h6: { buys: 0, sells: 0 }, h24: { buys: 0, sells: 0 },
      },
      volume: agg?.volume ?? { m5: 0, h1: 0, h6: 0, h24: 0 },
      price_change: agg?.price_change ?? { m5: 0, h1: 0, h6: 0, h24: 0 },
      liquidity_usd: agg?.liquidity_usd ?? 0,
      liquidity_change_pct,
      holder_growth_pct,
      whale: whales
        ? {
            net_flow_direction: whales.net_flow_direction,
            distributing_count: whales.distributing_count,
            accumulating_count: whales.accumulating_count,
            whale_count: whales.whale_count,
            total_sell_volume_usd: whales.total_sell_volume_usd,
            total_buy_volume_usd: whales.total_buy_volume_usd,
          }
        : null,
    });

    if (transferTax && transferTax.bps > 0) {
      caveats.push(
        `This mint charges a ${transferTax.bps} bps transfer tax: selling costs ${transferTax.per_transfer_pct}% on top of slippage, and a round trip costs ${transferTax.round_trip_pct}%. net_pnl_after_exit_tax_pct is the number to act on.`,
      );
    }

    caveats.push(
      'A read of the current tape, not a price prediction. Signals are minutes-scale — a verdict older than the cache window is stale. Not financial advice.',
    );

    const result: ExitSignalResult = {
      mint,
      symbol: agg?.symbol ?? null,
      name: agg?.name ?? null,
      price_usd: agg?.price_usd ?? null,
      liquidity_usd: agg ? Math.round(agg.liquidity_usd) : null,
      market_cap_usd: agg ? Math.round(agg.market_cap_usd) : null,
      price_change_h1_pct: agg?.price_change.h1 ?? null,
      price_change_h24_pct: agg?.price_change.h24 ?? null,
      buys_h1: agg?.txns.h1.buys ?? null,
      sells_h1: agg?.txns.h1.sells ?? null,
      exit_score: assessment.exit_score,
      verdict: assessment.verdict,
      flags: assessment.flags,
      metrics: assessment.metrics,
      whales,
      position: null,
      transfer_tax: transferTax,
      reasoning: assessment.reasoning,
      delta_window_minutes: useDelta ? Math.round(priorAgeMs! / 60_000) : null,
      caveats,
      last_updated: formatTimestamp(),
    };

    await this.cache.set(cacheKey, result, CACHE_TTL.exitSignal);
    return withPosition(result, entryPriceUsd);
  }
}

// --- Pure helpers ---

/** Layer the caller's position onto the cached market read. Never mutates the cached object. */
export function withPosition(result: ExitSignalResult, entryPriceUsd?: number): ExitSignalResult {
  if (entryPriceUsd == null || entryPriceUsd <= 0) {
    return result.position == null ? result : { ...result, position: null };
  }
  const pnl =
    result.price_usd != null && result.price_usd > 0
      ? Math.round(((result.price_usd - entryPriceUsd) / entryPriceUsd) * 1000) / 10
      : null;
  const bps = result.transfer_tax?.bps ?? 0;
  const net =
    result.price_usd != null && result.price_usd > 0
      ? bps > 0 ? netPnlAfterExitTaxPct(entryPriceUsd, result.price_usd, bps) : pnl
      : null;
  return {
    ...result,
    position: { entry_price_usd: entryPriceUsd, unrealized_pnl_pct: pnl, net_pnl_after_exit_tax_pct: net },
  };
}
