import type { HeliusClient } from '../sources/helius';
import type { DexScreenerClient } from '../sources/dexscreener';
import type { CopyTradeAnalyzer, RecentBuy } from './copy-trade-analyzer';
import type { Cache } from '../cache';
import { CACHE_TTL } from '../config';
import { formatTimestamp } from '../utils/normalize';
import {
  TRENCHES_SMART_MONEY_SEEDS,
  TRENCHES_CONVICTION_HOLDERS,
  TRENCHES_SEEDS_DERIVED_AT,
  TX_PER_H_FILTER,
  TX_PER_H_FLAG,
} from './trenches-smart-money-seeds';

export type TrenchesWalletType = 'active_trader' | 'conviction_holder';

export interface TrenchesBuy {
  wallet: string;
  wallet_type: TrenchesWalletType;
  /** Vetting-time copy-trade win rate for active traders; null for holders / unpriced. */
  seed_win_rate: number | null;
  /** Realized 1W PnL (USD) at seed-derivation time; null for conviction holders. */
  seed_realized_1w_usd: number | null;
  /** USD spent on this buy (from the quote leg); null when unpriceable. */
  spent_usd: number | null;
  minutes_ago: number;
  /** Seed showed elevated (but sub-bot) cadence on this scan's live check. */
  elevated_cadence: boolean;
}

export interface TrenchesTokenSignal {
  mint: string;
  symbol: string | null;
  token_age_hours: number;
  /** Distinct proven-winner wallets that bought within the window — THE signal. */
  smart_buyers: number;
  conviction_holder_buyers: number;
  total_spent_usd: number;
  most_recent_buy_minutes_ago: number;
  liquidity_usd: number | null;
  market_cap_usd: number | null;
  price_usd: number | null;
  buys: TrenchesBuy[];
}

export interface SmartMoneyTrenchesResult {
  signals: TrenchesTokenSignal[];
  seeds_scanned: number;
  /** Seeds skipped this scan: live cadence at/above the bot threshold. */
  seeds_skipped_bot_cadence: string[];
  /** Seeds kept but tagged: elevated (sub-bot) live cadence. */
  seeds_flagged_elevated_cadence: string[];
  total_recent_buys: number;
  /** Buys on tokens older than max_token_age_hours (excluded from signals). */
  buys_on_older_tokens: number;
  /** Buys excluded because DexScreener exposes no launch time for the token. */
  buys_unknown_age: number;
  filters: {
    hours_back: number;
    max_token_age_hours: number;
    min_buyers: number;
    limit: number;
  };
  seed_set: {
    derived_at: string;
    active_traders: number;
    conviction_holders: number;
    source: string;
  };
  last_updated: string;
}

interface SeedInfo {
  address: string;
  wallet_type: TrenchesWalletType;
  win_rate: number | null;
  realized_1w_usd: number | null;
}

/**
 * "Which proven-winner wallets are aping fresh tokens right now, and what are
 * they buying?" — the trenches attention signal (scope doc T3).
 *
 * Decoupled design: WHO is smart is an offline, vetted seed config
 * (trenches-smart-money-seeds.ts — leaderboard realized-PnL winners + known-
 * runner conviction holders, bot-filtered); WHAT they buy now is live
 * (recent swaps → fresh-token filter → aggregate by mint).
 *
 * Live bot guard: vetting is point-in-time, so every scan re-checks each
 * seed's raw tx/hour and skips wallets that now look automated. This is the
 * tx_per_h guard from the 2026-07-06 vetting — the labeler's detect* functions
 * have min-window guards that ultra-fast bots evade when their 100-sig sample
 * spans under an hour.
 */
export class TrenchesSmartMoneyAnalyzer {
  constructor(
    private helius: HeliusClient,
    private dexscreener: DexScreenerClient,
    private copyTrade: CopyTradeAnalyzer,
    private cache: Cache,
  ) {}

  async enrich(
    hoursBack: number,
    maxTokenAgeHours: number,
    minBuyers: number,
    limit: number,
  ): Promise<SmartMoneyTrenchesResult> {
    const cacheKey = `trenches:smart-money:${hoursBack}:${maxTokenAgeHours}:${minBuyers}:${limit}`;
    const cached = await this.cache.get<SmartMoneyTrenchesResult>(cacheKey);
    if (cached) return cached;

    const seeds: SeedInfo[] = [
      ...TRENCHES_SMART_MONEY_SEEDS.map((s) => ({
        address: s.address,
        wallet_type: 'active_trader' as const,
        win_rate: s.win_rate,
        realized_1w_usd: s.realized_1w_usd,
      })),
      ...TRENCHES_CONVICTION_HOLDERS.map((h) => ({
        address: h.address,
        wallet_type: 'conviction_holder' as const,
        win_rate: null,
        realized_1w_usd: null,
      })),
    ];

    // Phase 1: live cadence guard + recent buys per surviving seed (batches of 4)
    const skipped: string[] = [];
    const flagged: string[] = [];
    const seedBuys: Array<{ seed: SeedInfo; buys: RecentBuy[]; elevated: boolean }> = [];

    for (let i = 0; i < seeds.length; i += 4) {
      const batch = seeds.slice(i, i + 4);
      const settled = await Promise.allSettled(
        batch.map(async (seed) => {
          const sigs = await this.helius.getSignaturesForAddress(seed.address, 100);
          const ts = sigs
            .map((s) => s.blockTime)
            .filter((t): t is number => typeof t === 'number');
          const spanH =
            ts.length >= 2 ? (Math.max(...ts) - Math.min(...ts)) / 3600 : 0;
          // 100 txs in ~0h = burst bot; treat unmeasurable-with-full-sample as bot.
          const txPerH = spanH > 0 ? ts.length / spanH : ts.length >= 100 ? Infinity : 0;
          if (txPerH >= TX_PER_H_FILTER) {
            skipped.push(seed.address);
            return null;
          }
          const elevated = txPerH >= TX_PER_H_FLAG;
          if (elevated) flagged.push(seed.address);
          const buys = await this.copyTrade.getRecentBuys(seed.address, hoursBack);
          return { seed, buys, elevated };
        }),
      );
      for (const s of settled) {
        if (s.status === 'fulfilled' && s.value) seedBuys.push(s.value);
      }
    }

    // Phase 2: freshness-check every distinct mint bought (DexScreener launch time)
    const allMints = new Set<string>();
    for (const { buys } of seedBuys) for (const b of buys) allMints.add(b.mint);

    const tokenData = new Map<
      string,
      { ageHours: number | null; symbol: string | null; liquidity: number | null; marketCap: number | null; price: number | null }
    >();
    const mintList = [...allMints];
    for (let i = 0; i < mintList.length; i += 5) {
      const batch = mintList.slice(i, i + 5);
      const settled = await Promise.allSettled(
        batch.map((mint) => this.dexscreener.getTokenData(mint)),
      );
      for (let j = 0; j < batch.length; j++) {
        const r = settled[j];
        const data = r.status === 'fulfilled' ? r.value : null;
        tokenData.set(batch[j], {
          ageHours: data?.pairCreatedAt != null ? (Date.now() - data.pairCreatedAt) / 3_600_000 : null,
          symbol: data?.symbol ?? null,
          liquidity: data?.liquidity ?? null,
          marketCap: data?.marketCap ?? null,
          price: data?.price ?? null,
        });
      }
    }

    // Phase 3: aggregate fresh-token buys by mint
    const nowSec = Date.now() / 1000;
    let totalBuys = 0;
    let olderTokenBuys = 0;
    let unknownAgeBuys = 0;
    const agg = new Map<
      string,
      { buyers: Set<string>; holders: Set<string>; spent: number; latestTs: number; buys: TrenchesBuy[] }
    >();

    for (const { seed, buys, elevated } of seedBuys) {
      for (const buy of buys) {
        totalBuys++;
        const info = tokenData.get(buy.mint);
        if (!info || info.ageHours == null) {
          unknownAgeBuys++;
          continue;
        }
        if (info.ageHours > maxTokenAgeHours) {
          olderTokenBuys++;
          continue;
        }
        if (!agg.has(buy.mint)) {
          agg.set(buy.mint, { buyers: new Set(), holders: new Set(), spent: 0, latestTs: 0, buys: [] });
        }
        const bucket = agg.get(buy.mint)!;
        bucket.buyers.add(seed.address);
        if (seed.wallet_type === 'conviction_holder') bucket.holders.add(seed.address);
        bucket.spent += buy.spent_usd ?? 0;
        bucket.latestTs = Math.max(bucket.latestTs, buy.timestamp);
        bucket.buys.push({
          wallet: seed.address,
          wallet_type: seed.wallet_type,
          seed_win_rate: seed.win_rate,
          seed_realized_1w_usd: seed.realized_1w_usd,
          spent_usd: buy.spent_usd != null ? Math.round(buy.spent_usd * 100) / 100 : null,
          minutes_ago: Math.max(0, Math.round((nowSec - buy.timestamp) / 60)),
          elevated_cadence: elevated,
        });
      }
    }

    const signals: TrenchesTokenSignal[] = Array.from(agg.entries())
      .map(([mint, bucket]) => {
        const info = tokenData.get(mint)!;
        return {
          mint,
          symbol: info.symbol,
          token_age_hours: Math.round(info.ageHours! * 10) / 10,
          smart_buyers: bucket.buyers.size,
          conviction_holder_buyers: bucket.holders.size,
          total_spent_usd: Math.round(bucket.spent * 100) / 100,
          most_recent_buy_minutes_ago: Math.max(0, Math.round((nowSec - bucket.latestTs) / 60)),
          liquidity_usd: info.liquidity,
          market_cap_usd: info.marketCap,
          price_usd: info.price,
          buys: bucket.buys.sort((a, b) => a.minutes_ago - b.minutes_ago),
        };
      })
      .filter((s) => s.smart_buyers >= minBuyers)
      // More proven wallets in = stronger signal; recency breaks ties.
      .sort(
        (a, b) =>
          b.smart_buyers - a.smart_buyers ||
          a.most_recent_buy_minutes_ago - b.most_recent_buy_minutes_ago,
      )
      .slice(0, limit);

    const out: SmartMoneyTrenchesResult = {
      signals,
      seeds_scanned: seeds.length - skipped.length,
      seeds_skipped_bot_cadence: skipped,
      seeds_flagged_elevated_cadence: flagged,
      total_recent_buys: totalBuys,
      buys_on_older_tokens: olderTokenBuys,
      buys_unknown_age: unknownAgeBuys,
      filters: {
        hours_back: hoursBack,
        max_token_age_hours: maxTokenAgeHours,
        min_buyers: minBuyers,
        limit,
      },
      seed_set: {
        derived_at: TRENCHES_SEEDS_DERIVED_AT,
        active_traders: TRENCHES_SMART_MONEY_SEEDS.length,
        conviction_holders: TRENCHES_CONVICTION_HOLDERS.length,
        source: 'birdeye-leaderboard-realized-pnl + known-runner-miners, vetted via cadence/bot-detection/copy-trade',
      },
      last_updated: formatTimestamp(),
    };

    await this.cache.set(cacheKey, out, CACHE_TTL.trenches);
    return out;
  }
}
