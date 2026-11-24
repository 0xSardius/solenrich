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
import { PublicKey } from '@solana/web3.js';

export interface WhaleActivity {
  address: string;
  entity_label?: string;
  entity_type?: string;
  /** Null when the token price was not read (not $0). */
  balance_usd: number | null;
  /** Null when the mint account (supply) was not read. */
  pct_supply: number | null;
  transaction_count: number;
  total_volume_usd: number;
  avg_transaction_usd: number;
  buy_volume_usd: number;
  sell_volume_usd: number;
  /** 'unknown' when the token price or the transaction read was unavailable (volumes are then not measured). */
  flow_direction: FlowDirection;
  last_activity: string;
}

export type FlowDirection = 'accumulating' | 'distributing' | 'neutral' | 'unknown';

/** A large holder owned by a program (AMM pool vault, bonding curve, locker), not a wallet. Its transfers are
 *  retail trading against the pool, so they are NOT counted as whale flow (2026-11-17: they were, sign inverted). */
export interface ProgramAccountHolder {
  owner: string;
  token_account: string;
  pct_supply: number | null;
  balance_usd: number | null;
  entity_label?: string;
}

export interface WhaleWatchEnrichment {
  mint: string;
  threshold_usd: number;
  lookback_hours: number;
  /** Wallet-owned top holders only (owner on the ed25519 curve). */
  whales: WhaleActivity[];
  /** Program-owned large holders (owner is a PDA): pools, curves, lockers. Listed, not counted in flow. */
  program_accounts: ProgramAccountHolder[];
  total_whale_volume_usd: number;
  net_flow_direction: FlowDirection;
  whale_count: number;
  holders_source: 'rpc' | 'birdeye' | 'unavailable';
  /**
   * How much of lookback_hours was actually read. Each holder's token account is read to 50 signatures; a busy one
   * (exchange, market maker) fills 50 in minutes, so its flow covers less than the window (audit #48).
   */
  coverage?: {
    holders_fully_covered: number;
    holders_partial: number;
    /** Oldest signature read among partially covered holders — flow for them starts here, not at the window start. */
    partial_from: string | null;
    /** Signatures inside the window that were not parsed (the union is capped at 100). */
    signatures_not_parsed: number;
  };
  data_quality: { degraded: boolean; unavailable: string[] };
  last_updated: string;
}

/** True for a normal wallet address (on the ed25519 curve); false for a program-derived address (PDA). */
export function isWalletAddress(address: string): boolean {
  try { return PublicKey.isOnCurve(new PublicKey(address).toBytes()); } catch { return true; }
}

const WHALES_MAX = 10;

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
    const priced = tokenPrice > 0;
    const usd = (tokens: number): number | null => (priced ? tokens * tokenPrice : null);
    // Supply unread (mint account failed): shares of supply are unknown, not 0%.
    const pctOf = (ui: number): number | null => (mintInfo && supply > 0 ? Math.round((ui / supply) * 100 * 100) / 100 : null);
    let holders: Array<{ walletAddress: string; tokenAccount: string; balance: number; pctSupply: number | null }> = [];
    const programAccounts: ProgramAccountHolder[] = [];
    let holdersSource: 'rpc' | 'birdeye' | 'unavailable' = 'unavailable';

    if (largestAccounts.length > 0) {
      // Path A — RPC. Resolve token-account → owner for all (≤ 20) largest accounts, then keep the first
      // WHALES_MAX wallet-owned ones as whales; program-owned ones (pools, curves, lockers) are listed apart.
      const topN = largestAccounts.slice(0, 20);
      let ownerMap: Array<{ tokenAccount: string; owner: string | null }> = [];
      try {
        ownerMap = await this.solanaRpc.resolveTokenAccountOwners(topN.map((a) => a.address));
      } catch {
        ownerMap = topN.map((a) => ({ tokenAccount: a.address, owner: null }));
      }
      topN.forEach((account, i) => {
        const owner = ownerMap[i]?.owner ?? null;
        const pctSupply = pctOf(account.uiAmount);
        if (owner && !isWalletAddress(owner)) {
          const entity = lookupEntity(owner);
          programAccounts.push({ owner, token_account: account.address, pct_supply: pctSupply,
            balance_usd: usd(account.uiAmount), ...(entity ? { entity_label: entity.label } : {}) });
        } else if (holders.length < WHALES_MAX) {
          holders.push({ walletAddress: owner ?? account.address, tokenAccount: account.address, balance: account.uiAmount, pctSupply });
        }
      });
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
            pctSupply: pctOf(h.uiAmount),
          }));
          holdersSource = 'birdeye';
        }
      } catch {
        // fall through to empty
      }
    }

    if (holders.length === 0) {
      return { ...this.emptyResult(mint, thresholdUsd, lookbackHours), program_accounts: programAccounts, holders_source: holdersSource };
    }
    const unavailable: string[] = [];
    if (!priced) unavailable.push('price');
    const supplyUnread = !mintInfo;

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
    let fullyCovered = 0;
    let partial = 0;
    let partialFrom: number | null = null;

    for (const holder of holders) {
      const sigs = (sigResults[`sigs:${holder.tokenAccount}`] as Array<{ signature: string; blockTime: number | null }>) ?? [];
      for (const sig of sigs) {
        if ((sig.blockTime ?? 0) >= cutoff) {
          signatureSet.add(sig.signature);
        }
      }
      // A full page whose oldest signature is still inside the window: older activity in the window was not read.
      const oldest = sigs.length ? Math.min(...sigs.map((s) => s.blockTime ?? Infinity)) : Infinity;
      if (sigs.length >= 50 && oldest >= cutoff && Number.isFinite(oldest)) {
        partial++;
        partialFrom = partialFrom == null ? oldest : Math.max(partialFrom, oldest);
      } else fullyCovered++;
    }

    // Phase 4: Batch fetch enhanced transactions
    const sigStrings = [...signatureSet].slice(0, 100);
    const notParsed = Math.max(0, signatureSet.size - sigStrings.length);
    let txs: EnhancedTransaction[] = [];
    if (sigStrings.length > 0) {
      try {
        txs = await this.helius.getEnhancedTransactions(sigStrings);
      } catch {
        unavailable.push('enhanced_tx'); // flows not read: direction becomes 'unknown'
      }
    }
    // Without a price the USD threshold cannot apply, and without transactions there is nothing to count.
    const flowsUnknown = unavailable.length > 0;

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

      const direction: WhaleActivity['flow_direction'] = flowsUnknown ? 'unknown' :
        buyVol > sellVol * 1.2 ? 'accumulating' :
        sellVol > buyVol * 1.2 ? 'distributing' : 'neutral';

      totalAccumulation += buyVol;
      totalDistribution += sellVol;

      const entity = lookupEntity(holder.walletAddress);
      return {
        address: holder.walletAddress,
        ...(entity ? { entity_label: entity.label, entity_type: entity.type } : {}),
        balance_usd: usd(holder.balance),
        pct_supply: holder.pctSupply,
        transaction_count: vol?.count ?? 0,
        total_volume_usd: totalVolume,
        avg_transaction_usd: vol && vol.count > 0 ? totalVolume / vol.count : 0,
        buy_volume_usd: buyVol,
        sell_volume_usd: sellVol,
        flow_direction: direction,
        last_activity: vol?.lastTime ? new Date(vol.lastTime * 1000).toISOString() : 'none',
      };
    });

    // Sort by balance (largest holders first). Holders arrive largest-first from the RPC; keep that order when
    // no price is known.
    whales.sort((a, b) => (b.balance_usd ?? 0) - (a.balance_usd ?? 0));

    const netDirection: WhaleWatchEnrichment['net_flow_direction'] = flowsUnknown ? 'unknown' :
      totalAccumulation > totalDistribution * 1.2 ? 'accumulating' :
      totalDistribution > totalAccumulation * 1.2 ? 'distributing' : 'neutral';

    const enrichment: WhaleWatchEnrichment = {
      mint,
      threshold_usd: thresholdUsd,
      lookback_hours: lookbackHours,
      whales,
      program_accounts: programAccounts,
      total_whale_volume_usd: totalAccumulation + totalDistribution,
      net_flow_direction: netDirection,
      whale_count: whales.length,
      holders_source: holdersSource,
      coverage: {
        holders_fully_covered: fullyCovered,
        holders_partial: partial,
        partial_from: partialFrom != null ? new Date(partialFrom * 1000).toISOString() : null,
        signatures_not_parsed: notParsed,
      },
      data_quality: { degraded: flowsUnknown || supplyUnread, unavailable: supplyUnread ? [...unavailable, 'mint_info'] : unavailable },
      last_updated: formatTimestamp(),
    };

    // A result without price or transactions is cached briefly, so the next call reads again.
    await this.cache.set(cacheKey, enrichment, flowsUnknown || supplyUnread ? 15 : CACHE_TTL.whaleWatch);
    return enrichment;
  }

  private emptyResult(mint: string, thresholdUsd: number, lookbackHours: number): WhaleWatchEnrichment {
    return {
      mint,
      threshold_usd: thresholdUsd,
      lookback_hours: lookbackHours,
      whales: [],
      program_accounts: [],
      total_whale_volume_usd: 0,
      // No holders read = flow not measured.
      net_flow_direction: 'unknown',
      whale_count: 0,
      holders_source: 'unavailable',
      data_quality: { degraded: true, unavailable: ['holders'] },
      last_updated: formatTimestamp(),
    };
  }
}
