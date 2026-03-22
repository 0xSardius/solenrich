import type { HeliusClient } from '../sources/helius';
import type { DexScreenerClient } from '../sources/dexscreener';
import type { SolanaRpcClient } from '../sources/solana-rpc';
import type { JupiterClient, JupiterToken } from '../sources/jupiter';
import type { Cache } from '../cache';
import { CACHE_TTL } from '../config';
import { parallelFetch, type ParallelTask } from '../utils/parallel';
import { formatTimestamp } from '../utils/normalize';

// --- Types ---

export interface HolderConcentration {
  top1_pct: number;
  top5_pct: number;
  top10_pct: number;
  herfindahl_index: number;  // 0-10000: <1500 = distributed, 1500-2500 = moderate, >2500 = concentrated
}

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
  concentration?: HolderConcentration;
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
    const cacheKey = `token:${mint}:${includeHolders ? 'holders' : 'basic'}`;
    const cached = await this.cache.get<TokenEnrichment>(cacheKey);
    if (cached) return cached;

    // Parallel fetch: DexScreener + Jupiter + on-chain mint info + largest accounts
    const tasks: ParallelTask<any>[] = [
      { name: 'dexData', fn: () => this.dexscreener.getTokenData(mint) },
      { name: 'mintInfo', fn: () => this.solanaRpc.getMintInfo(mint) },
      { name: 'jupiterToken', fn: () => this.jupiter.getTokenInfo(mint) },
      { name: 'largestAccounts', fn: () => this.solanaRpc.getTokenLargestAccounts(mint) },
    ];

    const fetched = await parallelFetch(tasks);

    const dexData = fetched.dexData as Awaited<ReturnType<DexScreenerClient['getTokenData']>>;
    const mintInfo = fetched.mintInfo as Awaited<ReturnType<SolanaRpcClient['getMintInfo']>>;
    const jupiterToken = fetched.jupiterToken as JupiterToken | null;
    const largestAccounts = (fetched.largestAccounts as Awaited<ReturnType<SolanaRpcClient['getTokenLargestAccounts']>>) ?? [];

    const price = dexData?.price ?? 0;
    const decimals = mintInfo?.decimals ?? jupiterToken?.decimals ?? 0;
    const rawSupply = mintInfo?.supply ?? 0;
    const supply = decimals > 0 ? rawSupply / 10 ** decimals : rawSupply;

    // --- Holder concentration ---
    let topHolders: TokenEnrichment['top_holders'];
    let concentration: HolderConcentration | undefined;

    if (largestAccounts.length > 0 && supply > 0) {
      // Resolve token account owners to wallet addresses
      let ownerMap: Array<{ tokenAccount: string; owner: string | null }> = [];
      try {
        ownerMap = await this.solanaRpc.resolveTokenAccountOwners(
          largestAccounts.map((a) => a.address),
        );
      } catch {
        // Retry once — owner resolution is important for data consistency
        try {
          ownerMap = await this.solanaRpc.resolveTokenAccountOwners(
            largestAccounts.map((a) => a.address),
          );
        } catch {
          ownerMap = largestAccounts.map((a) => ({ tokenAccount: a.address, owner: null }));
        }
      }

      topHolders = largestAccounts.map((account, i) => {
        const owner = ownerMap[i]?.owner;
        return {
          address: owner ?? account.address,
          balance: account.uiAmount,
          pct_supply: (account.uiAmount / supply) * 100,
          // Mark if we couldn't resolve the owner — consumers can filter on this
          ...(owner ? {} : { is_token_account: true }),
        };
      });

      const top1 = topHolders[0]?.pct_supply ?? 0;
      const top5 = topHolders.slice(0, 5).reduce((sum, h) => sum + h.pct_supply, 0);
      const top10 = topHolders.slice(0, 10).reduce((sum, h) => sum + h.pct_supply, 0);

      // Herfindahl-Hirschman Index: sum of squared percentages (0-10000 scale)
      const hhi = topHolders.reduce((sum, h) => sum + h.pct_supply ** 2, 0);

      concentration = {
        top1_pct: Math.round(top1 * 100) / 100,
        top5_pct: Math.round(top5 * 100) / 100,
        top10_pct: Math.round(top10 * 100) / 100,
        herfindahl_index: Math.round(hhi),
      };
    }

    // --- Risk flags ---
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
    if (concentration && concentration.top1_pct > 50) {
      riskFlags.push('high_concentration');
    }
    if (concentration && concentration.top5_pct > 80) {
      riskFlags.push('whale_dominated');
    }

    // --- Assemble ---
    const enrichment: TokenEnrichment = {
      mint,
      symbol: dexData?.symbol ?? jupiterToken?.symbol ?? '',
      name: dexData?.name ?? jupiterToken?.name ?? '',
      decimals,
      supply,
      holder_count: largestAccounts.length, // Top-20 returned by RPC; full count requires Birdeye
      price_usd: price,
      market_cap: dexData?.marketCap ?? (price * supply),
      volume_24h: dexData?.volume24h ?? 0,
      price_change_24h: dexData?.priceChange24h ?? 0,
      top_holders: topHolders,
      concentration,
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
