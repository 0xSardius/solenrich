import type { HeliusClient, HeliusAssetList, EnhancedTransaction } from '../sources/helius';
import type { SolanaRpcClient } from '../sources/solana-rpc';
import type { DexScreenerClient } from '../sources/dexscreener';
import type { PriceAggregator } from '../utils/price-aggregator';
import type { SnapshotStore } from './snapshot-store';
import type { Cache } from '../cache';
import { CACHE_TTL } from '../config';
import { parallelFetchDetailed, type ParallelTask } from '../utils/parallel';
import { formatTimestamp } from '../utils/normalize';
import { labelWallet, type WalletData } from './labeler';
import { scoreWalletRisk } from './risk-scorer';
import { tagAddresses } from '../utils/entities';
import {
  classifyNfts,
  type NftAssetInput,
  type NftSummary,
  type NftCollectionEntry,
} from './nft-classifier';

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
  /** Every non-fungible held, unburnt. Kept for API stability — read `nft_summary` for the split. */
  nft_count: number;
  /** Real holdings vs unsolicited drops vs suspected spam. See `nft-classifier.ts`. */
  nft_summary: NftSummary;
  /** Largest collections, real holdings first. Capped at 10 (full depth) or 5 (light). */
  nft_collections: NftCollectionEntry[];
  defi_positions: Array<{
    protocol: string;
    type: string;
    value_usd: number;
  }>;
  tx_count_30d: number;
  /** True when tx_count_30d is a lower bound (more 30-day transactions than the pages read). */
  tx_count_30d_capped: boolean;
  /** The wallet's first transaction. null when its history is longer than the pages read (see first_seen_at_least). */
  first_tx_date: string | null;
  /** Oldest transaction read: the wallet is at least this old. Equals first_tx_date when history_complete. */
  first_seen_at_least: string | null;
  last_tx_date: string | null;
  history_complete: boolean;
  labels: string[];
  risk_score: number;
  risk_level: string;
  risk_factors: string[];
  connected_wallets: Array<{ address: string; entity_label?: string; entity_type?: string }>;
  /** Reads that failed. degraded = balances, assets or signatures did not answer (zeros there are not measured). */
  data_quality: { degraded: boolean; unavailable: string[] };
  last_updated: string;
}

type Sig = { signature: string; slot?: number; blockTime: number | null };

/** Signature pages read per wallet (100 each). A complete first-tx date is cached, so later calls read less. */
export const WALLET_SIG_MAX_PAGES = 5;

export interface WalletHistory {
  first_tx_date: string | null;
  first_seen_at_least: string | null;
  last_tx_date: string | null;
  history_complete: boolean;
  tx_count_30d: number;
  tx_count_30d_capped: boolean;
  /** null when the first transaction is unknown. */
  wallet_age_days: number | null;
}

/**
 * Wallet history from newest-first signatures. `complete` = the pages reached the wallet's first transaction.
 * `knownFirstTx` = a first-tx date cached from an earlier complete read (it never changes). Pure.
 * Before (2026-11-17), first_tx_date was the oldest of the newest 100 signatures, so an active multi-year wallet
 * was "created" days ago: labeled new_wallet and charged +0.20 age risk.
 */
export function walletHistory(sigs: Sig[], complete: boolean, nowSec: number, knownFirstTx: string | null = null): WalletHistory {
  const times = sigs.map((s) => s.blockTime).filter((t): t is number => typeof t === 'number' && t > 0);
  const iso = (t: number) => new Date(t * 1000).toISOString();
  const oldest = times.length ? Math.min(...times) : null;
  const newest = times.length ? Math.max(...times) : null;
  const firstTx = knownFirstTx ?? (complete && oldest != null ? iso(oldest) : null);
  const cutoff = nowSec - THIRTY_DAYS_S;
  const txCount30d = times.filter((t) => t > cutoff).length;
  return {
    first_tx_date: firstTx,
    first_seen_at_least: firstTx ?? (oldest != null ? iso(oldest) : null),
    last_tx_date: newest != null ? iso(newest) : null,
    history_complete: firstTx != null || (complete && times.length === 0),
    tx_count_30d: txCount30d,
    // Capped when the read stopped while still inside the 30-day window.
    tx_count_30d_capped: !complete && oldest != null && oldest > cutoff,
    wallet_age_days: firstTx ? Math.floor((nowSec * 1000 - new Date(firstTx).getTime()) / 86_400_000) : null,
  };
}

// --- Class ---

export class WalletProfiler {
  private snapshotStore?: SnapshotStore;

  constructor(
    private helius: HeliusClient,
    private solanaRpc: SolanaRpcClient,
    private dexscreener: DexScreenerClient,
    private cache: Cache,
    private priceAggregator?: PriceAggregator,
    snapshotStore?: SnapshotStore,
  ) {
    this.snapshotStore = snapshotStore;
  }

  async enrich(address: string, depth: 'light' | 'full'): Promise<WalletEnrichment> {
    // Step 1: cache check
    const cacheKey = `wallet:${address}:${depth}`;
    const cached = await this.cache.get<WalletEnrichment>(cacheKey);
    if (cached) return cached;

    // Step 2: parallel fetch
    const tasks: ParallelTask<any>[] = [
      { name: 'sol_balance', fn: () => this.solanaRpc.getBalance(address) },
      { name: 'assets', fn: () => this.helius.getAssetsByOwner(address) },
      { name: 'signatures', fn: () => this.readHistory(address) },
    ];

    const { results: fetched, failed } = await parallelFetchDetailed(tasks);
    const unavailable = new Set<string>(failed);

    const solBalance = (fetched.sol_balance as number) ?? 0;
    const assets = fetched.assets as HeliusAssetList | null;
    const read = fetched.signatures as { sigs: Sig[]; complete: boolean; knownFirstTx: string | null } | null;
    const signatures = read?.sigs ?? [];
    // Newest 100 for the behaviour and enhanced-tx paths (unchanged scope; age/count use every page read).
    const recent100 = signatures.slice(0, 100);

    // Fetch enhanced txs for full depth — the newest 100 (one Helius batch)
    const enhancedTxs: EnhancedTransaction[] = [];
    if (depth === 'full' && recent100.length > 0) {
      try {
        enhancedTxs.push(...await this.helius.getEnhancedTransactions(recent100.map((s) => s.signature)));
      } catch {
        unavailable.add('enhanced_tx');
      }
    }

    // Step 3-4: Build portfolio from Helius assets + Jupiter prices
    const assetItems = assets?.items ?? [];
    const fungibleAssets = assetItems.filter(
      (a) => a.interface === 'FungibleToken' || a.interface === 'FungibleAsset',
    );

    // Multi-source price aggregation: Helius DAS + DexScreener + Jupiter
    // Collect Helius prices from DAS response, then batch-fetch remaining from aggregator
    const heliusPrices = new Map<string, number>();
    const mintsNeedingPrice: string[] = [SOL_MINT];

    for (const asset of fungibleAssets) {
      const heliusPrice = asset.token_info?.price_info?.price_per_token ?? 0;
      if (heliusPrice > 0) {
        heliusPrices.set(asset.id, heliusPrice);
      }
      mintsNeedingPrice.push(asset.id);
    }

    // Batch aggregate prices (Helius + DexScreener + Jupiter median)
    let aggregatedPrices = new Map<string, { price: number }>();
    if (this.priceAggregator) {
      const agg = await this.priceAggregator.getBatchPrices(mintsNeedingPrice, heliusPrices);
      aggregatedPrices = agg;
    } else {
      // Fallback: use DexScreener only (backward compatible if no aggregator injected)
      for (const mint of mintsNeedingPrice) {
        const helius = heliusPrices.get(mint) ?? 0;
        const price = helius > 0 ? helius : await this.dexscreener.getTokenPrice(mint).catch(() => 0);
        aggregatedPrices.set(mint, { price });
      }
    }

    const solPrice = aggregatedPrices.get(SOL_MINT)?.price ?? 0;
    const solValueUsd = solBalance * solPrice;

    // Build holdings with aggregated USD values
    const holdingsRaw: Array<{ mint: string; symbol: string; balance: number; usd_value: number }> = [];

    for (const asset of fungibleAssets) {
      const mint = asset.id;
      const symbol = asset.token_info?.symbol ?? asset.content?.metadata?.symbol ?? mint.slice(0, 6);
      const decimals = asset.token_info?.decimals ?? 0;
      const rawBalance = asset.token_info?.balance ?? 0;
      const balance = decimals > 0 ? rawBalance / 10 ** decimals : rawBalance;

      const price = aggregatedPrices.get(mint)?.price ?? 0;
      holdingsRaw.push({ mint, symbol, balance, usd_value: balance * price });
    }

    // Sort by USD value descending
    holdingsRaw.sort((a, b) => b.usd_value - a.usd_value);

    const tokenPortfolioUsd = holdingsRaw.reduce((sum, h) => sum + h.usd_value, 0);
    const portfolioValueUsd = solValueUsd + tokenPortfolioUsd;

    const topLimit = depth === 'full' ? 10 : 5;
    const topHoldings = holdingsRaw.slice(0, topLimit);

    // Count tokens
    const tokenCount = fungibleAssets.length;

    // Classify non-fungibles. The `!a.burnt` guard applies to every interface —
    // the earlier version skipped it for V1_NFT and ProgrammableNFT, so burnt
    // assets inflated the count.
    const nonFungibles = assetItems.filter(
      (a) => a.interface !== 'FungibleToken' && a.interface !== 'FungibleAsset' && !a.burnt,
    );

    const nftInputs: NftAssetInput[] = nonFungibles.map((a) => {
      const group = (a.grouping ?? []).find((g) => g.group_key === 'collection');
      return {
        compressed: a.compression?.compressed === true,
        name: a.content?.metadata?.name ?? '',
        description: a.content?.metadata?.description ?? '',
        collection_mint: group?.group_value ?? null,
        collection_name: group?.collection_metadata?.name ?? null,
      };
    });

    const { summary: nftSummary, collections: nftCollections } = classifyNfts(
      nftInputs,
      depth === 'full' ? 10 : 5,
    );
    const nftCount = nftSummary.total;

    // Stablecoin percentage
    const stablecoinValue = holdingsRaw
      .filter((h) => STABLECOIN_MINTS.has(h.mint))
      .reduce((sum, h) => sum + h.usd_value, 0);
    const stablecoinPct = portfolioValueUsd > 0 ? (stablecoinValue / portfolioValueUsd) * 100 : 0;

    // Step 5: activity stats
    const now = Math.floor(Date.now() / 1000);
    const thirtyDaysAgo = now - THIRTY_DAYS_S;

    const recentSigs = signatures.filter((s) => s.blockTime && s.blockTime > thirtyDaysAgo);
    const history = read
      ? walletHistory(signatures, read.complete, now, read.knownFirstTx)
      : walletHistory([], false, now, null); // signature read failed: everything unknown
    const txCount30d = history.tx_count_30d;
    const firstTxDate = history.first_tx_date;

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
    const walletAgeDays = history.wallet_age_days; // null = unknown → no age risk factor

    // Behavioral signal data: tx timestamps + type counts (newest 100, as before)
    const txTimestamps = recent100
      .map((s) => s.blockTime)
      .filter((t): t is number => t !== null && t > 0);

    const txTypeCounts: Record<string, number> = {};
    for (const tx of enhancedTxs) {
      const type = tx.type || 'UNKNOWN';
      txTypeCounts[type] = (txTypeCounts[type] || 0) + 1;
    }

    const walletData: WalletData = {
      balance_sol: solBalance,
      portfolio_value_usd: portfolioValueUsd,
      token_count: tokenCount,
      nft_count: nftCount,
      // Label off real holdings, not the raw count. A wallet spammed with 103
      // drainer airdrops is not a collector.
      nft_collected_count: nftSummary.collected,
      tx_count_30d: txCount30d,
      first_tx_date: firstTxDate,
      last_tx_date: history.last_tx_date,
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
      tx_timestamps: txTimestamps,
      tx_type_counts: Object.keys(txTypeCounts).length > 0 ? txTypeCounts : undefined,
    };

    const labels = labelWallet(walletData);

    // Step 8: risk score
    const topHoldingPct = portfolioValueUsd > 0 && holdingsRaw.length > 0
      ? (holdingsRaw[0].usd_value / portfolioValueUsd) * 100
      : 0;

    // Diversity and protocol breadth need enhanced transactions (full depth). Unmeasured = not scored.
    const measuredActivity = depth === 'full' && enhancedTxs.length > 0;
    const uniqueProgramCount = new Set(enhancedTxs.flatMap((tx) => tx.accountData.map((a) => a.account))).size;
    const txDiversity = measuredActivity ? uniqueProgramCount / enhancedTxs.length : null;

    const riskResult = scoreWalletRisk({
      wallet_age_days: walletAgeDays,
      tx_diversity: txDiversity,
      protocol_breadth: measuredActivity ? protocolsInteracted.length : null,
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
      nft_summary: nftSummary,
      nft_collections: nftCollections,
      defi_positions: defiPositions,
      tx_count_30d: txCount30d,
      tx_count_30d_capped: history.tx_count_30d_capped,
      first_tx_date: firstTxDate,
      first_seen_at_least: history.first_seen_at_least,
      last_tx_date: history.last_tx_date,
      history_complete: history.history_complete,
      labels,
      risk_score: riskResult.score,
      risk_level: riskResult.risk_level,
      risk_factors: riskResult.factors,
      connected_wallets: connectedWallets,
      data_quality: {
        degraded: ['sol_balance', 'assets', 'signatures'].some((s) => unavailable.has(s)),
        unavailable: [...unavailable].sort(),
      },
      last_updated: formatTimestamp(),
    };

    // A partial read is cached briefly and never becomes the day's snapshot.
    const degraded = enrichment.data_quality.degraded;
    await this.cache.set(cacheKey, enrichment, degraded ? 15 : CACHE_TTL.walletProfile);

    // Fire-and-forget snapshot capture (one per day per address)
    if (this.snapshotStore && !degraded) {
      this.snapshotStore.captureWalletSnapshot(enrichment).catch(() => {});
    }

    return enrichment;
  }

  /**
   * Signatures newest-first, paged back to the wallet's first transaction (complete) or WALLET_SIG_MAX_PAGES.
   * A complete first-tx date is cached for 30 days (it never changes); with it, reading stops once the 30-day
   * window is covered.
   */
  private async readHistory(address: string): Promise<{ sigs: Sig[]; complete: boolean; knownFirstTx: string | null }> {
    const firstKey = `wallet:firsttx:${address}`;
    const knownFirstTx = await this.cache.get<string>(firstKey);
    const cutoff = Math.floor(Date.now() / 1000) - THIRTY_DAYS_S;
    const sigs: Sig[] = [];
    let before: string | undefined;
    let complete = false;
    for (let page = 0; page < WALLET_SIG_MAX_PAGES; page++) {
      const batch = await this.helius.getSignaturesForAddress(address, 100, before);
      sigs.push(...batch);
      if (batch.length < 100) { complete = true; break; }
      const oldest = batch[batch.length - 1].blockTime ?? 0;
      if (knownFirstTx && oldest > 0 && oldest < cutoff) break; // age known, 30-day window covered
      before = batch[batch.length - 1].signature;
    }
    if (complete && !knownFirstTx) {
      const times = sigs.map((s) => s.blockTime).filter((t): t is number => typeof t === 'number' && t > 0);
      if (times.length) await this.cache.set(firstKey, new Date(Math.min(...times) * 1000).toISOString(), 30 * 86400);
    }
    return { sigs, complete, knownFirstTx };
  }
}
