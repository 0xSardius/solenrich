import type { HeliusClient, HeliusAssetList, EnhancedTransaction } from '../sources/helius';
import type { BirdeyeClient, WalletPortfolio } from '../sources/birdeye';
import type { SolanaRpcClient } from '../sources/solana-rpc';
import type { JupiterClient } from '../sources/jupiter';
import type { Cache } from '../cache';
import { CACHE_TTL } from '../config';
import { parallelFetch, type ParallelTask } from '../utils/parallel';
import { formatTimestamp } from '../utils/normalize';
import { labelWallet, type WalletData } from './labeler';
import { scoreWalletRisk } from './risk-scorer';

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
  risk_factors: string[];
  connected_wallets: string[];
  last_updated: string;
}

// --- Class ---

export class WalletProfiler {
  constructor(
    private helius: HeliusClient,
    private birdeye: BirdeyeClient,
    private solanaRpc: SolanaRpcClient,
    private jupiter: JupiterClient,
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
      { name: 'portfolio', fn: () => this.birdeye.getWalletPortfolio(address) },
      { name: 'signatures', fn: () => this.helius.getSignaturesForAddress(address, 100) },
    ];

    const fetched = await parallelFetch(tasks);

    const solBalance = (fetched.sol_balance as number) ?? 0;
    const assets = fetched.assets as HeliusAssetList | null;
    const portfolio = fetched.portfolio as WalletPortfolio | null;
    const signatures = (fetched.signatures as Array<{ signature: string; slot: number; blockTime: number | null }>) ?? [];

    // Fetch enhanced txs for full depth (need signatures first)
    let enhancedTxs: EnhancedTransaction[] = [];
    if (depth === 'full' && signatures.length > 0) {
      const sigs = signatures.slice(0, 50).map((s) => s.signature);
      try {
        enhancedTxs = await this.helius.getEnhancedTransactions(sigs);
      } catch (e) {
        console.warn('[wallet-profiler] Enhanced txs fetch failed:', e);
      }
    }

    // Step 3-4: portfolio stats
    const portfolioItems = portfolio?.items ?? [];
    const solValueUsd = solBalance * (portfolioItems.find((i) => i.symbol === 'SOL')?.priceUsd ?? 0);

    const portfolioValueUsd = portfolio?.totalUsd ?? solValueUsd;

    // Build holdings from Birdeye portfolio (has USD values)
    const holdingsRaw = portfolioItems
      .filter((i) => i.valueUsd > 0)
      .sort((a, b) => b.valueUsd - a.valueUsd);

    const topLimit = depth === 'full' ? 10 : 5;
    const topHoldings = holdingsRaw.slice(0, topLimit).map((h) => ({
      mint: h.address,
      symbol: h.symbol,
      balance: h.uiAmount,
      usd_value: h.valueUsd,
    }));

    // Count tokens and NFTs from Helius assets
    const assetItems = assets?.items ?? [];
    const tokenCount = assetItems.filter(
      (a) => a.interface === 'FungibleToken' || a.interface === 'FungibleAsset',
    ).length;
    const nftCount = assetItems.filter(
      (a) => a.interface === 'V1_NFT' || a.interface === 'ProgrammableNFT' ||
             (a.interface !== 'FungibleToken' && a.interface !== 'FungibleAsset' && !a.burnt),
    ).length;

    // Stablecoin percentage
    const stablecoinValue = portfolioItems
      .filter((i) => STABLECOIN_MINTS.has(i.address))
      .reduce((sum, i) => sum + i.valueUsd, 0);
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

    // Step 6: DeFi positions (full depth only)
    const defiPositions: Array<{ protocol: string; type: string; value_usd: number }> = [];
    if (depth === 'full') {
      const protocolInteractions = new Map<string, string>();
      for (const tx of enhancedTxs) {
        for (const ad of tx.accountData ?? []) {
          const proto = KNOWN_PROTOCOLS[ad.account];
          if (proto) {
            const txType = tx.type === 'SWAP' ? 'swap' : 'stake';
            protocolInteractions.set(proto, txType);
          }
        }
      }
      for (const [protocol, type] of protocolInteractions) {
        defiPositions.push({ protocol, type, value_usd: 0 });
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
      top_holdings: holdingsRaw.slice(0, topLimit).map((h) => ({
        symbol: h.symbol,
        usd_value: h.valueUsd,
        pct_portfolio: portfolioValueUsd > 0 ? (h.valueUsd / portfolioValueUsd) * 100 : 0,
      })),
      swap_count_30d: swapCount30d,
      daily_tx_counts: dailyCounts,
      protocols_interacted: protocolsInteracted,
      stablecoin_pct: stablecoinPct,
    };

    const labels = labelWallet(walletData);

    // Step 8: risk score
    const topHoldingPct = portfolioValueUsd > 0 && holdingsRaw.length > 0
      ? (holdingsRaw[0].valueUsd / portfolioValueUsd) * 100
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
    const connectedWallets: string[] = [];
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
      connectedWallets.push(...[...counterparties].slice(0, 20));
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
      risk_factors: riskResult.factors,
      connected_wallets: connectedWallets,
      last_updated: formatTimestamp(),
    };

    await this.cache.set(cacheKey, enrichment, CACHE_TTL.walletProfile);
    return enrichment;
  }
}
