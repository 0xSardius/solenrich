import type { HeliusClient } from '../sources/helius';
import type { DexScreenerClient } from '../sources/dexscreener';
import type { SolanaRpcClient } from '../sources/solana-rpc';
import type { JupiterClient, JupiterToken } from '../sources/jupiter';
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
  mint_authority: string | null;
  freeze_authority: string | null;
  last_updated: string;
}

// --- Class ---

export class TokenAnalyzer {
  constructor(
    private helius: HeliusClient,
    private dexscreener: DexScreenerClient,
    private solanaRpc: SolanaRpcClient,
    private jupiter: JupiterClient,
    private cache: Cache,
  ) {}

  async enrich(mint: string, includeHolders = false): Promise<TokenEnrichment> {
    // Step 1: cache check
    const cacheKey = `token:${mint}:${includeHolders ? 'holders' : 'basic'}`;
    const cached = await this.cache.get<TokenEnrichment>(cacheKey);
    if (cached) return cached;

    // Step 2: parallel fetch from DexScreener + Jupiter + on-chain mint info
    const tasks: ParallelTask<any>[] = [
      { name: 'dexData', fn: () => this.dexscreener.getTokenData(mint) },
      { name: 'mintInfo', fn: () => this.solanaRpc.getMintInfo(mint) },
      { name: 'jupiterToken', fn: () => this.jupiter.getTokenInfo(mint) },
    ];

    const fetched = await parallelFetch(tasks);

    const dexData = fetched.dexData as Awaited<ReturnType<DexScreenerClient['getTokenData']>>;
    const mintInfo = fetched.mintInfo as Awaited<ReturnType<SolanaRpcClient['getMintInfo']>>;
    const jupiterToken = fetched.jupiterToken as JupiterToken | null;

    const price = dexData?.price ?? 0;
    const decimals = mintInfo?.decimals ?? jupiterToken?.decimals ?? 0;
    const rawSupply = mintInfo?.supply ?? 0;
    const supply = decimals > 0 ? rawSupply / 10 ** decimals : rawSupply;

    // Step 3: risk flags
    const riskFlags: string[] = [];

    if (dexData && dexData.liquidity < 50_000) {
      riskFlags.push('low_liquidity');
    }
    if (mintInfo && mintInfo.mintAuthority !== null) {
      riskFlags.push('mint_authority_active');
    }
    if (mintInfo && mintInfo.freezeAuthority !== null) {
      riskFlags.push('freeze_authority_active');
    }
    if (jupiterToken?.verified !== true) {
      riskFlags.push('unverified');
    }
    if (dexData && Math.abs(dexData.priceChange24h) > 20) {
      riskFlags.push('high_volatility');
    }

    // Step 4: assemble
    const enrichment: TokenEnrichment = {
      mint,
      symbol: dexData?.symbol ?? jupiterToken?.symbol ?? '',
      name: dexData?.name ?? jupiterToken?.name ?? '',
      decimals,
      supply,
      holder_count: 0, // Not available without Birdeye — can add later
      price_usd: price,
      market_cap: dexData?.marketCap ?? (price * supply),
      volume_24h: dexData?.volume24h ?? 0,
      price_change_24h: dexData?.priceChange24h ?? 0,
      top_holders: undefined, // Not available without Birdeye — can add later
      liquidity: dexData?.liquidity ?? 0,
      risk_flags: riskFlags,
      verified: jupiterToken?.verified === true,
      mint_authority: mintInfo?.mintAuthority ?? null,
      freeze_authority: mintInfo?.freezeAuthority ?? null,
      last_updated: formatTimestamp(),
    };

    await this.cache.set(cacheKey, enrichment, CACHE_TTL.tokenPrice);
    return enrichment;
  }
}
