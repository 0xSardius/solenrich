import type { DexScreenerClient, DexPair } from '../sources/dexscreener';
import type { BirdeyeClient } from '../sources/birdeye';
import type { Cache } from '../cache';
import { CACHE_TTL } from '../config';
import { formatTimestamp } from '../utils/normalize';
import { assessRunner, type RunnerStage, type RunnerMetrics } from './runner-score';

// --- Types ---

export interface RunnerCandidate {
  mint: string;
  symbol: string | null;
  name: string | null;
  age_hours: number;
  price_usd: number;
  market_cap_usd: number;
  liquidity_usd: number;
  volume_h1_usd: number;
  volume_h24_usd: number;
  price_change_h1_pct: number;
  price_change_h24_pct: number;
  buys_h1: number;
  sells_h1: number;
  stage: RunnerStage;
  runner_score: number;
  metrics: RunnerMetrics;
  flags: string[];
  reasoning: string;
  /** Minutes since the prior snapshot the liquidity/holder deltas are measured against. Null on first sight. */
  delta_window_minutes: number | null;
}

export interface RunnerScanResult {
  runners: RunnerCandidate[];
  candidates_scanned: number;
  passed_filters: number;
  stage_counts: Record<RunnerStage, number>;
  filters: {
    max_token_age_hours: number;
    min_liquidity_usd: number;
    min_volume_h1_usd: number;
    limit: number;
  };
  /** Where the candidate pool came from, and what that biases it toward. */
  candidate_source: string;
  caveats: string[];
  last_updated: string;
}

interface Snapshot {
  t: number;
  liquidity_usd: number;
  holder_count: number | null;
}

/** Aggregated per-mint view of all its DexScreener pairs. */
interface Aggregated {
  mint: string;
  symbol: string | null;
  name: string | null;
  price_usd: number;
  market_cap_usd: number;
  liquidity_usd: number;
  age_hours: number | null;
  volume: { m5: number; h1: number; h6: number; h24: number };
  price_change: { m5: number; h1: number; h6: number; h24: number };
  txns: {
    m5: { buys: number; sells: number };
    h1: { buys: number; sells: number };
    h6: { buys: number; sells: number };
    h24: { buys: number; sells: number };
  };
}

// --- Constants ---

/** Only refresh a mint's snapshot once the prior is this old — otherwise back-to-back
 *  scans would compare across seconds and report meaningless ~0% deltas. */
const MIN_SNAPSHOT_AGE_MS = 5 * 60_000;
/** Snapshots are only useful inside the runner window; let them expire. */
const SNAPSHOT_TTL_S = 7200;
/** Birdeye free tier is ~1 rps — only spend holder lookups on the strongest candidates. */
const HOLDER_LOOKUP_CAP = 6;

const EMPTY_STAGE_COUNTS = (): Record<RunnerStage, number> => ({
  IGNITING: 0,
  RUNNING: 0,
  PARABOLIC_LATE: 0,
  FADING: 0,
  QUIET: 0,
});

// --- Class ---

/**
 * `runner-scan` — the "WHAT is the token doing" half of runner detection
 * (docs/runner-detection-scope.md). Reads the on-chain wake of a run in
 * progress: accelerating buy rate, buy pressure, volume and price velocity,
 * holder growth, liquidity trend.
 *
 * Deliberately NOT a block-0 sniper. The lane is seconds-to-minutes pre-ape;
 * sub-second detection needs Geyser streams and is a different product.
 */
export class RunnerDetector {
  constructor(
    private dexscreener: DexScreenerClient,
    private cache: Cache,
    private birdeye?: BirdeyeClient,
  ) {}

  async scan(
    maxTokenAgeHours: number,
    minLiquidityUsd: number,
    minVolumeH1Usd: number,
    limit: number,
  ): Promise<RunnerScanResult> {
    const cacheKey = `runner:scan:${maxTokenAgeHours}:${minLiquidityUsd}:${minVolumeH1Usd}:${limit}`;
    const cached = await this.cache.get<RunnerScanResult>(cacheKey);
    if (cached) return cached;

    const candidateSource =
      'DexScreener latest profiles + latest boosts + top boosts (Solana). These surfaces are pay-to-appear, so the pool skews toward promoted tokens rather than every fresh launch.';

    // Step 1: candidate universe → batched pair data (2 calls for ~45 mints)
    const mints = await this.dexscreener.getTrendingCandidates();
    if (mints.length === 0) {
      return this.empty(maxTokenAgeHours, minLiquidityUsd, minVolumeH1Usd, limit, candidateSource, 0);
    }

    const pairs = await this.dexscreener.getPairsBatch(mints);
    const aggregated = aggregatePairs(pairs);

    // Step 2: filter to the tradeable, fresh, actually-moving subset
    const survivors = aggregated.filter(
      (a) =>
        a.age_hours != null &&
        a.age_hours <= maxTokenAgeHours &&
        a.liquidity_usd >= minLiquidityUsd &&
        a.volume.h1 >= minVolumeH1Usd,
    );

    if (survivors.length === 0) {
      return this.empty(
        maxTokenAgeHours, minLiquidityUsd, minVolumeH1Usd, limit, candidateSource, aggregated.length,
      );
    }

    // Step 3: prior snapshots → liquidity trend (free; we already have liquidity)
    const priors = new Map<string, Snapshot | null>();
    await Promise.all(
      survivors.map(async (s) => {
        priors.set(s.mint, await this.cache.get<Snapshot>(`runner:snap:${s.mint}`).catch(() => null));
      }),
    );

    // Step 4: holder counts for the strongest candidates only. Ordering by 1h
    // volume is a cheap proxy for "worth a Birdeye call" before scoring exists.
    const holderTargets = [...survivors]
      .sort((a, b) => b.volume.h1 - a.volume.h1)
      .slice(0, HOLDER_LOOKUP_CAP)
      .map((s) => s.mint);
    const holderCounts = await this.fetchHolderCounts(holderTargets);

    // Step 5: score
    const now = Date.now();
    const runners: RunnerCandidate[] = survivors.map((a) => {
      const prior = priors.get(a.mint) ?? null;
      const priorAgeMs = prior ? now - prior.t : null;
      // Deltas are only meaningful over a real interval.
      const useDelta = prior != null && priorAgeMs != null && priorAgeMs >= MIN_SNAPSHOT_AGE_MS;

      const liquidity_change_pct =
        useDelta && prior!.liquidity_usd > 0
          ? ((a.liquidity_usd - prior!.liquidity_usd) / prior!.liquidity_usd) * 100
          : null;

      const holderNow = holderCounts.get(a.mint) ?? null;
      const holder_growth_pct =
        useDelta && holderNow != null && prior!.holder_count != null && prior!.holder_count > 0
          ? ((holderNow - prior!.holder_count) / prior!.holder_count) * 100
          : null;

      const assessment = assessRunner({
        txns: a.txns,
        volume: a.volume,
        price_change: a.price_change,
        liquidity_usd: a.liquidity_usd,
        age_hours: a.age_hours!,
        liquidity_change_pct:
          liquidity_change_pct != null ? Math.round(liquidity_change_pct * 10) / 10 : null,
        holder_growth_pct:
          holder_growth_pct != null ? Math.round(holder_growth_pct * 10) / 10 : null,
      });

      return {
        mint: a.mint,
        symbol: a.symbol,
        name: a.name,
        age_hours: Math.round(a.age_hours! * 10) / 10,
        price_usd: a.price_usd,
        market_cap_usd: Math.round(a.market_cap_usd),
        liquidity_usd: Math.round(a.liquidity_usd),
        volume_h1_usd: Math.round(a.volume.h1),
        volume_h24_usd: Math.round(a.volume.h24),
        price_change_h1_pct: a.price_change.h1,
        price_change_h24_pct: a.price_change.h24,
        buys_h1: a.txns.h1.buys,
        sells_h1: a.txns.h1.sells,
        stage: assessment.stage,
        runner_score: assessment.runner_score,
        metrics: assessment.metrics,
        flags: assessment.flags,
        reasoning: assessment.reasoning,
        delta_window_minutes: useDelta ? Math.round(priorAgeMs! / 60_000) : null,
      };
    });

    // Step 6: refresh snapshots (only where the prior has aged out) so the NEXT
    // scan has a meaningful baseline. Fire-and-forget — never block the response.
    for (const a of survivors) {
      const prior = priors.get(a.mint) ?? null;
      if (prior != null && now - prior.t < MIN_SNAPSHOT_AGE_MS) continue;
      // Deliberately no carry-forward of a prior holder count: pairing a stale
      // count with a fresh timestamp would understate the next scan's growth
      // window. A token outside the Birdeye lookup cap simply has no holder
      // history, which is honest.
      const snap: Snapshot = {
        t: now,
        liquidity_usd: a.liquidity_usd,
        holder_count: holderCounts.get(a.mint) ?? null,
      };
      this.cache
        .set(`runner:snap:${a.mint}`, snap, SNAPSHOT_TTL_S)
        .catch((err) => console.warn(`[runner-scan] snapshot write failed for ${a.mint}: ${err}`));
    }

    const ranked = runners
      .sort((x, y) => y.runner_score - x.runner_score || y.volume_h1_usd - x.volume_h1_usd)
      .slice(0, limit);

    const stage_counts = EMPTY_STAGE_COUNTS();
    for (const r of runners) stage_counts[r.stage]++;

    const result: RunnerScanResult = {
      runners: ranked,
      candidates_scanned: aggregated.length,
      passed_filters: survivors.length,
      stage_counts,
      filters: {
        max_token_age_hours: maxTokenAgeHours,
        min_liquidity_usd: minLiquidityUsd,
        min_volume_h1_usd: minVolumeH1Usd,
        limit,
      },
      candidate_source: candidateSource,
      caveats: buildCaveats(runners, this.birdeye != null),
      last_updated: formatTimestamp(),
    };

    await this.cache.set(cacheKey, result, CACHE_TTL.runnerScan);
    return result;
  }

  /** Birdeye holder counts, best-effort. Failures degrade to null, never throw. */
  private async fetchHolderCounts(mints: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!this.birdeye || mints.length === 0) return out;

    // Small batches — the free tier rate-limits aggressively and holder growth is
    // a bonus signal, not the core of the score.
    for (let i = 0; i < mints.length; i += 3) {
      const batch = mints.slice(i, i + 3);
      const settled = await Promise.allSettled(
        batch.map((m) => this.birdeye!.getTokenOverview(m)),
      );
      for (let j = 0; j < batch.length; j++) {
        const r = settled[j];
        if (r.status === 'fulfilled' && typeof r.value?.holder === 'number' && r.value.holder > 0) {
          out.set(batch[j], r.value.holder);
        }
      }
    }
    return out;
  }

  private empty(
    maxTokenAgeHours: number,
    minLiquidityUsd: number,
    minVolumeH1Usd: number,
    limit: number,
    candidateSource: string,
    scanned: number,
  ): RunnerScanResult {
    return {
      runners: [],
      candidates_scanned: scanned,
      passed_filters: 0,
      stage_counts: EMPTY_STAGE_COUNTS(),
      filters: {
        max_token_age_hours: maxTokenAgeHours,
        min_liquidity_usd: minLiquidityUsd,
        min_volume_h1_usd: minVolumeH1Usd,
        limit,
      },
      candidate_source: candidateSource,
      caveats: [
        'No candidate cleared the filters this scan. A quiet trenches is itself information — try widening max_token_age_hours or lowering min_liquidity_usd.',
      ],
      last_updated: formatTimestamp(),
    };
  }
}

// --- Pure aggregation ---

function aggregatePairs(pairs: DexPair[]): Aggregated[] {
  const byMint = new Map<string, DexPair[]>();
  for (const p of pairs) {
    const mint = p.baseToken?.address;
    if (!mint) continue;
    if (!byMint.has(mint)) byMint.set(mint, []);
    byMint.get(mint)!.push(p);
  }

  const out: Aggregated[] = [];
  for (const [mint, ps] of byMint) {
    // Percentages and price can't be summed — take them from the deepest pair.
    const primary = [...ps].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    const sum = (fn: (p: DexPair) => number) => ps.reduce((s, p) => s + (fn(p) || 0), 0);

    const created = ps
      .map((p) => p.pairCreatedAt)
      .filter((t): t is number => typeof t === 'number' && t > 0);

    out.push({
      mint,
      symbol: primary.baseToken?.symbol ?? null,
      name: primary.baseToken?.name ?? null,
      price_usd: parseFloat(primary.priceUsd) || 0,
      market_cap_usd: primary.marketCap ?? primary.fdv ?? 0,
      liquidity_usd: sum((p) => p.liquidity?.usd ?? 0),
      age_hours: created.length > 0 ? (Date.now() - Math.min(...created)) / 3_600_000 : null,
      volume: {
        m5: sum((p) => p.volume?.m5 ?? 0),
        h1: sum((p) => p.volume?.h1 ?? 0),
        h6: sum((p) => p.volume?.h6 ?? 0),
        h24: sum((p) => p.volume?.h24 ?? 0),
      },
      price_change: {
        m5: primary.priceChange?.m5 ?? 0,
        h1: primary.priceChange?.h1 ?? 0,
        h6: primary.priceChange?.h6 ?? 0,
        h24: primary.priceChange?.h24 ?? 0,
      },
      txns: {
        m5: { buys: sum((p) => p.txns?.m5?.buys ?? 0), sells: sum((p) => p.txns?.m5?.sells ?? 0) },
        h1: { buys: sum((p) => p.txns?.h1?.buys ?? 0), sells: sum((p) => p.txns?.h1?.sells ?? 0) },
        h6: { buys: sum((p) => p.txns?.h6?.buys ?? 0), sells: sum((p) => p.txns?.h6?.sells ?? 0) },
        h24: { buys: sum((p) => p.txns?.h24?.buys ?? 0), sells: sum((p) => p.txns?.h24?.sells ?? 0) },
      },
    });
  }
  return out;
}

function buildCaveats(runners: RunnerCandidate[], hasBirdeye: boolean): string[] {
  const caveats = [
    'Detection lane is seconds-to-minutes pre-ape, not block-0. Anything already parabolic is flagged LATE rather than presented as an entry.',
    'DexScreener transaction counts are gameable — wash-traded tokens are flagged via average trade size, but the flag is a heuristic, not proof.',
    'Fresh memecoin outcomes are binary. Most flagged tokens still fail; the value is avoiding obvious dumps and catching the occasional runner early. Not financial advice.',
  ];
  if (runners.every((r) => r.delta_window_minutes == null)) {
    caveats.push(
      'No prior snapshot existed for any candidate, so holder-growth and liquidity-trend are null this scan. These fill in on repeat scans of the same token (5+ minutes apart).',
    );
  }
  if (!hasBirdeye) {
    caveats.push('Holder growth unavailable — no Birdeye key configured on this deployment.');
  }
  return caveats;
}
