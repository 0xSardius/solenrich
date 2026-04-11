import type { DefiLlamaClient, ProtocolDetail, YieldPool } from '../sources/defi-llama';
import type { HeliusClient, EnhancedTransaction } from '../sources/helius';
import type { Cache } from '../cache';
import { CACHE_TTL } from '../config';
import { parallelFetch, type ParallelTask } from '../utils/parallel';
import { formatTimestamp } from '../utils/normalize';
import { detectRegularIntervals, detectHighFrequency } from './labeler';

// --- Protocol registry ---

interface ProtocolEntry {
  slug: string;
  name: string;
  programId: string;
  defiLlamaSlug: string;
}

const PROTOCOL_REGISTRY: ProtocolEntry[] = [
  { slug: 'raydium',   name: 'Raydium',          programId: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', defiLlamaSlug: 'raydium' },
  { slug: 'orca',      name: 'Orca',             programId: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', defiLlamaSlug: 'orca' },
  { slug: 'marginfi',  name: 'marginfi',         programId: 'MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA', defiLlamaSlug: 'marginfi' },
  { slug: 'drift',     name: 'Drift Protocol',   programId: 'dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH', defiLlamaSlug: 'drift' },
  { slug: 'jupiter',   name: 'Jupiter',          programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', defiLlamaSlug: 'jupiter-aggregator' },
  { slug: 'kamino',    name: 'Kamino Finance',   programId: '6LtLpnUFNByNXLyCoK9wA2MykKAmQNZKBdY8s47dehDc', defiLlamaSlug: 'kamino' },
  { slug: 'marinade',  name: 'Marinade Finance', programId: 'MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD', defiLlamaSlug: 'marinade-finance' },
  { slug: 'jito',      name: 'Jito',             programId: 'Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb', defiLlamaSlug: 'jito' },
];

const slugMap = new Map(PROTOCOL_REGISTRY.map((p) => [p.slug.toLowerCase(), p]));
const programIdMap = new Map(PROTOCOL_REGISTRY.map((p) => [p.programId, p]));

// --- Types ---

export interface ProtocolProfileEnrichment {
  protocol: {
    name: string;
    slug: string;
    program_id: string | null;
    category: string;
    logo?: string;
    url?: string;
  };
  tvl: {
    total_usd: number;
    solana_usd: number;
    chains: Record<string, number>;
    solana_dominance_pct: number;
  };
  yields: {
    pool_count: number;
    top_pools: Array<{
      symbol: string;
      apy: number;
      apy_base?: number;
      apy_reward?: number;
      tvl_usd: number;
    }>;
    avg_apy: number;
    median_apy: number;
    total_yield_tvl_usd: number;
  } | null;
  activity: {
    recent_tx_count: number;
    unique_signers: number;
    tx_types: Record<string, number>;
    avg_tx_per_hour: number;
    sample_window_minutes: number;
    automated_activity_pct: number; // % of signers showing automated behavior (regular_intervals or high_frequency)
  } | null;
  health_signals: {
    tvl_tier: 'mega' | 'large' | 'mid' | 'small' | 'micro';
    yield_attractiveness: 'high' | 'moderate' | 'low' | null;
    activity_level: 'very_high' | 'high' | 'moderate' | 'low' | null;
  };
  last_updated: string;
}

// --- Enricher ---

export class ProtocolAnalyzer {
  constructor(
    private defiLlama: DefiLlamaClient,
    private helius: HeliusClient,
    private cache: Cache,
  ) {}

  async enrich(input: string, includeYields: boolean): Promise<ProtocolProfileEnrichment> {
    const entry = await this.resolveProtocol(input);
    if (!entry) throw new Error(`Unknown protocol: ${input}`);

    const cacheKey = `protocol-profile:${entry.slug}:${includeYields}`;
    const cached = await this.cache.get<ProtocolProfileEnrichment>(cacheKey);
    if (cached) return cached;

    // Phase 1: parallel fetch
    const tasks: ParallelTask<any>[] = [
      { name: 'tvl', fn: () => this.defiLlama.getProtocolTvl(entry.defiLlamaSlug), fallback: null },
    ];
    if (includeYields) {
      tasks.push({ name: 'yields', fn: () => this.defiLlama.getYields(), fallback: [] });
    }
    if (entry.programId) {
      tasks.push({
        name: 'sigs',
        fn: () => this.helius.getSignaturesForAddress(entry.programId, 100),
        fallback: [],
      });
    }

    const fetched = await parallelFetch(tasks, 15_000);
    const tvlData = fetched.tvl as ProtocolDetail | null;
    const allYields = (fetched.yields as YieldPool[] | null) ?? [];
    const sigs1 = (fetched.sigs as Array<{ signature: string; blockTime: number | null }>) ?? [];

    // Phase 2: fetch page 2 of signatures if page 1 was full
    let allSigs = [...sigs1];
    if (entry.programId && sigs1.length === 100) {
      try {
        const lastSig = sigs1[sigs1.length - 1].signature;
        const sigs2 = await this.helius.getSignaturesForAddress(entry.programId, 100, lastSig);
        allSigs = [...sigs1, ...sigs2];
      } catch {
        // Page 2 failed — proceed with page 1 only
      }
    }

    // Phase 3: parse enhanced transactions for activity metrics
    let activity: ProtocolProfileEnrichment['activity'] = null;
    if (allSigs.length > 0) {
      activity = await this.computeActivity(allSigs);
    }

    // Phase 4: yield aggregation
    let yields: ProtocolProfileEnrichment['yields'] = null;
    if (includeYields && allYields.length > 0) {
      yields = this.aggregateYields(allYields, entry.defiLlamaSlug);
    }

    // Phase 5: TVL + health signals
    // tvlData.chains may have { Solana: X, Ethereum: Y, ... } from full endpoint,
    // or { total: X } from lightweight fallback
    const chains = tvlData?.chains ?? {};
    const solanaTvl = chains.Solana ?? tvlData?.tvl ?? 0;
    const chainSum = Object.entries(chains)
      .filter(([k]) => !['borrowed', 'staking', 'pool2', 'vesting', 'total'].includes(k))
      .reduce((s, [, v]) => s + v, 0);
    const totalTvl = chains.total ?? (chainSum > 0 ? chainSum : solanaTvl);

    const enrichment: ProtocolProfileEnrichment = {
      protocol: {
        name: entry.name,
        slug: entry.slug,
        program_id: entry.programId || null,
        category: tvlData?.category ?? 'Unknown',
        logo: (entry as any).logo,
        url: (entry as any).url,
      },
      tvl: {
        total_usd: totalTvl,
        solana_usd: solanaTvl,
        chains: tvlData?.chains ?? {},
        solana_dominance_pct: totalTvl > 0 ? Math.round((solanaTvl / totalTvl) * 1000) / 10 : 100,
      },
      yields,
      activity,
      health_signals: {
        tvl_tier: this.getTvlTier(totalTvl),
        yield_attractiveness: yields ? this.getYieldAttractiveness(yields.median_apy) : null,
        activity_level: activity ? this.getActivityLevel(activity.avg_tx_per_hour) : null,
      },
      last_updated: formatTimestamp(),
    };

    await this.cache.set(cacheKey, enrichment, CACHE_TTL.protocolProfile);
    return enrichment;
  }

  // --- Resolution ---

  private async resolveProtocol(input: string): Promise<(ProtocolEntry & { logo?: string; url?: string }) | null> {
    // Check static registry by slug
    const bySlug = slugMap.get(input.toLowerCase());
    if (bySlug) return bySlug;

    // Check by program ID
    const byPid = programIdMap.get(input);
    if (byPid) return byPid;

    // Dynamic fallback: search DeFi Llama protocol list
    try {
      const protocols = await this.defiLlama.getSolanaProtocols();
      const match = protocols.find(
        (p) => p.slug.toLowerCase() === input.toLowerCase() || p.name.toLowerCase() === input.toLowerCase(),
      );
      if (match) {
        return {
          slug: match.slug,
          name: match.name,
          programId: '',
          defiLlamaSlug: match.slug,
          logo: match.logo,
          url: match.url,
        };
      }
    } catch {
      // DeFi Llama lookup failed
    }

    return null;
  }

  // --- Activity computation ---

  private async computeActivity(
    sigs: Array<{ signature: string; blockTime: number | null }>,
  ): Promise<ProtocolProfileEnrichment['activity']> {
    // Batch parse signatures (max 100 per batch)
    const signatures = sigs.map((s) => s.signature);
    const batches: string[][] = [];
    for (let i = 0; i < signatures.length; i += 100) {
      batches.push(signatures.slice(i, i + 100));
    }

    let allTxs: EnhancedTransaction[] = [];
    for (const batch of batches) {
      try {
        const txs = await this.helius.getEnhancedTransactions(batch);
        allTxs = allTxs.concat(txs);
      } catch {
        // Batch failed — continue with what we have
      }
    }

    // Unique signers + per-signer timestamps for behavioral analysis
    const signerTimestamps = new Map<string, number[]>();
    const txTypes: Record<string, number> = {};

    for (const tx of allTxs) {
      if (tx.feePayer) {
        const ts = signerTimestamps.get(tx.feePayer) ?? [];
        if (tx.timestamp > 0) ts.push(tx.timestamp);
        signerTimestamps.set(tx.feePayer, ts);
      }
      const type = tx.type || 'UNKNOWN';
      txTypes[type] = (txTypes[type] || 0) + 1;
    }

    const signers = new Set(signerTimestamps.keys());

    // Time window
    const blockTimes = sigs
      .map((s) => s.blockTime)
      .filter((t): t is number => t !== null && t > 0);

    let sampleWindowMinutes = 0;
    let avgTxPerHour = 0;
    if (blockTimes.length >= 2) {
      const newest = Math.max(...blockTimes);
      const oldest = Math.min(...blockTimes);
      sampleWindowMinutes = Math.round((newest - oldest) / 60);
      if (sampleWindowMinutes > 0) {
        avgTxPerHour = Math.round((allTxs.length / sampleWindowMinutes) * 60);
      }
    }

    // Behavioral analysis: what % of signers show automated patterns?
    let automatedSignerCount = 0;
    for (const [, timestamps] of signerTimestamps) {
      if (timestamps.length < 5) continue; // need enough data to detect patterns
      if (detectRegularIntervals(timestamps) || detectHighFrequency(timestamps)) {
        automatedSignerCount++;
      }
    }
    const signersWithEnoughData = [...signerTimestamps.values()].filter((ts) => ts.length >= 5).length;
    const automatedActivityPct = signersWithEnoughData > 0
      ? Math.round((automatedSignerCount / signersWithEnoughData) * 1000) / 10
      : 0;

    return {
      recent_tx_count: allTxs.length,
      unique_signers: signers.size,
      tx_types: txTypes,
      avg_tx_per_hour: avgTxPerHour,
      sample_window_minutes: sampleWindowMinutes,
      automated_activity_pct: automatedActivityPct,
    };
  }

  // --- Yield aggregation ---

  private aggregateYields(allYields: YieldPool[], projectSlug: string): ProtocolProfileEnrichment['yields'] {
    const slug = projectSlug.toLowerCase();
    const pools = allYields.filter(
      (p) => {
        const proj = p.project.toLowerCase();
        return proj === slug || proj.startsWith(slug + '-') || proj.startsWith(slug + '_');
      },
    );

    if (pools.length === 0) return { pool_count: 0, top_pools: [], avg_apy: 0, median_apy: 0, total_yield_tvl_usd: 0 };

    // Sort by TVL descending
    const sorted = [...pools].sort((a, b) => b.tvlUsd - a.tvlUsd);

    const apys = pools.map((p) => p.apy).filter((a) => a > 0 && isFinite(a)).sort((a, b) => a - b);
    const avgApy = apys.length > 0 ? apys.reduce((s, a) => s + a, 0) / apys.length : 0;
    const medianApy = apys.length > 0 ? apys[Math.floor(apys.length / 2)] : 0;
    const totalTvl = pools.reduce((s, p) => s + p.tvlUsd, 0);

    return {
      pool_count: pools.length,
      top_pools: sorted.slice(0, 10).map((p) => ({
        symbol: p.symbol,
        apy: Math.round(p.apy * 100) / 100,
        apy_base: p.apyBase != null ? Math.round(p.apyBase * 100) / 100 : undefined,
        apy_reward: p.apyReward != null ? Math.round(p.apyReward * 100) / 100 : undefined,
        tvl_usd: p.tvlUsd,
      })),
      avg_apy: Math.round(avgApy * 100) / 100,
      median_apy: Math.round(medianApy * 100) / 100,
      total_yield_tvl_usd: totalTvl,
    };
  }

  // --- Health signals ---

  private getTvlTier(tvl: number): ProtocolProfileEnrichment['health_signals']['tvl_tier'] {
    if (tvl >= 1_000_000_000) return 'mega';
    if (tvl >= 100_000_000) return 'large';
    if (tvl >= 10_000_000) return 'mid';
    if (tvl >= 1_000_000) return 'small';
    return 'micro';
  }

  private getYieldAttractiveness(medianApy: number): 'high' | 'moderate' | 'low' {
    if (medianApy >= 10) return 'high';
    if (medianApy >= 3) return 'moderate';
    return 'low';
  }

  private getActivityLevel(txPerHour: number): 'very_high' | 'high' | 'moderate' | 'low' {
    if (txPerHour >= 500) return 'very_high';
    if (txPerHour >= 100) return 'high';
    if (txPerHour >= 20) return 'moderate';
    return 'low';
  }
}
