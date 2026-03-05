import type { TokenAnalyzer } from './token-analyzer';
import type { WhaleWatcher } from './whale-watch';
import type { BirdeyeClient } from '../sources/birdeye';
import type { Cache } from '../cache';
import { CACHE_TTL } from '../config';
import { formatTimestamp } from '../utils/normalize';
import { parallelFetch, type ParallelTask } from '../utils/parallel';
import type { TokenEnrichment } from './token-analyzer';
import type { WhaleWatchEnrichment } from './whale-watch';

export interface HolderConcentration {
  top_10_percent: number;
  top_50_percent: number;
  risk_level: 'low' | 'medium' | 'high';
}

export interface DueDiligenceEnrichment {
  token: TokenEnrichment;
  whales: WhaleWatchEnrichment;
  top_holders: Array<{ address: string; percentage: number; uiAmount: number }>;
  holder_concentration: HolderConcentration;
  overall_risk_score: number;
  recommendation: 'SAFE' | 'CAUTION' | 'RISKY';
  last_updated: string;
}

export class DueDiligenceAnalyzer {
  constructor(
    private tokenAnalyzer: TokenAnalyzer,
    private whaleWatcher: WhaleWatcher,
    private birdeye: BirdeyeClient,
    private cache: Cache,
  ) {}

  async enrich(mint: string): Promise<DueDiligenceEnrichment> {
    const cacheKey = `duediligence:${mint}`;
    const cached = await this.cache.get<DueDiligenceEnrichment>(cacheKey);
    if (cached) return cached;

    // Run all sub-analyses in parallel
    const tasks: ParallelTask<any>[] = [
      { name: 'token', fn: () => this.tokenAnalyzer.enrich(mint, true) },
      { name: 'whales', fn: () => this.whaleWatcher.enrich(mint, 10000, 72) },
      { name: 'holders', fn: () => this.birdeye.getTokenHolders(mint, 50) },
    ];
    const fetched = await parallelFetch(tasks, 15000);

    const token = fetched.token as TokenEnrichment | null;
    const whales = fetched.whales as WhaleWatchEnrichment | null;
    const holders = (fetched.holders as Array<{ address: string; percentage: number; uiAmount: number }>) ?? [];

    if (!token) throw new Error('Token analysis failed');

    // Compute holder concentration
    const sortedHolders = [...holders].sort((a, b) => b.percentage - a.percentage);
    const top10Pct = sortedHolders.slice(0, 10).reduce((sum, h) => sum + h.percentage, 0);
    const top50Pct = sortedHolders.slice(0, 50).reduce((sum, h) => sum + h.percentage, 0);

    const concentrationRisk: HolderConcentration['risk_level'] =
      top10Pct > 60 ? 'high' :
      top10Pct > 30 ? 'medium' : 'low';

    const holderConcentration: HolderConcentration = {
      top_10_percent: Math.round(top10Pct * 100) / 100,
      top_50_percent: Math.round(top50Pct * 100) / 100,
      risk_level: concentrationRisk,
    };

    // Overall risk score: weighted combination
    let riskScore = 0;
    // Token risk flags
    riskScore += token.risk_flags.length * 0.1;
    // Holder concentration
    if (concentrationRisk === 'high') riskScore += 0.25;
    else if (concentrationRisk === 'medium') riskScore += 0.1;
    // Not verified
    if (!token.verified) riskScore += 0.15;
    // Low holders
    if (token.holder_count < 100) riskScore += 0.15;
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
      top_holders: sortedHolders.slice(0, 20).map((h) => ({
        address: h.address,
        percentage: h.percentage,
        uiAmount: h.uiAmount,
      })),
      holder_concentration: holderConcentration,
      overall_risk_score: Math.round(riskScore * 100) / 100,
      recommendation,
      last_updated: formatTimestamp(),
    };

    await this.cache.set(cacheKey, enrichment, CACHE_TTL.dueDiligence);
    return enrichment;
  }
}
