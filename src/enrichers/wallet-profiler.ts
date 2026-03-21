import type { HeliusClient, HeliusAssetList, EnhancedTransaction } from '../sources/helius';
import type { SolanaRpcClient } from '../sources/solana-rpc';
import type { DexScreenerClient } from '../sources/dexscreener';
import type { Cache } from '../cache';
import { CACHE_TTL } from '../config';
import { parallelFetch, type ParallelTask } from '../utils/parallel';
import { formatTimestamp } from '../utils/normalize';
import { labelWallet, type WalletData } from './labeler';
import { scoreWalletRisk } from './risk-scorer';
import { tagAddresses } from '../utils/entities';

// --- Constants ---

const KNOWN_PROTOCOLS: Record<string, string> = {
  MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD: 'Marinade',
  Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb: 'Jito',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium',
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'Orca',
  '6LtLpnUFNByNXLyCoK9wA2MykKAmQNZKBdY8s47dehDc': 'Kamino',
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: 'Jupiter',
  MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA: 'marginfi',
  dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH: 'Drift',
};

const STABLECOIN_MINTS = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  '7kbnvuGBxxj8AG9qp8Scn56muWGaRaFqxg1FsRp3PaFT', // UXD
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo', // PYUSD
]);

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const THIRTY_DAYS_S = 30 * 24 * 60 * 60;

// --- Types ---

export interface WalletEnrichment {
  address: string;
  sol_balance: number;
  portfolio_value_usd: number;
  token_count: number;
  top_holdings: Array<{
    mint: string;
    symbol: string;
    balance: number;
    usd_value: number;
  }>;
  nft_count: number;
  defi_positions: Array<{
    protocol: string;
    type: string;
    value_usd: number;
  }>;
  tx_count_30d: number;
  first_tx_date: string | null;
  labels: string[];
  risk_score: number;
  risk_level: string;
  risk_factors: string[];
  connected_wallets: Array<{ address: string; entity_label?: string; entity_type?: string }>;
  last_updated: string;
}

// --- Class ---

export class WalletProfiler {
  constructor(
    private helius: HeliusClient,
    private solanaRpc: SolanaRpcClient,
    private dexscreener: DexScreenerClient,
    private cache: Cache,
  ) {}

  async enrich(address: string, depth: 'light' | 'full'): Promise<WalletEnrichment> {
    // Step 1: cache check
    const cacheKey = `wallet:${address}:${depth}`;
    const cached = await this.cache.get<WalletEnrichment>(cacheKey);
    if (cached) return cached;

    // Step 2: parallel fetch
    const tasks: ParallelTask<any>[] = [
      { name: 'sol_balance', fn: () => this.solanaRpc.getBalance(address) },
      { name: 'assets', fn: () => this.helius.getAssetsByOwner(address) },
      { name: 'signatures', fn: () => this.helius.getSignaturesForAddress(address, 100) },
    ];

    const fetched = await parallelFetch(tasks);

    const solBalance = (fetched.sol_balance as number) ?? 0;
    const assets = fetched.assets as HeliusAssetList | null;
    const signatures = (fetched.signatures as Array<{ signature: string; slot: number; blockTime: number | null }>) ?? [];

    // Fetch enhanced txs for full depth — batch in chunks of 100 (Helius limit)
    let enhancedTxs: EnhancedTransaction[] = [];
    if (depth === 'full' && signatures.length > 0) {
      const allSigs = signatures.map((s) => s.signature);
      const chunks: string[][] = [];
      for (let i = 0; i < allSigs.length; i += 100) {
        chunks.push(allSigs.slice(i, i + 100));
      }
      const chunkResults = await Promise.allSettled(
        chunks.map((chunk) => this.helius.getEnhancedTransactions(chunk)),
      );
      for (const result of chunkResults) {
        if (result.status === 'fulfilled') {
          enhancedTxs.push(...result.value);
        }
      }
    }

    // Step 3-4: Build portfolio from Helius assets + Jupiter prices
    const assetItems = assets?.items ?? [];
    const fungibleAssets = assetItems.filter(
      (a) => a.interface === 'FungibleToken' || a.interface === 'FungibleAsset',
    );

    // Use Helius price_info if available, otherwise fetch from DexScreener
    // Helius DAS often includes price_info for fungible tokens
    const solPrice = await this.dexscreener.getTokenPrice(SOL_MINT).catch(() => 0);
    const solValueUsd = solBalance * solPrice;

    // Build holdings with USD values
    const holdingsRaw: Array<{ mint: string; symbol: string; balance: number; usd_value: number }> = [];

    for (const asset of fungibleAssets) {
      const mint = asset.id;
      const symbol = asset.token_info?.symbol ?? asset.content?.metadata?.symbol ?? mint.slice(0, 6);
      const decimals = asset.token_info?.decimals ?? 0;
      const rawBalance = asset.token_info?.balance ?? 0;
      const balance = decimals > 0 ? rawBalance / 10 ** decimals : rawBalance;

      // Use Helius price_info first (free, already in response), then DexScreener fallback
      const heliusPrice = asset.token_info?.price_info?.price_per_token ?? 0;
      const usdValue = heliusPrice > 0
        ? balance * heliusPrice
        : balance * (await this.dexscreener.getTokenPrice(mint).catch(() => 0));

      holdingsRaw.push({ mint, symbol, balance, usd_value: usdValue });
    }

    // Sort by USD value descending
    holdingsRaw.sort((a, b) => b.usd_value - a.usd_value);

    const tokenPortfolioUsd = holdingsRaw.reduce((sum, h) => sum + h.usd_value, 0);
    const portfolioValueUsd = solValueUsd + tokenPortfolioUsd;

    const topLimit = depth === 'full' ? 10 : 5;
    const topHoldings = holdingsRaw.slice(0, topLimit);

    // Count tokens and NFTs
    const tokenCount = fungibleAssets.length;
    const nftCount = assetItems.filter(
      (a) => a.interface === 'V1_NFT' || a.interface === 'ProgrammableNFT' ||
             (a.interface !== 'FungibleToken' && a.interface !== 'FungibleAsset' && !a.burnt),
    ).length;

    // Stablecoin percentage
    const stablecoinValue = holdingsRaw
      .filter((h) => STABLECOIN_MINTS.has(h.mint))
      .reduce((sum, h) => sum + h.usd_value, 0);
    const stablecoinPct = portfolioValueUsd > 0 ? (stablecoinValue / portfolioValueUsd) * 100 : 0;

    // Step 5: activity stats
    const now = Math.floor(Date.now() / 1000);
    const thirtyDaysAgo = now - THIRTY_DAYS_S;

    const recentSigs = signatures.filter((s) => s.blockTime && s.blockTime > thirtyDaysAgo);
    const txCount30d = recentSigs.length;

    const oldestSig = signatures[signatures.length - 1];
    const firstTxDate = oldestSig?.blockTime
      ? new Date(oldestSig.blockTime * 1000).toISOString()
      : null;

    // Daily tx counts over 30d
    const dailyCounts = new Array(30).fill(0);
    for (const sig of recentSigs) {
      if (!sig.blockTime) continue;
      const dayIndex = Math.floor((now - sig.blockTime) / 86400);
      if (dayIndex >= 0 && dayIndex < 30) dailyCounts[dayIndex]++;
    }

    // Swap count and protocols (full depth only)
    let swapCount30d = 0;
    const protocolsInteracted: string[] = [];
    if (depth === 'full') {
      swapCount30d = enhancedTxs.filter((tx) => tx.type === 'SWAP').length;

      const programIds = new Set<string>();
      for (const tx of enhancedTxs) {
        for (const ad of tx.accountData ?? []) {
          if (KNOWN_PROTOCOLS[ad.account]) {
            programIds.add(KNOWN_PROTOCOLS[ad.account]);
          }
        }
      }
      protocolsInteracted.push(...programIds);
    }

    // Step 6: DeFi positions (full depth only) — estimate USD values from token balance changes
    const defiPositions: Array<{ protocol: string; type: string; value_usd: number }> = [];
    if (depth === 'full') {
      const protocolData = new Map<string, { type: string; volumeUsd: number }>();
      for (const tx of enhancedTxs) {
        for (const ad of tx.accountData ?? []) {
          const proto = KNOWN_PROTOCOLS[ad.account];
          if (!proto) continue;

          const txType = tx.type === 'SWAP' ? 'swap' : tx.type === 'TRANSFER' ? 'transfer' : 'stake';
          const existing = protocolData.get(proto) ?? { type: txType, volumeUsd: 0 };

          // Sum absolute token balance changes as a proxy for protocol interaction value
          for (const tbc of ad.tokenBalanceChanges ?? []) {
            const rawAmount = Math.abs(Number((tbc as any).rawTokenAmount?.tokenAmount ?? 0));
            const decimals = Number((tbc as any).rawTokenAmount?.decimals ?? 0);
            const units = decimals > 0 ? rawAmount / 10 ** decimals : rawAmount;
            const mint = (tbc as any).mint as string | undefined;
            if (mint && units > 0) {
              // Use holdings price if we have it, otherwise skip
              const holding = holdingsRaw.find((h) => h.mint === mint);
              if (holding && holding.balance > 0) {
                const pricePerUnit = holding.usd_value / holding.balance;
                existing.volumeUsd += units * pricePerUnit;
              }
            }
          }

          protocolData.set(proto, existing);
        }
      }
      for (const [protocol, data] of protocolData) {
        defiPositions.push({
          protocol,
          type: data.type,
          value_usd: Math.round(data.volumeUsd * 100) / 100,
        });
      }
    }

    // Step 7: labels
    const walletAgeDays = firstTxDate
      ? Math.floor((Date.now() - new Date(firstTxDate).getTime()) / (24 * 60 * 60 * 1000))
      : 0;

    const walletData: WalletData = {
      balance_sol: solBalance,
      portfolio_value_usd: portfolioValueUsd,
      token_count: tokenCount,
      nft_count: nftCount,
      tx_count_30d: txCount30d,
      first_tx_date: firstTxDate,
      defi_positions: defiPositions,
      top_holdings: topHoldings.map((h) => ({
        symbol: h.symbol,
        usd_value: h.usd_value,
        pct_portfolio: portfolioValueUsd > 0 ? (h.usd_value / portfolioValueUsd) * 100 : 0,
      })),
      swap_count_30d: swapCount30d,
      daily_tx_counts: dailyCounts,
      protocols_interacted: protocolsInteracted,
      stablecoin_pct: stablecoinPct,
    };

    const labels = labelWallet(walletData);

    // Step 8: risk score
    const topHoldingPct = portfolioValueUsd > 0 && holdingsRaw.length > 0
      ? (holdingsRaw[0].usd_value / portfolioValueUsd) * 100
      : 0;

    const uniqueProgramCount = new Set(enhancedTxs.flatMap((tx) => tx.accountData.map((a) => a.account))).size;
    const txDiversity = enhancedTxs.length > 0 ? uniqueProgramCount / enhancedTxs.length : 0;

    const riskResult = scoreWalletRisk({
      wallet_age_days: walletAgeDays,
      tx_diversity: txDiversity,
      protocol_breadth: protocolsInteracted.length,
      concentration: topHoldingPct,
      flagged_associations: 0,
      labels,
    });

    // Step 9: connected wallets (full depth only)
    const connectedWallets: Array<{ address: string; entity_label?: string; entity_type?: string }> = [];
    if (depth === 'full') {
      const counterparties = new Set<string>();
      for (const tx of enhancedTxs) {
        for (const nt of tx.nativeTransfers ?? []) {
          if (nt.fromUserAccount !== address) counterparties.add(nt.fromUserAccount);
          if (nt.toUserAccount !== address) counterparties.add(nt.toUserAccount);
        }
        for (const tt of tx.tokenTransfers ?? []) {
          if (tt.fromUserAccount !== address) counterparties.add(tt.fromUserAccount);
          if (tt.toUserAccount !== address) counterparties.add(tt.toUserAccount);
        }
      }
      connectedWallets.push(...tagAddresses([...counterparties].slice(0, 20)));
    }

    // Step 10: assemble, cache, return
    const enrichment: WalletEnrichment = {
      address,
      sol_balance: solBalance,
      portfolio_value_usd: portfolioValueUsd,
      token_count: tokenCount,
      top_holdings: topHoldings,
      nft_count: nftCount,
      defi_positions: defiPositions,
      tx_count_30d: txCount30d,
      first_tx_date: firstTxDate,
      labels,
      risk_score: riskResult.score,
      risk_level: riskResult.risk_level,
      risk_factors: riskResult.factors,
      connected_wallets: connectedWallets,
      last_updated: formatTimestamp(),
    };

    await this.cache.set(cacheKey, enrichment, CACHE_TTL.walletProfile);
    return enrichment;
  }
}
