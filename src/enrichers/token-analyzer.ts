import type { HeliusClient } from '../sources/helius';
import type { DexScreenerClient } from '../sources/dexscreener';
import type { SolanaRpcClient } from '../sources/solana-rpc';
import type { JupiterClient, JupiterToken, SlippageEstimate } from '../sources/jupiter';
import type { BirdeyeClient, OHLCV, TokenOverview } from '../sources/birdeye';
import type { Cache } from '../cache';
import { CACHE_TTL } from '../config';
import { parallelFetchDetailed, type ParallelTask } from '../utils/parallel';
import { formatTimestamp } from '../utils/normalize';
import type { SnapshotStore } from './snapshot-store';
import type { TransferTax, TransferTaxReader } from '../sources/token-2022';

// --- Types ---

export interface HolderConcentration {
  top1_pct: number;
  top5_pct: number;
  top10_pct: number;
  herfindahl_index: number;  // 0-10000: <1500 = distributed, 1500-2500 = moderate, >2500 = concentrated
}

export interface PriceVolatility {
  /** '7d' = real daily candles (Birdeye). '24h' = estimated from DexScreener's 1h/6h/24h changes; the *_7d
   *  fields are null then, because three intraday points cannot describe 7 days. */
  window: '7d' | '24h';
  source: 'birdeye_daily' | 'dexscreener_intraday';
  daily_std_7d: number | null;   // std dev of daily returns (%)
  high_7d: number | null;        // highest price in 7d
  low_7d: number | null;         // lowest price in 7d
  range_pct_7d: number | null;   // (high-low)/low as %
  /** 24h-window fields, set when window = '24h'. */
  intraday_std_pct?: number;
  high_24h?: number;
  low_24h?: number;
  range_pct_24h?: number;
  classification: 'LOW' | 'MODERATE' | 'HIGH' | 'EXTREME';
}

/** Which upstream reads failed for this response. degraded = a core source (DexScreener, Jupiter token,
 *  mint info) did not answer, so null fields may mean "not read" rather than "does not exist". */
export interface DataQuality {
  degraded: boolean;
  unavailable: string[];
}

export interface TokenEnrichment {
  mint: string;
  symbol: string;
  name: string;
  decimals: number;
  supply: number;
  /** Null when no source reported a count. Never the length of the top-20 holder list. */
  holder_count: number | null;
  holder_count_source: 'birdeye' | 'jupiter' | null;
  price_usd: number | null;
  price_source: 'dexscreener' | 'jupiter' | 'birdeye' | null;
  market_cap: number | null;
  volume_24h: number | null;
  price_change_24h: number;
  /** True when the token still trades on a pump.fun bonding curve (pre-migration). */
  bonding_curve: boolean;
  volatility?: PriceVolatility;
  top_holders?: Array<{
    address: string;
    balance: number;
    pct_supply: number;
  }>;
  concentration?: HolderConcentration;
  holders_source?: 'rpc' | 'birdeye' | 'unavailable';
  slippage_estimates?: SlippageEstimate[];
  /** Token-2022 transfer tax as a trading cost. Null = no fee. Absent when the read was unavailable. */
  transfer_tax?: TransferTax | null;
  /** USD liquidity. Null when no source reported it (not zero). */
  liquidity: number | null;
  liquidity_source: 'dexscreener' | 'jupiter' | 'birdeye' | null;
  risk_flags: string[];
  /** Jupiter verified status. Null when Jupiter's token API did not answer. */
  verified: boolean | null;
  mint_authority: string | null;
  freeze_authority: string | null;
  data_quality: DataQuality;
  last_updated: string;
}

/** Cache TTL for a degraded result: short, so one upstream hiccup is not served to every caller for a minute. */
const DEGRADED_TTL_SECONDS = 10;
const CORE_SOURCES = ['dexData', 'jupiterToken', 'mintInfo'];
const SOURCE_LABELS: Record<string, string> = {
  dexData: 'dexscreener',
  jupiterToken: 'jupiter_token',
  mintInfo: 'mint_info',
  slippage: 'jupiter_quote',
  largestAccounts: 'holders_rpc',
  transferTax: 'transfer_tax',
  birdeyeOverview: 'birdeye',
  birdeyeCandles: 'birdeye_candles',
};

// --- Class ---

export class TokenAnalyzer {
  private snapshotStore?: SnapshotStore;

  constructor(
    private helius: HeliusClient,
    private dexscreener: DexScreenerClient,
    private solanaRpc: SolanaRpcClient,
    private jupiter: JupiterClient,
    private cache: Cache,
    snapshotStore?: SnapshotStore,
    private birdeye?: BirdeyeClient,
    private taxReader?: TransferTaxReader,
  ) {
    this.snapshotStore = snapshotStore;
  }

  async enrich(mint: string, includeHolders = false): Promise<TokenEnrichment> {
    const cacheKey = `token:${mint}:${includeHolders ? 'holders' : 'basic'}`;
    const cached = await this.cache.get<TokenEnrichment>(cacheKey);
    if (cached) return cached;

    // Parallel fetch: DexScreener + Jupiter + on-chain mint info + slippage.
    // largestAccounts is only fetched when caller needs full holder data — that
    // RPC call times out at ~15s for high-holder tokens (BONK/JUP/USDC class)
    // and was the dominant cost on cold-cache light enrichments. Birdeye
    // overview supplies holder_count for the light path; full-path callers
    // still pay the cost because top-N holder resolution requires the addresses.
    const tasks: ParallelTask<any>[] = [
      { name: 'dexData', fn: () => this.dexscreener.getTokenData(mint) },
      { name: 'mintInfo', fn: () => this.solanaRpc.getMintInfo(mint) },
      { name: 'jupiterToken', fn: () => this.jupiter.getTokenInfo(mint) },
      { name: 'slippage', fn: () => this.jupiter.getSlippageEstimates(mint) },
    ];

    if (includeHolders) {
      tasks.push({ name: 'largestAccounts', fn: () => this.solanaRpc.getTokenLargestAccounts(mint) });
    }

    if (this.taxReader) {
      tasks.push({ name: 'transferTax', fn: () => this.taxReader!.get(mint) });
    }

    if (this.birdeye) {
      tasks.push(
        { name: 'birdeyeOverview', fn: () => this.birdeye!.getTokenOverview(mint) },
        { name: 'birdeyeCandles', fn: () => this.birdeye!.getDailyCandles(mint, 7) },
      );
    }

    const { results: fetched, failed } = await parallelFetchDetailed(tasks, 15_000);
    const unavailable = new Set(failed);

    let dexData = fetched.dexData as Awaited<ReturnType<DexScreenerClient['getTokenData']>>;
    const mintInfo = fetched.mintInfo as Awaited<ReturnType<SolanaRpcClient['getMintInfo']>>;
    const jupiterToken = fetched.jupiterToken as JupiterToken | null;

    // Retry DexScreener once if it failed — price data is critical
    if (unavailable.has('dexData')) {
      try {
        dexData = await this.dexscreener.getTokenData(mint);
        unavailable.delete('dexData');
      } catch {
        // Still failed — fields that depend on it stay null and data_quality says so
      }
    }
    const largestAccounts = (fetched.largestAccounts as Awaited<ReturnType<SolanaRpcClient['getTokenLargestAccounts']>>) ?? [];
    const slippageEstimates = (fetched.slippage as SlippageEstimate[] | null) ?? [];
    const birdeyeOverview = (fetched.birdeyeOverview as TokenOverview | null) ?? null;
    const birdeyeCandles = (fetched.birdeyeCandles as OHLCV[] | null) ?? null;
    const transferTax = this.taxReader ? ((fetched.transferTax as TransferTax | null) ?? null) : undefined;

    // Price: DexScreener, then Jupiter's token API (covers pairs that report only priceNative), then Birdeye.
    const positive = (v: number | null | undefined): number | null => (typeof v === 'number' && v > 0 && isFinite(v) ? v : null);
    const dexPrice = positive(dexData?.price);
    const jupPrice = positive(jupiterToken?.usdPrice);
    const bePrice = positive(birdeyeOverview?.price);
    const priceUsd = dexPrice ?? jupPrice ?? bePrice;
    const priceSource: TokenEnrichment['price_source'] =
      dexPrice != null ? 'dexscreener' : jupPrice != null ? 'jupiter' : bePrice != null ? 'birdeye' : null;
    const price = priceUsd ?? 0; // numeric helper for the arithmetic below; output uses priceUsd
    const decimals = mintInfo?.decimals ?? jupiterToken?.decimals ?? birdeyeOverview?.decimals ?? 0;
    const rawSupply = mintInfo?.supply ?? 0;
    const supply = decimals > 0 ? rawSupply / 10 ** decimals : rawSupply;

    // --- Price volatility ---
    // Prefer Birdeye daily candles (real OHLCV); fall back to DexScreener multi-timeframe estimate.
    let volatility: PriceVolatility | undefined;

    if (birdeyeCandles && birdeyeCandles.length >= 3) {
      const closes = birdeyeCandles.map((c) => c.close).filter((p) => p > 0 && isFinite(p));
      if (closes.length >= 3) {
        const returns: number[] = [];
        for (let i = 1; i < closes.length; i++) {
          returns.push(((closes[i] - closes[i - 1]) / closes[i - 1]) * 100);
        }
        const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
        const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
        const std = Math.sqrt(variance);

        const highs = birdeyeCandles.map((c) => c.high).filter((p) => p > 0 && isFinite(p));
        const lows = birdeyeCandles.map((c) => c.low).filter((p) => p > 0 && isFinite(p));
        const high7d = highs.length > 0 ? Math.max(...highs) : Math.max(...closes);
        const low7d = lows.length > 0 ? Math.min(...lows) : Math.min(...closes);
        const rangePct = low7d > 0 ? ((high7d - low7d) / low7d) * 100 : 0;

        const classification: PriceVolatility['classification'] =
          std > 15 ? 'EXTREME' : std > 8 ? 'HIGH' : std > 3 ? 'MODERATE' : 'LOW';

        volatility = {
          window: '7d',
          source: 'birdeye_daily',
          daily_std_7d: Math.round(std * 100) / 100,
          high_7d: Math.round(high7d * 1e8) / 1e8,
          low_7d: Math.round(low7d * 1e8) / 1e8,
          range_pct_7d: Math.round(rangePct * 100) / 100,
          classification,
        };
      }
    }

    if (!volatility && dexData && dexPrice != null) {
      const h1 = dexData.priceChange1h;
      const h6 = dexData.priceChange6h;
      const h24 = dexData.priceChange24h;

      // Reconstruct approximate prices at each timeframe
      const price1hAgo = price / (1 + h1 / 100);
      const price6hAgo = price / (1 + h6 / 100);
      const price24hAgo = price / (1 + h24 / 100);
      const prices = [price24hAgo, price6hAgo, price1hAgo, price].filter((p) => p > 0 && isFinite(p));

      if (prices.length >= 3) {
        // Compute returns between each price point
        const returns: number[] = [];
        for (let i = 1; i < prices.length; i++) {
          returns.push(((prices[i] - prices[i - 1]) / prices[i - 1]) * 100);
        }

        const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
        const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
        const std = Math.sqrt(variance);

        // Four points inside the last 24h: this is a 24h estimate, so the 7d fields stay null.
        const high24h = Math.max(...prices);
        const low24h = Math.min(...prices);
        const rangePct = low24h > 0 ? ((high24h - low24h) / low24h) * 100 : 0;

        const classification: PriceVolatility['classification'] =
          std > 15 ? 'EXTREME' : std > 8 ? 'HIGH' : std > 3 ? 'MODERATE' : 'LOW';

        volatility = {
          window: '24h',
          source: 'dexscreener_intraday',
          daily_std_7d: null,
          high_7d: null,
          low_7d: null,
          range_pct_7d: null,
          intraday_std_pct: Math.round(std * 100) / 100,
          high_24h: Math.round(high24h * 1e8) / 1e8,
          low_24h: Math.round(low24h * 1e8) / 1e8,
          range_pct_24h: Math.round(rangePct * 100) / 100,
          classification,
        };
      }
    }

    // --- Holder concentration ---
    // Path A: Helius RPC (getTokenLargestAccounts). Returns token-account addresses
    // that need resolving to owner wallets. Returns [] for tokens with too many
    // holders (BONK, USDC, JUP-class) due to RPC limits.
    // Path B: Birdeye fallback (/defi/v3/token/holder). Returns owner addresses
    // directly. No resolve step needed.
    let topHolders: TokenEnrichment['top_holders'];
    let concentration: HolderConcentration | undefined;
    let holdersSource: 'rpc' | 'birdeye' | 'unavailable' = 'unavailable';
    let holders: Array<{ address: string; uiAmount: number; isOwnerAddress: boolean }> = [];

    if (largestAccounts.length > 0) {
      // Path A — RPC. Resolve token accounts → owner wallets.
      let ownerMap: Array<{ tokenAccount: string; owner: string | null }> = [];
      try {
        ownerMap = await this.solanaRpc.resolveTokenAccountOwners(
          largestAccounts.map((a) => a.address),
        );
      } catch {
        try {
          ownerMap = await this.solanaRpc.resolveTokenAccountOwners(
            largestAccounts.map((a) => a.address),
          );
        } catch {
          ownerMap = largestAccounts.map((a) => ({ tokenAccount: a.address, owner: null }));
        }
      }
      holders = largestAccounts.map((a, i) => ({
        address: ownerMap[i]?.owner ?? a.address,
        uiAmount: a.uiAmount,
        isOwnerAddress: !!ownerMap[i]?.owner,
      }));
      holdersSource = 'rpc';
    } else if (this.birdeye) {
      // Path B — Birdeye fallback for high-holder-count tokens.
      try {
        const birdeyeHolders = await this.birdeye.getTokenHolders(mint, 20);
        const usable = birdeyeHolders.filter((h) => h.uiAmount > 0);
        if (usable.length > 0) {
          holders = usable.map((h) => ({
            address: h.address,
            uiAmount: h.uiAmount,
            isOwnerAddress: true,
          }));
          holdersSource = 'birdeye';
        }
      } catch {
        // Birdeye also failed — fall through to "unavailable"
      }
    }

    if (holders.length > 0 && supply > 0) {
      topHolders = holders.map((h) => ({
        address: h.address,
        balance: h.uiAmount,
        pct_supply: (h.uiAmount / supply) * 100,
        ...(h.isOwnerAddress ? {} : { is_token_account: true }),
      }));

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

    // --- Liquidity, holder count, market cap: first source that reported a value; null when none did ---
    const nonNeg = (v: number | null | undefined): number | null => (typeof v === 'number' && v >= 0 && isFinite(v) ? v : null);
    const dexLiq = nonNeg(dexData?.liquidity);
    const jupLiq = nonNeg(jupiterToken?.liquidity);
    const beLiq = nonNeg(birdeyeOverview?.liquidity);
    const liquidity = dexLiq ?? jupLiq ?? beLiq;
    const liquiditySource: TokenEnrichment['liquidity_source'] =
      dexLiq != null ? 'dexscreener' : jupLiq != null ? 'jupiter' : beLiq != null ? 'birdeye' : null;

    // Birdeye first, then Jupiter's token API. Never the top-20 holder list length: that is a cap, not a count.
    const beHolders = nonNeg(birdeyeOverview?.holder);
    const jupHolders = nonNeg(jupiterToken?.holderCount);
    const holderCount = beHolders ?? jupHolders;
    const holderCountSource: TokenEnrichment['holder_count_source'] =
      beHolders != null ? 'birdeye' : jupHolders != null ? 'jupiter' : null;

    const marketCap = positive(dexData?.marketCap) ?? positive(jupiterToken?.mcap) ?? positive(birdeyeOverview?.marketCap)
      ?? (priceUsd != null && supply > 0 ? priceUsd * supply : null);
    const volume24h = dexData ? dexData.volume24h : (nonNeg(birdeyeOverview?.volume24h));
    const verified: boolean | null = jupiterToken ? jupiterToken.verified === true : null;
    const bondingCurve = dexData?.bondingCurve === true;

    // --- Risk flags ---
    const riskFlags: string[] = [];

    // Only from a measured value: unknown liquidity is reported as null + data_quality, not as low.
    if (liquidity != null && liquidity < 50_000) {
      riskFlags.push('low_liquidity');
    }
    if (mintInfo && mintInfo.mintAuthority !== null) {
      riskFlags.push('mint_authority_active');
    }
    if (mintInfo && mintInfo.freezeAuthority !== null) {
      riskFlags.push('freeze_authority_active');
    }
    if (verified === false) {
      riskFlags.push('unverified');
    }
    if (volatility && volatility.classification === 'EXTREME') {
      riskFlags.push('extreme_volatility');
    } else if (volatility && volatility.classification === 'HIGH') {
      riskFlags.push('high_volatility');
    } else if (dexData && Math.abs(dexData.priceChange24h) > 20) {
      riskFlags.push('high_volatility');
    }
    if (concentration && concentration.top1_pct > 50) {
      riskFlags.push('high_concentration');
    }
    if (concentration && concentration.top5_pct > 80) {
      riskFlags.push('whale_dominated');
    }
    // High slippage at $1K = illiquid for most trading agents
    const slippage1k = slippageEstimates.find((s) => s.size_usd === 1000);
    if (slippage1k && Math.abs(slippage1k.price_impact_pct) > 5) {
      riskFlags.push('high_slippage');
    }
    // A transfer tax is a cost on every buy AND sell (StonkFun reward coins: 100/300 bps).
    if (transferTax && transferTax.bps > 0) {
      riskFlags.push('transfer_tax');
    }

    // --- Data quality ---
    // Birdeye is optional (free credits ran out 2026-10-08), so its absence is listed but does not mark degraded.
    if (this.birdeye && !birdeyeOverview) unavailable.add('birdeyeOverview');
    if (slippageEstimates.length === 0) unavailable.add('slippage'); // no quote answered (or no route)
    const dataQuality: DataQuality = {
      degraded: CORE_SOURCES.some((s) => unavailable.has(s)),
      unavailable: [...unavailable].map((s) => SOURCE_LABELS[s] ?? s).sort(),
    };

    // --- Assemble ---
    const enrichment: TokenEnrichment = {
      mint,
      symbol: dexData?.symbol ?? jupiterToken?.symbol ?? birdeyeOverview?.symbol ?? '',
      name: dexData?.name ?? jupiterToken?.name ?? birdeyeOverview?.name ?? '',
      decimals,
      supply,
      holder_count: holderCount,
      holder_count_source: holderCountSource,
      price_usd: priceUsd,
      price_source: priceSource,
      market_cap: marketCap,
      volume_24h: volume24h,
      price_change_24h: dexData?.priceChange24h ?? birdeyeOverview?.priceChange24h ?? 0,
      bonding_curve: bondingCurve,
      volatility,
      top_holders: topHolders,
      concentration,
      holders_source: holdersSource,
      slippage_estimates: slippageEstimates.length > 0 ? slippageEstimates : undefined,
      ...(transferTax !== undefined ? { transfer_tax: transferTax } : {}),
      liquidity,
      liquidity_source: liquiditySource,
      risk_flags: riskFlags,
      verified,
      mint_authority: mintInfo?.mintAuthority ?? null,
      freeze_authority: mintInfo?.freezeAuthority ?? null,
      data_quality: dataQuality,
      last_updated: formatTimestamp(),
    };

    // Only cache if we got meaningful data — don't cache failures. A degraded result gets a short TTL.
    if (price > 0 || enrichment.symbol) {
      await this.cache.set(cacheKey, enrichment, dataQuality.degraded ? DEGRADED_TTL_SECONDS : CACHE_TTL.tokenPrice);
    }

    // Fire-and-forget snapshot capture (one per day per mint)
    if (this.snapshotStore && price > 0) {
      this.snapshotStore.captureTokenSnapshot(enrichment).catch(() => {});
    }

    return enrichment;
  }
}
