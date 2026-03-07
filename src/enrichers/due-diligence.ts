import type { TokenAnalyzer } from './token-analyzer';
import type { WhaleWatcher } from './whale-watch';
import type { Cache } from '../cache';
import { CACHE_TTL } from '../config';
import { formatTimestamp } from '../utils/normalize';
import { parallelFetch, type ParallelTask } from '../utils/parallel';
import type { TokenEnrichment } from './token-analyzer';
import type { WhaleWatchEnrichment } from './whale-watch';

export interface DueDiligenceEnrichment {
  token: TokenEnrichment;
  whales: WhaleWatchEnrichment;
  overall_risk_score: number;
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

    // Overall risk score: weighted combination
    let riskScore = 0;
    // Token risk flags (each adds 0.1)
    riskScore += token.risk_flags.length * 0.1;
    // Not verified on Jupiter
    if (!token.verified) riskScore += 0.15;
    // Mint authority active (can inflate supply)
    if (token.mint_authority) riskScore += 0.2;
    // Freeze authority active (can freeze accounts)
    if (token.freeze_authority) riskScore += 0.1;
    // Low liquidity
    if (token.liquidity < 50_000) riskScore += 0.15;
    // Whale distribution activity
    if (whales?.net_flow_direction === 'distributing') riskScore += 0.1;

    riskScore = Math.min(1, Math.max(0, riskScore));

    const recommendation: DueDiligenceEnrichment['recommendation'] =
      riskScore > 0.6 ? 'RISKY' :
      riskScore > 0.3 ? 'CAUTION' : 'SAFE';

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
      overall_risk_score: Math.round(riskScore * 100) / 100,
      recommendation,
      last_updated: formatTimestamp(),
    };

    await this.cache.set(cacheKey, enrichment, CACHE_TTL.dueDiligence);
    return enrichment;
  }
}
