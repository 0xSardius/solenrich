import type { HeliusClient, EnhancedTransaction } from '../sources/helius';
import type { DexScreenerClient } from '../sources/dexscreener';
import type { SolanaRpcClient } from '../sources/solana-rpc';
import type { BirdeyeClient } from '../sources/birdeye';
import type { PriceAggregator } from '../utils/price-aggregator';
import type { Cache } from '../cache';
import { CACHE_TTL } from '../config';
import { parallelFetch, type ParallelTask } from '../utils/parallel';
import { formatTimestamp } from '../utils/normalize';
import { lookupEntity } from '../utils/entities';

export interface WhaleActivity {
  address: string;
  entity_label?: string;
  entity_type?: string;
  balance_usd: number;
  pct_supply: number;
  transaction_count: number;
  total_volume_usd: number;
  avg_transaction_usd: number;
  buy_volume_usd: number;
  sell_volume_usd: number;
  flow_direction: 'accumulating' | 'distributing' | 'neutral';
  last_activity: string;
}

export interface WhaleWatchEnrichment {
  mint: string;
  threshold_usd: number;
  lookback_hours: number;
  whales: WhaleActivity[];
  total_whale_volume_usd: number;
  net_flow_direction: 'accumulating' | 'distributing' | 'neutral';
  whale_count: number;
  holders_source: 'rpc' | 'birdeye' | 'unavailable';
  last_updated: string;
}

export class WhaleWatcher {
  constructor(
    private helius: HeliusClient,
    private dexscreener: DexScreenerClient,
    private solanaRpc: SolanaRpcClient,
    private cache: Cache,
    private priceAggregator?: PriceAggregator,
    private birdeye?: BirdeyeClient,
  ) {}

  async enrich(
    mint: string,
    thresholdUsd: number,
    lookbackHours: number,
  ): Promise<WhaleWatchEnrichment> {
    const cacheKey = `whalewatch:${mint}:${thresholdUsd}:${lookbackHours}`;
    const cached = await this.cache.get<WhaleWatchEnrichment>(cacheKey);
    if (cached) return cached;

    // Phase 1: Fetch token price + top holders in parallel
    const phase1Tasks: ParallelTask<any>[] = [
      { name: 'price', fn: () => this.priceAggregator ? this.priceAggregator.getPrice(mint).then((r) => r.price) : this.dexscreener.getTokenPrice(mint), fallback: 0 },
      { name: 'largestAccounts', fn: () => this.solanaRpc.getTokenLargestAccounts(mint) },
      { name: 'mintInfo', fn: () => this.solanaRpc.getMintInfo(mint) },
    ];
    const phase1 = await parallelFetch(phase1Tasks);

    const tokenPrice = (phase1.price as number) ?? 0;
    const largestAccounts = (phase1.largestAccounts as Awaited<ReturnType<SolanaRpcClient['getTokenLargestAccounts']>>) ?? [];
    const mintInfo = phase1.mintInfo as Awaited<ReturnType<SolanaRpcClient['getMintInfo']>>;

    const decimals = mintInfo?.decimals ?? (largestAccounts[0]?.decimals ?? 0);
    const rawSupply = mintInfo?.supply ?? 0;
    const supply = decimals > 0 ? rawSupply / 10 ** decimals : rawSupply;

    // Resolve top holders. Same dual-path pattern as token-analyzer:
    // Path A — Helius RPC's largestAccounts (fast for sub-500K-holder tokens)
    // Path B — Birdeye fallback when Helius hits "Too many accounts" limit
    let holders: Array<{ walletAddress: string; tokenAccount: string; balance: number; pctSupply: number }> = [];
    let holdersSource: 'rpc' | 'birdeye' | 'unavailable' = 'unavailable';

    if (largestAccounts.length > 0) {
      // Path A — RPC. Resolve token-account → owner.
      const topN = largestAccounts.slice(0, 10);
      let ownerMap: Array<{ tokenAccount: string; owner: string | null }> = [];
      try {
        ownerMap = await this.solanaRpc.resolveTokenAccountOwners(topN.map((a) => a.address));
      } catch {
        ownerMap = topN.map((a) => ({ tokenAccount: a.address, owner: null }));
      }
      holders = topN.map((account, i) => ({
        walletAddress: ownerMap[i]?.owner ?? account.address,
        tokenAccount: account.address,
        balance: account.uiAmount,
        pctSupply: supply > 0 ? (account.uiAmount / supply) * 100 : 0,
      }));
      holdersSource = 'rpc';
    } else if (this.birdeye) {
      // Path B — Birdeye. Returns owner + token_account directly.
      try {
        const birdeyeHolders = await this.birdeye.getTokenHolders(mint, 10);
        const usable = birdeyeHolders.filter((h) => h.uiAmount > 0);
        if (usable.length > 0) {
          holders = usable.map((h) => ({
            walletAddress: h.address,
            tokenAccount: h.tokenAccount ?? h.address,
            balance: h.uiAmount,
            pctSupply: supply > 0 ? (h.uiAmount / supply) * 100 : 0,
          }));
          holdersSource = 'birdeye';
        }
      } catch {
        // fall through to empty
      }
    }

    if (holders.length === 0) {
      return this.emptyResult(mint, thresholdUsd, lookbackHours);
    }

    // Phase 3: Get recent signatures for each top holder's token account
    const sigTasks: ParallelTask<any>[] = holders.map((h) => ({
      name: `sigs:${h.tokenAccount}`,
      fn: () => this.helius.getSignaturesForAddress(h.tokenAccount, 50),
      fallback: [],
    }));
    const sigResults = await parallelFetch(sigTasks);

    // Collect unique signatures within lookback window
    const cutoff = Date.now() / 1000 - lookbackHours * 3600;
    const signatureSet = new Set<string>();

    for (const holder of holders) {
      const sigs = (sigResults[`sigs:${holder.tokenAccount}`] as Array<{ signature: string; blockTime: number | null }>) ?? [];
      for (const sig of sigs) {
        if ((sig.blockTime ?? 0) >= cutoff) {
          signatureSet.add(sig.signature);
        }
      }
    }

    // Phase 4: Batch fetch enhanced transactions
    const sigStrings = [...signatureSet].slice(0, 100);
    let txs: EnhancedTransaction[] = [];
    if (sigStrings.length > 0) {
      try {
        txs = await this.helius.getEnhancedTransactions(sigStrings);
      } catch {
        // Graceful degradation
      }
    }

    // Phase 5: Aggregate per-wallet volumes for our target mint
    const walletVolumes = new Map<string, { buy: number; sell: number; count: number; lastTime: number }>();
    const holderWallets = new Set(holders.map((h) => h.walletAddress));

    for (const tx of txs) {
      if (!tx.tokenTransfers) continue;
      for (const transfer of tx.tokenTransfers) {
        if (transfer.mint !== mint) continue;

        const amountUsd = transfer.tokenAmount * tokenPrice;
        if (amountUsd < thresholdUsd) continue;

        // Track buyer (if they're a known top holder)
        if (transfer.toUserAccount && holderWallets.has(transfer.toUserAccount)) {
          const entry = walletVolumes.get(transfer.toUserAccount) ?? { buy: 0, sell: 0, count: 0, lastTime: 0 };
          entry.buy += amountUsd;
          entry.count++;
          entry.lastTime = Math.max(entry.lastTime, tx.timestamp);
          walletVolumes.set(transfer.toUserAccount, entry);
        }

        // Track seller (if they're a known top holder)
        if (transfer.fromUserAccount && holderWallets.has(transfer.fromUserAccount)) {
          const entry = walletVolumes.get(transfer.fromUserAccount) ?? { buy: 0, sell: 0, count: 0, lastTime: 0 };
          entry.sell += amountUsd;
          entry.count++;
          entry.lastTime = Math.max(entry.lastTime, tx.timestamp);
          walletVolumes.set(transfer.fromUserAccount, entry);
        }
      }
    }

    // Build whale list — include all top holders even if no recent activity
    let totalAccumulation = 0;
    let totalDistribution = 0;

    const whales: WhaleActivity[] = holders.map((holder) => {
      const vol = walletVolumes.get(holder.walletAddress);
      const buyVol = vol?.buy ?? 0;
      const sellVol = vol?.sell ?? 0;
      const totalVolume = buyVol + sellVol;

      const direction: WhaleActivity['flow_direction'] =
        buyVol > sellVol * 1.2 ? 'accumulating' :
        sellVol > buyVol * 1.2 ? 'distributing' : 'neutral';

      totalAccumulation += buyVol;
      totalDistribution += sellVol;

      const entity = lookupEntity(holder.walletAddress);
      return {
        address: holder.walletAddress,
        ...(entity ? { entity_label: entity.label, entity_type: entity.type } : {}),
        balance_usd: holder.balance * tokenPrice,
        pct_supply: Math.round(holder.pctSupply * 100) / 100,
        transaction_count: vol?.count ?? 0,
        total_volume_usd: totalVolume,
        avg_transaction_usd: vol && vol.count > 0 ? totalVolume / vol.count : 0,
        buy_volume_usd: buyVol,
        sell_volume_usd: sellVol,
        flow_direction: direction,
        last_activity: vol?.lastTime ? new Date(vol.lastTime * 1000).toISOString() : 'none',
      };
    });

    // Sort by balance (largest holders first)
    whales.sort((a, b) => b.balance_usd - a.balance_usd);

    const netDirection: WhaleWatchEnrichment['net_flow_direction'] =
      totalAccumulation > totalDistribution * 1.2 ? 'accumulating' :
      totalDistribution > totalAccumulation * 1.2 ? 'distributing' : 'neutral';

    const enrichment: WhaleWatchEnrichment = {
      mint,
      threshold_usd: thresholdUsd,
      lookback_hours: lookbackHours,
      whales,
      total_whale_volume_usd: totalAccumulation + totalDistribution,
      net_flow_direction: netDirection,
      whale_count: whales.length,
      holders_source: holdersSource,
      last_updated: formatTimestamp(),
    };

    await this.cache.set(cacheKey, enrichment, CACHE_TTL.whaleWatch);
    return enrichment;
  }

  private emptyResult(mint: string, thresholdUsd: number, lookbackHours: number): WhaleWatchEnrichment {
    return {
      mint,
      threshold_usd: thresholdUsd,
      lookback_hours: lookbackHours,
      whales: [],
      total_whale_volume_usd: 0,
      net_flow_direction: 'neutral',
      whale_count: 0,
      holders_source: 'unavailable',
      last_updated: formatTimestamp(),
    };
  }
}
