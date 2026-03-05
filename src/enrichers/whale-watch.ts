import type { HeliusClient, EnhancedTransaction } from '../sources/helius';
import type { BirdeyeClient } from '../sources/birdeye';
import type { Cache } from '../cache';
import { CACHE_TTL } from '../config';
import { parallelFetch, type ParallelTask } from '../utils/parallel';
import { formatTimestamp } from '../utils/normalize';

export interface WhaleActivity {
  address: string;
  transaction_count: number;
  total_volume_usd: number;
  avg_transaction_usd: number;
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
  last_updated: string;
}

export class WhaleWatcher {
  constructor(
    private helius: HeliusClient,
    private birdeye: BirdeyeClient,
    private cache: Cache,
  ) {}

  async enrich(
    mint: string,
    thresholdUsd: number,
    lookbackHours: number,
  ): Promise<WhaleWatchEnrichment> {
    const cacheKey = `whalewatch:${mint}:${thresholdUsd}:${lookbackHours}`;
    const cached = await this.cache.get<WhaleWatchEnrichment>(cacheKey);
    if (cached) return cached;

    // Fetch token price and recent signatures in parallel
    const tasks: ParallelTask<any>[] = [
      { name: 'price', fn: () => this.birdeye.getTokenPrice(mint), fallback: { value: 0 } },
      { name: 'signatures', fn: () => this.helius.getSignaturesForAddress(mint, 100) },
    ];
    const fetched = await parallelFetch(tasks);

    const tokenPrice = (fetched.price as { value: number } | null)?.value ?? 0;
    const signatures = (fetched.signatures as Array<{ signature: string; blockTime: number | null }> | null) ?? [];

    // Filter to lookback window
    const cutoff = Date.now() / 1000 - lookbackHours * 3600;
    const recentSigs = signatures.filter((s) => (s.blockTime ?? 0) >= cutoff);

    // Fetch enhanced transactions (batch, max 100)
    const sigStrings = recentSigs.slice(0, 100).map((s) => s.signature);
    let txs: EnhancedTransaction[] = [];
    if (sigStrings.length > 0) {
      try {
        txs = await this.helius.getEnhancedTransactions(sigStrings);
      } catch {
        // Graceful degradation
      }
    }

    // Aggregate per-wallet volumes
    const walletVolumes = new Map<string, { buy: number; sell: number; count: number; lastTime: number }>();

    for (const tx of txs) {
      if (!tx.tokenTransfers) continue;
      for (const transfer of tx.tokenTransfers) {
        if (transfer.mint !== mint) continue;

        const amountUsd = transfer.tokenAmount * tokenPrice;
        if (amountUsd < thresholdUsd) continue;

        // Buyer
        if (transfer.toUserAccount) {
          const entry = walletVolumes.get(transfer.toUserAccount) ?? { buy: 0, sell: 0, count: 0, lastTime: 0 };
          entry.buy += amountUsd;
          entry.count++;
          entry.lastTime = Math.max(entry.lastTime, tx.timestamp);
          walletVolumes.set(transfer.toUserAccount, entry);
        }

        // Seller
        if (transfer.fromUserAccount) {
          const entry = walletVolumes.get(transfer.fromUserAccount) ?? { buy: 0, sell: 0, count: 0, lastTime: 0 };
          entry.sell += amountUsd;
          entry.count++;
          entry.lastTime = Math.max(entry.lastTime, tx.timestamp);
          walletVolumes.set(transfer.fromUserAccount, entry);
        }
      }
    }

    // Build whale list
    const whales: WhaleActivity[] = [];
    let totalAccumulation = 0;
    let totalDistribution = 0;

    for (const [address, vol] of walletVolumes) {
      const totalVolume = vol.buy + vol.sell;
      const direction: WhaleActivity['flow_direction'] =
        vol.buy > vol.sell * 1.2 ? 'accumulating' :
        vol.sell > vol.buy * 1.2 ? 'distributing' : 'neutral';

      totalAccumulation += vol.buy;
      totalDistribution += vol.sell;

      whales.push({
        address,
        transaction_count: vol.count,
        total_volume_usd: totalVolume,
        avg_transaction_usd: totalVolume / vol.count,
        flow_direction: direction,
        last_activity: new Date(vol.lastTime * 1000).toISOString(),
      });
    }

    // Sort by volume descending
    whales.sort((a, b) => b.total_volume_usd - a.total_volume_usd);

    const netDirection: WhaleWatchEnrichment['net_flow_direction'] =
      totalAccumulation > totalDistribution * 1.2 ? 'accumulating' :
      totalDistribution > totalAccumulation * 1.2 ? 'distributing' : 'neutral';

    const enrichment: WhaleWatchEnrichment = {
      mint,
      threshold_usd: thresholdUsd,
      lookback_hours: lookbackHours,
      whales: whales.slice(0, 20),
      total_whale_volume_usd: totalAccumulation + totalDistribution,
      net_flow_direction: netDirection,
      whale_count: whales.length,
      last_updated: formatTimestamp(),
    };

    await this.cache.set(cacheKey, enrichment, CACHE_TTL.whaleWatch);
    return enrichment;
  }
}
