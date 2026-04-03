import type { DexScreenerClient } from '../sources/dexscreener';
import type { TokenAnalyzer, TokenEnrichment } from './token-analyzer';
import type { Cache } from '../cache';
import { CACHE_TTL } from '../config';
import { formatTimestamp } from '../utils/normalize';
import { scoreTokenRisk, type RiskLevel } from './risk-scorer';

// --- Types ---

export interface DiscoveredToken {
  mint: string;
  symbol: string;
  name: string;
  price_usd: number;
  market_cap: number;
  liquidity: number;
  volume_24h: number;
  risk_score: number;
  risk_level: RiskLevel;
  risk_flags: string[];
  recommendation: 'SAFE' | 'CAUTION' | 'RISKY';
  verified: boolean;
  holder_count: number;
  concentration_hhi: number | null;
}

export interface TokenDiscoveryResult {
  tokens: DiscoveredToken[];
  total_scanned: number;
  total_passed: number;
  filters: {
    min_liquidity_usd: number;
    max_risk_score: number;
    limit: number;
  };
  last_updated: string;
}

// --- Class ---

export class TokenDiscovery {
  constructor(
    private dexscreener: DexScreenerClient,
    private tokenAnalyzer: TokenAnalyzer,
    private cache: Cache,
  ) {}

  async discover(
    minLiquidityUsd: number,
    maxRiskScore: number,
    limit: number,
  ): Promise<TokenDiscoveryResult> {
    const cacheKey = `discovery:${minLiquidityUsd}:${maxRiskScore}:${limit}`;
    const cached = await this.cache.get<TokenDiscoveryResult>(cacheKey);
    if (cached) return cached;

    // Step 1: Get latest token profiles from DexScreener
    const profiles = await this.dexscreener.getLatestProfiles();
    const mints = profiles.map(p => p.mint).slice(0, 30); // Cap at 30 to avoid API overload

    if (mints.length === 0) {
      return {
        tokens: [],
        total_scanned: 0,
        total_passed: 0,
        filters: { min_liquidity_usd: minLiquidityUsd, max_risk_score: maxRiskScore, limit },
        last_updated: formatTimestamp(),
      };
    }

    // Step 2: Enrich each token in parallel (batches of 5)
    const enriched: TokenEnrichment[] = [];
    for (let i = 0; i < mints.length; i += 5) {
      const batch = mints.slice(i, i + 5);
      const results = await Promise.allSettled(
        batch.map(mint => this.tokenAnalyzer.enrich(mint, true)),
      );
      for (const result of results) {
        if (result.status === 'fulfilled') enriched.push(result.value);
      }
    }

    // Step 3: Score and filter
    const scored: DiscoveredToken[] = enriched
      .filter(t => t.liquidity >= minLiquidityUsd)
      .map(t => {
        const riskResult = scoreTokenRisk({
          risk_flags_count: t.risk_flags.length,
          verified: t.verified,
          mint_authority_active: t.mint_authority !== null,
          freeze_authority_active: t.freeze_authority !== null,
          liquidity: t.liquidity,
          holder_concentration_top1: t.concentration?.top1_pct,
          holder_concentration_top5: t.concentration?.top5_pct,
          herfindahl_index: t.concentration?.herfindahl_index,
          whale_distributing: false,
        });

        return {
          mint: t.mint,
          symbol: t.symbol,
          name: t.name,
          price_usd: t.price_usd,
          market_cap: t.market_cap,
          liquidity: t.liquidity,
          volume_24h: t.volume_24h,
          risk_score: riskResult.score,
          risk_level: riskResult.risk_level,
          risk_flags: t.risk_flags,
          recommendation: riskResult.score > 0.6 ? 'RISKY' as const :
                          riskResult.score > 0.3 ? 'CAUTION' as const : 'SAFE' as const,
          verified: t.verified,
          holder_count: t.holder_count,
          concentration_hhi: t.concentration?.herfindahl_index ?? null,
        };
      })
      .filter(t => t.risk_score <= maxRiskScore)
      .sort((a, b) => a.risk_score - b.risk_score) // Safest first
      .slice(0, limit);

    const result: TokenDiscoveryResult = {
      tokens: scored,
      total_scanned: mints.length,
      total_passed: scored.length,
      filters: { min_liquidity_usd: minLiquidityUsd, max_risk_score: maxRiskScore, limit },
      last_updated: formatTimestamp(),
    };

    await this.cache.set(cacheKey, result, CACHE_TTL.trend); // 5 min cache
    return result;
  }
}
