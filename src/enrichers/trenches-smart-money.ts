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
  /** Seeds whose reads failed this scan (Helius error): not counted in seeds_scanned. */
  seeds_failed: number;
  /** Distinct bought mints whose DexScreener lookup failed (error, not "no pairs"). */
  token_lookups_failed: number;
  /** Buys excluded because their token lookup failed — not the same as unknown age. */
  buys_lookup_failed: number;
  /** degraded = some seed reads or token lookups failed, so signals can be missing. */
  data_quality: { degraded: boolean; unavailable: string[] };
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
    const full = await this.aggregate(hoursBack, maxTokenAgeHours);
    return {
      ...full,
      signals: full.signals.filter((s) => s.smart_buyers >= minBuyers).slice(0, limit),
      filters: { hours_back: hoursBack, max_token_age_hours: maxTokenAgeHours, min_buyers: minBuyers, limit },
      last_updated: formatTimestamp(),
    };
  }

  /**
   * Membership check for one mint against the FULL aggregate (audit #39: trenches-check used to search the top-25
   * slice, so a seed buy on the 26th token read as "no proven-winner buys"). Same cache as enrich().
   */
  async lookup(mint: string, hoursBack: number, maxTokenAgeHours: number): Promise<{ signal: TrenchesTokenSignal | null; result: SmartMoneyTrenchesResult }> {
    const full = await this.aggregate(hoursBack, maxTokenAgeHours);
    return { signal: full.signals.find((s) => s.mint === mint) ?? null, result: full };
  }

  /** Every fresh-token signal with at least one smart buyer, sorted; cached per (hoursBack, maxTokenAgeHours). */
  private async aggregate(hoursBack: number, maxTokenAgeHours: number): Promise<SmartMoneyTrenchesResult> {
    const cacheKey = `trenches:smart-money:agg:${hoursBack}:${maxTokenAgeHours}`;
    const cached = await this.cache.get<SmartMoneyTrenchesResult>(cacheKey);
    if (cached) return cached;
    const minBuyers = 1;

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

    // Phase 1: live cadence guard + recent buys per surviving seed. Batches of
    // 10 — sized for the widened (100+) seed set against Helius Pro's 50 RPS;
    // was 4 when the set had 14 wallets.
    const skipped: string[] = [];
    const flagged: string[] = [];
    const seedBuys: Array<{ seed: SeedInfo; buys: RecentBuy[]; elevated: boolean }> = [];
    let seedsFailed = 0;

    for (let i = 0; i < seeds.length; i += 10) {
      const batch = seeds.slice(i, i + 10);
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
        else if (s.status === 'rejected') seedsFailed++;
      }
    }

    // Phase 2: freshness-check every distinct mint bought (DexScreener launch time)
    const allMints = new Set<string>();
    for (const { buys } of seedBuys) for (const b of buys) allMints.add(b.mint);

    const tokenData = new Map<
      string,
      { ageHours: number | null; symbol: string | null; liquidity: number | null; marketCap: number | null; price: number | null }
    >();
    // A rejected lookup (429, timeout) is a failed read; a fulfilled null is "DexScreener has no pairs".
    const lookupFailed = new Set<string>();
    const mintList = [...allMints];
    for (let i = 0; i < mintList.length; i += 5) {
      const batch = mintList.slice(i, i + 5);
      const settled = await Promise.allSettled(
        batch.map((mint) => this.dexscreener.getTokenData(mint)),
      );
      for (let j = 0; j < batch.length; j++) {
        const r = settled[j];
        if (r.status === 'rejected') { lookupFailed.add(batch[j]); continue; }
        const data = r.value;
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
    let lookupFailedBuys = 0;
    const agg = new Map<
      string,
      { buyers: Set<string>; holders: Set<string>; spent: number; latestTs: number; buys: TrenchesBuy[] }
    >();

    for (const { seed, buys, elevated } of seedBuys) {
      for (const buy of buys) {
        totalBuys++;
        if (lookupFailed.has(buy.mint)) {
          lookupFailedBuys++;
          continue;
        }
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
      );

    const unavailable: string[] = [];
    if (seedsFailed > 0) unavailable.push('helius_seed_reads');
    if (lookupFailed.size > 0) unavailable.push('dexscreener_token_lookups');
    const out: SmartMoneyTrenchesResult = {
      signals,
      seeds_scanned: seeds.length - skipped.length - seedsFailed,
      seeds_skipped_bot_cadence: skipped,
      seeds_flagged_elevated_cadence: flagged,
      total_recent_buys: totalBuys,
      buys_on_older_tokens: olderTokenBuys,
      buys_unknown_age: unknownAgeBuys,
      seeds_failed: seedsFailed,
      token_lookups_failed: lookupFailed.size,
      buys_lookup_failed: lookupFailedBuys,
      data_quality: { degraded: unavailable.length > 0, unavailable },
      filters: {
        hours_back: hoursBack,
        max_token_age_hours: maxTokenAgeHours,
        min_buyers: minBuyers,
        limit: signals.length,
      },
      seed_set: {
        derived_at: TRENCHES_SEEDS_DERIVED_AT,
        active_traders: TRENCHES_SMART_MONEY_SEEDS.length,
        conviction_holders: TRENCHES_CONVICTION_HOLDERS.length,
        source: 'on-chain: traders of the busiest trending tokens + re-vetted prior seeds; gates: active 7d, human cadence, 14d quote-leg PnL (>=10 closed, >=50% win, PnL>0); conviction holders of known runners',
      },
      last_updated: formatTimestamp(),
    };

    // A scan with failed reads is cached briefly, so the next call reads again.
    await this.cache.set(cacheKey, out, out.data_quality.degraded ? 15 : CACHE_TTL.trenches);
    return out;
  }
}
