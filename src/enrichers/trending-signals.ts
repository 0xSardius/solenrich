import type { Cache } from '../cache';
import type { TokenDiscovery, DiscoveredToken } from './token-discovery';
import type { WhaleWatcher, WhaleWatchEnrichment } from './whale-watch';
import { CACHE_TTL } from '../config';
import { formatTimestamp } from '../utils/normalize';

export interface TrendingTokenSignal {
  mint: string;
  symbol: string;
  name: string;
  price_usd: number;
  market_cap: number;
  liquidity: number;
  volume_24h: number;
  risk_score: number;
  risk_level: string;
  risk_flags: string[];
  verified: boolean;
  holder_count: number;
  concentration_hhi: number | null;
  // Whale signal (optional, set when include_whale_watch=true)
  whale_net_flow?: 'accumulating' | 'distributing' | 'neutral';
  whale_count?: number;
  total_whale_volume_usd?: number;
  // Composite signal (0-1, higher = more worth paying attention)
  composite_signal: number;
  // Human-readable reasoning for why this token ranked where it did
  reasoning: string[];
  recommendation: 'SAFE' | 'CAUTION' | 'RISKY';
}

export interface TrendingSignalsResult {
  tokens: TrendingTokenSignal[];
  total_scanned: number;
  filters: {
    min_liquidity_usd: number;
    max_risk_score: number;
    limit: number;
    include_whale_watch: boolean;
  };
  overall_sentiment: 'accumulation' | 'distribution' | 'mixed';
  last_updated: string;
}

/**
 * Orchestrates TokenDiscovery (DexScreener trending + enrichment + risk) with
 * WhaleWatcher (top-holder flow signal) to produce a ranked list of tokens
 * worth paying attention to RIGHT NOW. Composite signal weights:
 *   - liquidity health (more liq = more reliable data)
 *   - risk score (inverted — lower risk ranks higher)
 *   - whale accumulation (when enabled)
 *   - holder concentration (lower HHI = healthier)
 */
export class TrendingSignalsAnalyzer {
  constructor(
    private tokenDiscovery: TokenDiscovery,
    private whaleWatcher: WhaleWatcher,
    private cache: Cache,
  ) {}

  async enrich(
    minLiquidityUsd: number,
    maxRiskScore: number,
    limit: number,
    includeWhaleWatch: boolean,
  ): Promise<TrendingSignalsResult> {
    const cacheKey = `trending-signals:${minLiquidityUsd}:${maxRiskScore}:${limit}:${includeWhaleWatch}`;
    const cached = await this.cache.get<TrendingSignalsResult>(cacheKey);
    if (cached) return cached;

    // Step 1: Discover candidates via existing TokenDiscovery.
    // We over-fetch by 2x so we have headroom after whale enrichment filtering.
    const discovery = await this.tokenDiscovery.discover(
      minLiquidityUsd,
      maxRiskScore,
      Math.min(limit * 2, 20),
    );

    if (discovery.tokens.length === 0) {
      const out: TrendingSignalsResult = {
        tokens: [],
        total_scanned: discovery.total_scanned,
        filters: { min_liquidity_usd: minLiquidityUsd, max_risk_score: maxRiskScore, limit, include_whale_watch: includeWhaleWatch },
        overall_sentiment: 'mixed',
        last_updated: formatTimestamp(),
      };
      await this.cache.set(cacheKey, out, CACHE_TTL.whaleWatch); // 5 min — trending shifts fast
      return out;
    }

    // Step 2: Optionally layer whale-watch signal per token (parallel, batches of 3).
    const whaleByMint = new Map<string, WhaleWatchEnrichment>();
    if (includeWhaleWatch) {
      const mints = discovery.tokens.map(t => t.mint);
      for (let i = 0; i < mints.length; i += 3) {
        const batch = mints.slice(i, i + 3);
        const results = await Promise.allSettled(
          batch.map(m => this.whaleWatcher.enrich(m, 10_000, 24)),
        );
        for (const r of results) {
          if (r.status === 'fulfilled') whaleByMint.set(r.value.mint, r.value);
        }
      }
    }

    // Step 3: Compose signals + rank.
    const signals: TrendingTokenSignal[] = discovery.tokens.map(t => {
      const w = whaleByMint.get(t.mint);
      const signal = buildSignal(t, w);
      return signal;
    });

    signals.sort((a, b) => b.composite_signal - a.composite_signal);
    const top = signals.slice(0, limit);

    // Step 4: Aggregate sentiment.
    const overall_sentiment = computeOverallSentiment(top);

    const out: TrendingSignalsResult = {
      tokens: top,
      total_scanned: discovery.total_scanned,
      filters: {
        min_liquidity_usd: minLiquidityUsd,
        max_risk_score: maxRiskScore,
        limit,
        include_whale_watch: includeWhaleWatch,
      },
      overall_sentiment,
      last_updated: formatTimestamp(),
    };
    await this.cache.set(cacheKey, out, CACHE_TTL.whaleWatch);
    return out;
  }
}

// --- Ranking helpers ---

function buildSignal(t: DiscoveredToken, w?: WhaleWatchEnrichment): TrendingTokenSignal {
  const reasoning: string[] = [];

  // 1. Inverted risk score — low risk is good
  const riskSignal = 1 - t.risk_score; // 0 (bad) → 1 (good)
  if (t.risk_score < 0.3) reasoning.push(`low risk (score ${t.risk_score.toFixed(2)})`);
  else if (t.risk_score < 0.5) reasoning.push(`moderate risk (score ${t.risk_score.toFixed(2)})`);

  // 2. Liquidity health — log-scale, normalized to 0-1 (caps at $1M)
  const liqSignal = Math.min(1, Math.log10(Math.max(t.liquidity, 1)) / 6);
  if (t.liquidity > 100_000) reasoning.push(`healthy liquidity ($${Math.round(t.liquidity / 1000)}k)`);
  else if (t.liquidity > 10_000) reasoning.push(`thin liquidity ($${Math.round(t.liquidity / 1000)}k)`);

  // 3. Holder concentration — inverted HHI, normalized (<2500 = good, >5000 = concerning)
  let concSignal = 0.5;
  if (t.concentration_hhi !== null) {
    concSignal = Math.max(0, Math.min(1, (10_000 - t.concentration_hhi) / 10_000));
    if (t.concentration_hhi < 2500) reasoning.push('well-distributed holders');
    else if (t.concentration_hhi > 5000) reasoning.push(`whale-dominated (HHI ${t.concentration_hhi})`);
  }

  // 4. Whale signal — accumulation is +, distribution is -
  let whaleSignal = 0.5; // neutral default
  if (w) {
    if (w.net_flow_direction === 'accumulating') {
      whaleSignal = 0.85;
      reasoning.push(`${w.whale_count} whales accumulating`);
    } else if (w.net_flow_direction === 'distributing') {
      whaleSignal = 0.2;
      reasoning.push(`${w.whale_count} whales distributing`);
    } else {
      whaleSignal = 0.5;
      if (w.whale_count > 0) reasoning.push(`${w.whale_count} whales neutral`);
    }
  }

  // Weighted composite — risk 40%, liquidity 20%, concentration 15%, whale 25%
  const composite =
    riskSignal * 0.4 + liqSignal * 0.2 + concSignal * 0.15 + whaleSignal * 0.25;

  return {
    mint: t.mint,
    symbol: t.symbol,
    name: t.name,
    price_usd: t.price_usd,
    market_cap: t.market_cap,
    liquidity: t.liquidity,
    volume_24h: t.volume_24h,
    risk_score: t.risk_score,
    risk_level: t.risk_level,
    risk_flags: t.risk_flags,
    verified: t.verified,
    holder_count: t.holder_count,
    concentration_hhi: t.concentration_hhi,
    whale_net_flow: w?.net_flow_direction,
    whale_count: w?.whale_count,
    total_whale_volume_usd: w?.total_whale_volume_usd,
    composite_signal: Math.round(composite * 10_000) / 10_000,
    reasoning,
    recommendation: t.recommendation,
  };
}

function computeOverallSentiment(tokens: TrendingTokenSignal[]): 'accumulation' | 'distribution' | 'mixed' {
  if (tokens.length === 0) return 'mixed';
  let acc = 0;
  let dist = 0;
  for (const t of tokens) {
    if (t.whale_net_flow === 'accumulating') acc++;
    else if (t.whale_net_flow === 'distributing') dist++;
  }
  const total = acc + dist;
  if (total === 0) return 'mixed';
  if (acc / total > 0.6) return 'accumulation';
  if (dist / total > 0.6) return 'distribution';
  return 'mixed';
}
