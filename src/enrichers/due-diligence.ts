import type { TokenAnalyzer } from './token-analyzer';
import type { WhaleWatcher } from './whale-watch';
import type { Cache } from '../cache';
import { CACHE_TTL } from '../config';
import { formatTimestamp } from '../utils/normalize';
import { parallelFetch, type ParallelTask } from '../utils/parallel';
import { scoreTokenRisk, type RiskLevel } from './risk-scorer';
import type { TokenEnrichment } from './token-analyzer';
import type { WhaleWatchEnrichment } from './whale-watch';

export interface DueDiligenceEnrichment {
  token: TokenEnrichment;
  whales: WhaleWatchEnrichment;
  overall_risk_score: number;
  risk_level: RiskLevel;
  risk_factors: string[];
  recommendation: 'SAFE' | 'CAUTION' | 'RISKY';
  last_updated: string;
}

export class DueDiligenceAnalyzer {
  constructor(
    private tokenAnalyzer: TokenAnalyzer,
    private whaleWatcher: WhaleWatcher,
    private cache: Cache,
  ) {}

  async enrich(mint: string): Promise<DueDiligenceEnrichment> {
    const cacheKey = `duediligence:${mint}`;
    const cached = await this.cache.get<DueDiligenceEnrichment>(cacheKey);
    if (cached) return cached;

    // Run sub-analyses in parallel
    const tasks: ParallelTask<any>[] = [
      { name: 'token', fn: () => this.tokenAnalyzer.enrich(mint, true) },
      { name: 'whales', fn: () => this.whaleWatcher.enrich(mint, 10000, 72) },
    ];
    const fetched = await parallelFetch(tasks, 15000);

    const token = fetched.token as TokenEnrichment | null;
    const whales = fetched.whales as WhaleWatchEnrichment | null;

    if (!token) throw new Error('Token analysis failed');

    // Use centralized token risk scorer
    const riskResult = scoreTokenRisk({
      risk_flags_count: token.risk_flags.length,
      verified: token.verified,
      mint_authority_active: token.mint_authority !== null,
      freeze_authority_active: token.freeze_authority !== null,
      liquidity: token.liquidity,
      holder_concentration_top1: token.concentration?.top1_pct,
      holder_concentration_top5: token.concentration?.top5_pct,
      herfindahl_index: token.concentration?.herfindahl_index,
      whale_distributing: whales?.net_flow_direction === 'distributing',
    });

    const recommendation: DueDiligenceEnrichment['recommendation'] =
      riskResult.score > 0.6 ? 'RISKY' :
      riskResult.score > 0.3 ? 'CAUTION' : 'SAFE';

    // Default whale data if whale watch failed
    const whaleData: WhaleWatchEnrichment = whales ?? {
      mint,
      threshold_usd: 10000,
      lookback_hours: 72,
      whales: [],
      total_whale_volume_usd: 0,
      net_flow_direction: 'neutral',
      whale_count: 0,
      last_updated: formatTimestamp(),
    };

    const enrichment: DueDiligenceEnrichment = {
      token,
      whales: whaleData,
      overall_risk_score: riskResult.score,
      risk_level: riskResult.risk_level,
      risk_factors: riskResult.factors,
      recommendation,
      last_updated: formatTimestamp(),
    };

    await this.cache.set(cacheKey, enrichment, CACHE_TTL.dueDiligence);
    return enrichment;
  }
}
