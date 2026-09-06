import type { Cache } from '../cache';
import { CACHE_TTL } from '../config';
import { formatTimestamp } from '../utils/normalize';
import type { DexScreenerClient } from '../sources/dexscreener';
import type { BirdeyeClient } from '../sources/birdeye';
import { assessRunner, type RunnerStage, type RunnerMetrics } from './runner-score';
import {
  aggregatePairs,
  MIN_SNAPSHOT_AGE_MS,
  SNAPSHOT_TTL_S,
  type Snapshot,
} from './runner-detector';
import type { TrenchesSmartMoneyAnalyzer } from './trenches-smart-money';
import type { TrenchesBuy } from './trenches-smart-money';
import type { SignalTracker } from './signal-tracker';
import { W_RUNNER, W_SMART, W_ATTENTION, smartComponent } from './trenches-scan';
import type { TransferTax, TransferTaxReader } from '../sources/token-2022';

// --- Types ---

export type TrenchesCheckVerdict = 'HIGH_CONFLUENCE' | 'MODERATE' | 'SINGLE_SIGNAL' | 'NO_SIGNAL';

export interface TrenchesCheckResult {
  mint: string;
  symbol: string | null;
  name: string | null;
  age_hours: number | null;
  price_usd: number | null;
  liquidity_usd: number | null;
  market_cap_usd: number | null;
  composite_score: number;
  confluence: number;
  verdict: TrenchesCheckVerdict;
  runner: {
    stage: RunnerStage;
    runner_score: number;
    volume_h1_usd: number;
    price_change_h1_pct: number;
    price_change_h24_pct: number;
    buys_h1: number;
    sells_h1: number;
    flags: string[];
    metrics: RunnerMetrics;
    reasoning: string;
    /** Minutes since the prior snapshot the liquidity/holder deltas cover. Null on first check. */
    delta_window_minutes: number | null;
  } | null;
  smart_money: {
    smart_buyers: number;
    conviction_holder_buyers: number;
    total_spent_usd: number;
    most_recent_buy_minutes_ago: number;
    buys: TrenchesBuy[];
  } | null;
  attention: {
    queries_6h: number;
    prior_window_queries: number;
    rank: number;
    percentile: number;
    rising: boolean;
  } | null;
  /** Token-2022 transfer tax as a trading cost. Null = no tax or read unavailable. */
  transfer_tax: TransferTax | null;
  reasoning: string;
  caveats: string[];
  last_updated: string;
}

/** Smart-money leg looks back this far; matches the standalone endpoint's max. */
const SMART_MONEY_MAX_AGE_H = 72;

// --- Class ---

/**
 * `trenches-check` — the trenches suite pointed at ONE token: "you tell me the
 * mint, I tell you if it's real." Same three legs as trenches-scan (on-chain
 * velocity, proven-winner buys, agent attention) and the same composite
 * weights, but targeted instead of discovery-driven. The natural follow-up
 * call to a new-tokens discovery or a Telegram shill.
 *
 * Snapshot note: shares `runner:snap:{mint}` history with runner-scan, so a
 * token that appeared in a recent scan already has liquidity/holder deltas.
 */
export class TrenchesCheckAnalyzer {
  constructor(
    private dexscreener: DexScreenerClient,
    private smartMoney: TrenchesSmartMoneyAnalyzer,
    private signals: SignalTracker,
    private cache: Cache,
    private birdeye?: BirdeyeClient,
    private taxReader?: TransferTaxReader,
  ) {}

  async check(mint: string): Promise<TrenchesCheckResult> {
    const cacheKey = `trenches:check:${mint}`;
    const cached = await this.cache.get<TrenchesCheckResult>(cacheKey);
    if (cached) return cached;

    const [pairsLeg, smartLeg, attentionLeg, holderLeg, taxLeg] = await Promise.allSettled([
      this.dexscreener.getPairsBatch([mint]),
      this.smartMoney.enrich(12, SMART_MONEY_MAX_AGE_H, 1, 25),
      this.signals.getSignal('token', mint, '6h', 1),
      this.birdeye ? this.birdeye.getTokenOverview(mint) : Promise.resolve(null),
      this.taxReader ? this.taxReader.get(mint) : Promise.resolve(null),
    ]);
    const transferTax = taxLeg.status === 'fulfilled' ? taxLeg.value : null;

    const caveats: string[] = [];

    // --- Runner leg: aggregate this mint's pairs, score with snapshot deltas ---
    const pairs = pairsLeg.status === 'fulfilled' ? pairsLeg.value : [];
    if (pairsLeg.status === 'rejected') {
      caveats.push('On-chain leg FAILED (DexScreener unreachable) — verdict omits velocity.');
    }
    const agg = aggregatePairs(pairs).find((a) => a.mint === mint) ?? null;

    let runner: TrenchesCheckResult['runner'] = null;
    if (agg && agg.age_hours != null) {
      const now = Date.now();
      const prior = await this.cache.get<Snapshot>(`runner:snap:${mint}`).catch(() => null);
      const priorAgeMs = prior ? now - prior.t : null;
      const useDelta = prior != null && priorAgeMs != null && priorAgeMs >= MIN_SNAPSHOT_AGE_MS;

      const holderNow =
        holderLeg.status === 'fulfilled' && typeof (holderLeg.value as any)?.holder === 'number'
          ? ((holderLeg.value as any).holder as number)
          : null;

      const liquidity_change_pct =
        useDelta && prior!.liquidity_usd > 0
          ? Math.round(((agg.liquidity_usd - prior!.liquidity_usd) / prior!.liquidity_usd) * 1000) / 10
          : null;
      const holder_growth_pct =
        useDelta && holderNow != null && prior!.holder_count != null && prior!.holder_count > 0
          ? Math.round(((holderNow - prior!.holder_count) / prior!.holder_count) * 1000) / 10
          : null;

      const assessment = assessRunner({
        txns: agg.txns,
        volume: agg.volume,
        price_change: agg.price_change,
        liquidity_usd: agg.liquidity_usd,
        age_hours: agg.age_hours,
        liquidity_change_pct,
        holder_growth_pct,
      });

      runner = {
        stage: assessment.stage,
        runner_score: assessment.runner_score,
        volume_h1_usd: Math.round(agg.volume.h1),
        price_change_h1_pct: agg.price_change.h1,
        price_change_h24_pct: agg.price_change.h24,
        buys_h1: agg.txns.h1.buys,
        sells_h1: agg.txns.h1.sells,
        flags: assessment.flags,
        metrics: assessment.metrics,
        reasoning: assessment.reasoning,
        delta_window_minutes: useDelta ? Math.round(priorAgeMs! / 60_000) : null,
      };

      // Refresh the shared snapshot so the NEXT check (or scan) has a baseline.
      if (prior == null || now - prior.t >= MIN_SNAPSHOT_AGE_MS) {
        const snap: Snapshot = { t: now, liquidity_usd: agg.liquidity_usd, holder_count: holderNow };
        this.cache
          .set(`runner:snap:${mint}`, snap, SNAPSHOT_TTL_S)
          .catch((err) => console.warn(`[trenches-check] snapshot write failed for ${mint}: ${err}`));
      }
      if (!useDelta) {
        caveats.push(
          'No prior snapshot for this token — liquidity-trend and holder-growth are null. Re-check in 5+ minutes and they fill in.',
        );
      }
    } else if (agg) {
      caveats.push('DexScreener exposes no launch time for this token — velocity scoring needs token age, so the on-chain leg is unavailable.');
    } else {
      caveats.push('No DexScreener pairs found — token is untradable, delisted, or too new for indexing. On-chain leg unavailable.');
    }

    // --- Smart-money leg: membership lookup in the (cached) seed scan ---
    const smartData = smartLeg.status === 'fulfilled' ? smartLeg.value : null;
    if (smartLeg.status === 'rejected') {
      caveats.push('Smart-money leg FAILED this check — verdict omits proven-winner buys.');
    }
    const smartSignal = smartData?.signals.find((s) => s.mint === mint) ?? null;
    const smart_money: TrenchesCheckResult['smart_money'] = smartSignal
      ? {
          smart_buyers: smartSignal.smart_buyers,
          conviction_holder_buyers: smartSignal.conviction_holder_buyers,
          total_spent_usd: smartSignal.total_spent_usd,
          most_recent_buy_minutes_ago: smartSignal.most_recent_buy_minutes_ago,
          buys: smartSignal.buys.slice(0, 5),
        }
      : null;
    if (smartData && !smartSignal && agg?.age_hours != null && agg.age_hours > SMART_MONEY_MAX_AGE_H) {
      caveats.push(
        `Token is older than the smart-money window (${SMART_MONEY_MAX_AGE_H}h) — absence of proven-winner buys here is expected, not a red flag.`,
      );
    }

    // --- Attention leg ---
    const entity = attentionLeg.status === 'fulfilled' ? attentionLeg.value.entity : null;
    if (attentionLeg.status === 'rejected') {
      caveats.push('Attention leg FAILED this check.');
    }
    const attention: TrenchesCheckResult['attention'] =
      entity && (entity.queries > 0 || entity.prior_window_queries > 0)
        ? {
            queries_6h: entity.queries,
            prior_window_queries: entity.prior_window_queries,
            rank: entity.rank,
            percentile: entity.percentile,
            rising: entity.rising,
          }
        : null;

    // --- Composite ---
    const runnerScore = runner ? runner.runner_score * W_RUNNER : 0;
    const smartScore = smart_money ? smartComponent(smart_money.smart_buyers) * W_SMART : 0;
    const attnScore = attention ? (attention.rising ? 0.6 : 0.2) * W_ATTENTION : 0;
    const composite = Math.round((runnerScore + smartScore + attnScore) * 100) / 100;
    const confluence = (runner ? 1 : 0) + (smart_money ? 1 : 0) + (attention ? 1 : 0);

    const verdict: TrenchesCheckVerdict =
      confluence === 0 ? 'NO_SIGNAL'
      : confluence >= 2 && composite >= 0.5 ? 'HIGH_CONFLUENCE'
      : confluence >= 2 || composite >= 0.5 ? 'MODERATE'
      : 'SINGLE_SIGNAL';

    if (transferTax && transferTax.bps > 0) {
      caveats.push(
        `This mint charges a ${transferTax.bps} bps transfer tax — a round trip costs ${transferTax.round_trip_pct}% before slippage. A scalp needs more than that to break even; treat IGNITING as weaker than on an untaxed mint.`,
      );
    }

    caveats.push(
      'A verdict on the signals, not the token\'s safety — run due-diligence for holder concentration and rug flags. Not financial advice.',
    );

    const result: TrenchesCheckResult = {
      mint,
      symbol: agg?.symbol ?? null,
      name: agg?.name ?? null,
      age_hours: agg?.age_hours != null ? Math.round(agg.age_hours * 10) / 10 : null,
      price_usd: agg?.price_usd ?? null,
      liquidity_usd: agg ? Math.round(agg.liquidity_usd) : null,
      market_cap_usd: agg ? Math.round(agg.market_cap_usd) : null,
      composite_score: composite,
      confluence,
      verdict,
      runner,
      smart_money,
      attention,
      transfer_tax: transferTax,
      reasoning: buildCheckReasoning(runner, smart_money, attention, verdict),
      caveats,
      last_updated: formatTimestamp(),
    };

    await this.cache.set(cacheKey, result, CACHE_TTL.trenchesCheck);
    return result;
  }
}

// --- Pure helpers ---

function buildCheckReasoning(
  runner: TrenchesCheckResult['runner'],
  smart: TrenchesCheckResult['smart_money'],
  attention: TrenchesCheckResult['attention'],
  verdict: TrenchesCheckVerdict,
): string {
  if (verdict === 'NO_SIGNAL') {
    return 'No signal on any leg: not tradable on DexScreener (or no launch time), no proven-winner buys in the window, no agent attention. Nothing here says "look closer."';
  }
  const parts: string[] = [];
  if (smart) {
    const holders = smart.conviction_holder_buyers > 0 ? ` (${smart.conviction_holder_buyers} conviction holder${smart.conviction_holder_buyers > 1 ? 's' : ''})` : '';
    parts.push(`${smart.smart_buyers} proven-winner wallet${smart.smart_buyers > 1 ? 's' : ''}${holders} bought, latest ${smart.most_recent_buy_minutes_ago}m ago`);
  }
  if (runner) {
    parts.push(`on-chain ${runner.stage} (runner score ${runner.runner_score})`);
    if (runner.flags.length > 0) parts.push(`flags: ${runner.flags.join(', ')}`);
  }
  if (attention) {
    parts.push(
      `agent attention: ${attention.queries_6h} queries/6h, ${attention.rising ? 'rising' : 'not rising'} (top ${100 - attention.percentile}% of queried tokens)`,
    );
  }
  const missing: string[] = [];
  if (!smart) missing.push('no proven-winner buys');
  if (!runner) missing.push('no on-chain velocity read');
  if (!attention) missing.push('no agent attention');
  if (missing.length > 0) parts.push(`absent: ${missing.join(', ')}`);
  return parts.join('; ') + '.';
}
