import type { Cache } from '../cache';
import { CACHE_TTL } from '../config';
import { formatTimestamp } from '../utils/normalize';
import type { RunnerDetector } from './runner-detector';
import type { RunnerStage } from './runner-score';
import type { TrenchesSmartMoneyAnalyzer } from './trenches-smart-money';
import type { SignalTracker, AttentionDirection, Divergence } from './signal-tracker';

// --- Types ---

export type TrenchesVerdict = 'HIGH_CONFLUENCE' | 'MODERATE' | 'SINGLE_SIGNAL';

export interface TrenchesScanPick {
  mint: string;
  symbol: string | null;
  name: string | null;
  age_hours: number | null;
  /** 0-1 weighted blend: runner 0.45, smart-money 0.45, attention 0.10. */
  composite_score: number;
  /** How many of the three legs surfaced this token (1-3). */
  confluence: number;
  verdict: TrenchesVerdict;
  runner: {
    stage: RunnerStage;
    runner_score: number;
    volume_h1_usd: number;
    price_change_h1_pct: number;
    buys_h1: number;
    sells_h1: number;
    flags: string[];
  } | null;
  smart_money: {
    smart_buyers: number;
    conviction_holder_buyers: number;
    total_spent_usd: number;
    most_recent_buy_minutes_ago: number;
  } | null;
  attention: {
    queries_current: number;
    acceleration: number;
    attention: AttentionDirection;
    divergence: Divergence | null;
  } | null;
  liquidity_usd: number | null;
  market_cap_usd: number | null;
  price_usd: number | null;
  reasoning: string;
}

export interface TrenchesScanResult {
  picks: TrenchesScanPick[];
  confluence_counts: { triple: number; double: number; single: number };
  legs: {
    runner: { ok: boolean; candidates_scanned: number; passed_filters: number; error: string | null };
    smart_money: { ok: boolean; seeds_scanned: number; total_recent_buys: number; error: string | null };
    attention: { ok: boolean; total_queries: number; sample_quality: string | null; error: string | null };
  };
  filters: { max_token_age_hours: number; min_liquidity_usd: number; limit: number };
  caveats: string[];
  last_updated: string;
}

// --- Scoring weights (shared with trenches-check) ---

export const W_RUNNER = 0.45;
export const W_SMART = 0.45;
export const W_ATTENTION = 0.10;

/** smart_buyers → 0-1: one proven winner is a lead, three is consensus. */
export function smartComponent(buyers: number): number {
  return Math.min(buyers / 3, 1);
}

export function attentionComponent(dir: AttentionDirection): number {
  return dir === 'accelerating' ? 1 : dir === 'rising' ? 0.6 : 0.2;
}

// --- Class ---

/**
 * `trenches-scan` — the three-signal memecoin orchestrator (the trenches
 * `trending-signals`). One call composes:
 *
 *   - runner-scan        → WHAT the token is doing (on-chain velocity)
 *   - smart-money-trenches → WHO is buying (proven-winner wallets)
 *   - attention-momentum → who is RESEARCHING it (agent query stream)
 *
 * Universe = union of the runner and smart-money legs; attention only overlays
 * (a token queried by agents but showing no on-chain or smart-money signal is
 * not an ape candidate). Legs degrade independently — one upstream failure
 * annotates the response instead of killing it.
 */
export class TrenchesScanOrchestrator {
  constructor(
    private runner: RunnerDetector,
    private smartMoney: TrenchesSmartMoneyAnalyzer,
    private signals: SignalTracker,
    private cache: Cache,
  ) {}

  async scan(
    maxTokenAgeHours: number,
    minLiquidityUsd: number,
    limit: number,
  ): Promise<TrenchesScanResult> {
    const cacheKey = `trenches:scan:${maxTokenAgeHours}:${minLiquidityUsd}:${limit}`;
    const cached = await this.cache.get<TrenchesScanResult>(cacheKey);
    if (cached) return cached;

    // Three legs in parallel. Runner leg uses a lower volume floor than the
    // standalone endpoint — confluence with other legs replaces the filter.
    const [runnerLeg, smartLeg, attentionLeg] = await Promise.allSettled([
      this.runner.scan(maxTokenAgeHours, minLiquidityUsd, 1_000, 25),
      this.smartMoney.enrich(12, Math.min(maxTokenAgeHours, 72), 1, 25),
      this.signals.getMomentum('6h', 50),
    ]);

    const runnerData = runnerLeg.status === 'fulfilled' ? runnerLeg.value : null;
    const smartData = smartLeg.status === 'fulfilled' ? smartLeg.value : null;
    const attentionData = attentionLeg.status === 'fulfilled' ? attentionLeg.value : null;

    // Index each leg by mint
    const runnerByMint = new Map((runnerData?.runners ?? []).map((r) => [r.mint, r]));
    const smartByMint = new Map((smartData?.signals ?? []).map((s) => [s.mint, s]));
    const attentionByMint = new Map((attentionData?.entries ?? []).map((e) => [e.address, e]));

    const universe = new Set<string>([...runnerByMint.keys(), ...smartByMint.keys()]);

    const picks: TrenchesScanPick[] = [];
    for (const mint of universe) {
      const r = runnerByMint.get(mint);
      const s = smartByMint.get(mint);
      const a = attentionByMint.get(mint);

      // Liquidity floor for smart-money-only tokens (runner leg already filters).
      // Unknown liquidity passes — very fresh launches often have no pair data yet.
      const liquidity = r?.liquidity_usd ?? s?.liquidity_usd ?? null;
      if (!r && liquidity != null && liquidity < minLiquidityUsd) continue;

      const runnerScore = r ? r.runner_score * W_RUNNER : 0;
      const smartScore = s ? smartComponent(s.smart_buyers) * W_SMART : 0;
      const attnScore = a ? attentionComponent(a.attention) * W_ATTENTION : 0;
      const composite = Math.round((runnerScore + smartScore + attnScore) * 100) / 100;

      const confluence = (r ? 1 : 0) + (s ? 1 : 0) + (a ? 1 : 0);
      const verdict: TrenchesVerdict =
        confluence >= 2 && composite >= 0.5 ? 'HIGH_CONFLUENCE'
        : confluence >= 2 || composite >= 0.5 ? 'MODERATE'
        : 'SINGLE_SIGNAL';

      picks.push({
        mint,
        symbol: r?.symbol ?? s?.symbol ?? a?.symbol ?? null,
        name: r?.name ?? a?.name ?? null,
        age_hours: r?.age_hours ?? s?.token_age_hours ?? null,
        composite_score: composite,
        confluence,
        verdict,
        runner: r
          ? {
              stage: r.stage,
              runner_score: r.runner_score,
              volume_h1_usd: r.volume_h1_usd,
              price_change_h1_pct: r.price_change_h1_pct,
              buys_h1: r.buys_h1,
              sells_h1: r.sells_h1,
              flags: r.flags,
            }
          : null,
        smart_money: s
          ? {
              smart_buyers: s.smart_buyers,
              conviction_holder_buyers: s.conviction_holder_buyers,
              total_spent_usd: s.total_spent_usd,
              most_recent_buy_minutes_ago: s.most_recent_buy_minutes_ago,
            }
          : null,
        attention: a
          ? {
              queries_current: a.queries.current,
              acceleration: a.acceleration,
              attention: a.attention,
              divergence: a.divergence,
            }
          : null,
        liquidity_usd: liquidity,
        market_cap_usd: r?.market_cap_usd ?? s?.market_cap_usd ?? null,
        price_usd: r?.price_usd ?? s?.price_usd ?? null,
        reasoning: buildReasoning(r, s, a),
      });
    }

    picks.sort(
      (x, y) =>
        y.confluence - x.confluence ||
        y.composite_score - x.composite_score ||
        (y.runner?.volume_h1_usd ?? 0) - (x.runner?.volume_h1_usd ?? 0),
    );
    const ranked = picks.slice(0, limit);

    const confluence_counts = {
      triple: picks.filter((p) => p.confluence === 3).length,
      double: picks.filter((p) => p.confluence === 2).length,
      single: picks.filter((p) => p.confluence === 1).length,
    };

    const result: TrenchesScanResult = {
      picks: ranked,
      confluence_counts,
      legs: {
        runner: {
          ok: runnerData != null,
          candidates_scanned: runnerData?.candidates_scanned ?? 0,
          passed_filters: runnerData?.passed_filters ?? 0,
          error: runnerLeg.status === 'rejected' ? String(runnerLeg.reason?.message ?? runnerLeg.reason) : null,
        },
        smart_money: {
          ok: smartData != null,
          seeds_scanned: smartData?.seeds_scanned ?? 0,
          total_recent_buys: smartData?.total_recent_buys ?? 0,
          error: smartLeg.status === 'rejected' ? String(smartLeg.reason?.message ?? smartLeg.reason) : null,
        },
        attention: {
          ok: attentionData != null,
          total_queries: attentionData?.aggregate.total_queries_current_window ?? 0,
          sample_quality: attentionData?.aggregate.sample_quality ?? null,
          error: attentionLeg.status === 'rejected' ? String(attentionLeg.reason?.message ?? attentionLeg.reason) : null,
        },
      },
      filters: { max_token_age_hours: maxTokenAgeHours, min_liquidity_usd: minLiquidityUsd, limit },
      caveats: buildCaveats(runnerData != null, smartData != null, attentionData != null),
      last_updated: formatTimestamp(),
    };

    await this.cache.set(cacheKey, result, CACHE_TTL.trenchesScan);
    return result;
  }
}

// --- Pure helpers ---

function buildReasoning(
  r: { stage: RunnerStage; runner_score: number; flags: string[] } | undefined,
  s: { smart_buyers: number; conviction_holder_buyers: number; most_recent_buy_minutes_ago: number } | undefined,
  a: { attention: AttentionDirection; divergence: Divergence | null } | undefined,
): string {
  const parts: string[] = [];
  if (s) {
    const holders = s.conviction_holder_buyers > 0 ? ` (${s.conviction_holder_buyers} conviction holder${s.conviction_holder_buyers > 1 ? 's' : ''})` : '';
    parts.push(
      `${s.smart_buyers} proven-winner wallet${s.smart_buyers > 1 ? 's' : ''}${holders} bought, latest ${s.most_recent_buy_minutes_ago}m ago`,
    );
  }
  if (r) {
    parts.push(`on-chain ${r.stage} (runner score ${r.runner_score})`);
    if (r.flags?.length > 0) parts.push(`flags: ${r.flags.join(', ')}`);
  }
  if (a) {
    parts.push(`agent attention ${a.attention}${a.divergence ? ` → ${a.divergence}` : ''}`);
  }
  const legCount = (r ? 1 : 0) + (s ? 1 : 0) + (a ? 1 : 0);
  const prefix =
    legCount === 3 ? 'TRIPLE CONFLUENCE: ' : legCount === 2 ? 'Double confluence: ' : '';
  return prefix + parts.join('; ') + '.';
}

function buildCaveats(runnerOk: boolean, smartOk: boolean, attentionOk: boolean): string[] {
  const caveats = [
    'Composite ranking, not a buy list. Fresh memecoin outcomes are binary — most candidates still fail; the edge is confluence and avoiding obvious dumps. Not financial advice.',
    'Runner stage PARABOLIC_LATE or FADING on a pick means the move may already be over — confluence there describes what happened, not what is next.',
    'Attention leg is derived from SolEnrich\'s own agent query stream; it is sparse at current traffic and contributes at most 10% of the composite.',
  ];
  if (!runnerOk) caveats.unshift('Runner leg FAILED this scan — composite scores omit on-chain velocity.');
  if (!smartOk) caveats.unshift('Smart-money leg FAILED this scan — composite scores omit proven-winner buys.');
  if (!attentionOk) caveats.unshift('Attention leg FAILED this scan.');
  return caveats;
}
