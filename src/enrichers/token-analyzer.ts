import type { HeliusClient } from '../sources/helius';
import type { BirdeyeClient, TokenOverview, TokenSecurity, Holder } from '../sources/birdeye';
import type { JupiterClient, JupiterToken, JupiterPrice } from '../sources/jupiter';
import type { Cache } from '../cache';
import { CACHE_TTL } from '../config';
import { parallelFetch, type ParallelTask } from '../utils/parallel';
import { formatTimestamp } from '../utils/normalize';

// --- Types ---

export interface TokenEnrichment {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  supply: number;
  holder_count: number;
  price_usd: number;
  market_cap: number;
  volume_24h: number;
  price_change_24h: number;
  top_holders?: Array<{
    address: string;
    balance: number;
    pct_supply: number;
  }>;
  liquidity: number;
  risk_flags: string[];
  verified: boolean;
  last_updated: string;
}

// --- Class ---

export class TokenAnalyzer {
  constructor(
    private helius: HeliusClient,
    private birdeye: BirdeyeClient,
    private jupiter: JupiterClient,
    private cache: Cache,
  ) {}

  async enrich(mint: string, includeHolders = false): Promise<TokenEnrichment> {
    // Step 1: cache check
    const cacheKey = `token:${mint}:${includeHolders ? 'holders' : 'basic'}`;
    const cached = await this.cache.get<TokenEnrichment>(cacheKey);
    if (cached) return cached;

    // Step 2: parallel fetch
    const tasks: ParallelTask<any>[] = [
      { name: 'overview', fn: () => this.birdeye.getTokenOverview(mint) },
      { name: 'security', fn: () => this.birdeye.getTokenSecurity(mint) },
      { name: 'jupiterToken', fn: () => this.jupiter.getTokenInfo(mint) },
      { name: 'jupiterPrice', fn: () => this.jupiter.getPrice([mint]) },
    ];

    if (includeHolders) {
      tasks.push({ name: 'holders', fn: () => this.birdeye.getTokenHolders(mint, 20) });
    }

    const fetched = await parallelFetch(tasks);

    const overview = fetched.overview as TokenOverview | null;
    const security = fetched.security as TokenSecurity | null;
    const jupiterToken = fetched.jupiterToken as JupiterToken | null;
    const jupiterPrices = fetched.jupiterPrice as Record<string, JupiterPrice> | null;
    const holders = (fetched.holders as Holder[] | null) ?? [];

    // Use Birdeye for primary data, Jupiter for cross-reference
    const price = overview?.price ?? jupiterPrices?.[mint]?.price ?? 0;

    // Step 3: risk flags
    const riskFlags: string[] = [];

    if (security && security.top10HolderPercent > 40) {
      riskFlags.push('high_concentration');
    }
    if (overview && overview.liquidity < 50_000) {
      riskFlags.push('low_liquidity');
    }
    if (security && security.mintAuthority !== null) {
      riskFlags.push('mint_authority_active');
    }
    if (security && security.freezeAuthority !== null) {
      riskFlags.push('freeze_authority_active');
    }
    if (jupiterToken?.verified !== true) {
      riskFlags.push('unverified');
    }
    if (overview && overview.holder < 100) {
      riskFlags.push('low_holder_count');
    }
    if (overview && Math.abs(overview.priceChange24h) > 20) {
      riskFlags.push('high_volatility');
    }

    // Step 4: assemble
    const topHolders = includeHolders && holders.length > 0
      ? holders.map((h) => ({
          address: h.address,
          balance: h.uiAmount,
          pct_supply: h.percentage,
        }))
      : undefined;

    const enrichment: TokenEnrichment = {
      mint,
      symbol: overview?.symbol ?? jupiterToken?.symbol ?? '',
      name: overview?.name ?? jupiterToken?.name ?? '',
      decimals: overview?.decimals ?? jupiterToken?.decimals ?? 0,
      supply: overview?.supply ?? 0,
      holder_count: overview?.holder ?? 0,
      price_usd: price,
      market_cap: overview?.marketCap ?? 0,
      volume_24h: overview?.volume24h ?? 0,
      price_change_24h: overview?.priceChange24h ?? 0,
      top_holders: topHolders,
      liquidity: overview?.liquidity ?? 0,
      risk_flags: riskFlags,
      verified: jupiterToken?.verified === true,
      last_updated: formatTimestamp(),
    };

    await this.cache.set(cacheKey, enrichment, CACHE_TTL.tokenPrice);
    return enrichment;
  }
}
