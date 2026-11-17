import type { HeliusClient, EnhancedTransaction } from '../sources/helius';
import type { DexScreenerClient } from '../sources/dexscreener';
import type { PriceAggregator } from '../utils/price-aggregator';
import type { Cache } from '../cache';
import { CACHE_TTL } from '../config';
import { formatTimestamp } from '../utils/normalize';

interface ClosedTrade {
  buy_token: string;
  sell_token: string;
  entry_usd: number;
  exit_usd: number;
  pnl_usd: number;
  hold_time_days: number;
}

export interface TopPair {
  buy_token: string;
  sell_token: string;
  win_count: number;
  avg_pnl: number;
}

export interface RiskAdjustedReturns {
  sharpe_ratio: number;       // return per unit of risk (>1 = good, >2 = excellent)
  sortino_ratio: number;      // like sharpe but only penalizes downside
  max_drawdown_pct: number;   // worst peak-to-trough decline (%)
  max_drawdown_usd: number;   // worst peak-to-trough decline ($)
  profit_factor: number;      // gross profit / gross loss (>1 = profitable)
}

export interface CopyTradeEnrichment {
  address: string;
  lookback_days: number;
  trades_analyzed: number;
  win_rate: number;
  total_pnl_usd: number;
  avg_pnl_per_trade_usd: number;
  avg_hold_time_days: number;
  consistency_score: number;
  risk_adjusted?: RiskAdjustedReturns;
  trade_frequency_per_day: number;
  top_performing_pairs: TopPair[];
  labels: string[];
  /** Buy and sell legs read in the covered window. */
  swaps_seen: number;
  /** Token-to-token swaps, or SOL legs when the SOL price was unavailable: not in PnL. */
  unpriced_swaps: number;
  /** Sells of tokens bought before the window: cost unknown, not in PnL. */
  unmatched_sells: number;
  /** Days of history actually read (≤ lookback_days when the wallet has more than 300 txs in the window). */
  coverage_days: number;
  history_complete: boolean;
  /** 'quote_leg': each trade valued by the SOL/USDC/USDT paid or received in that tx; SOL at the current price. */
  pnl_basis: 'quote_leg';
  last_updated: string;
}

/** Signature pages (100 each) read per wallet. Caps Helius cost on very active wallets. */
const MAX_SIG_PAGES = 3;


// Quote assets — the leg a wallet *pays with* in a swap, never the token it "bought".
const WSOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
const QUOTE_MINTS = new Set([WSOL_MINT, USDC_MINT, USDT_MINT]);

// --- Swap legs (2026-11-17 audit fix) ---
// Each swap is read from the WALLET'S OWN balance changes in that transaction: the non-quote token it received or
// sent, and the quote asset (SOL / USDC / USDT) it paid or received. That prices both legs at the trade itself.
// Before, every leg of every mint got ONE current price, so buy cost = sell proceeds and PnL ≈ 0; unpriced legs
// counted raw token units as USD; and any transfer not sent TO the wallet counted as a wallet sell.

/** One wallet-side swap read from a transaction. Quote amounts are positive magnitudes. */
export interface SwapLeg {
  kind: 'buy' | 'sell' | 'token_to_token' | 'none';
  mint: string | null;
  units: number;
  quote_usd: number | null;  // USDC/USDT paid or received (1:1)
  quote_sol: number | null;  // SOL paid or received (native + wrapped, net of wrap/unwrap moves)
  timestamp: number;
}

const FUNGIBLE = new Set(['Fungible', 'FungibleAsset']);
const LAMPORTS = 1e9;
/** SOL moves below this are fees/rent, not a trade leg. */
const MIN_SOL_LEG = 0.001;

interface TokenBalanceChange {
  userAccount: string;
  tokenAccount: string;
  mint: string;
  rawTokenAmount: { tokenAmount: string; decimals: number };
}

/** Net change per mint of the wallet's token accounts. Prefers accountData.tokenBalanceChanges (actual balance
 *  deltas — Helius's tokenTransfers list can omit the leg a router delivers, seen 2026-11-17 on OKX DEX Router
 *  swaps); falls back to tokenTransfers when a tx carries no balance changes at all. */
function walletTokenDeltas(tx: EnhancedTransaction, wallet: string): Map<string, number> {
  const deltas = new Map<string, number>();
  const changes = (tx.accountData ?? []).flatMap((a) => (a.tokenBalanceChanges ?? []) as TokenBalanceChange[]);
  if (changes.length > 0) {
    for (const c of changes) {
      if (c.userAccount !== wallet || !c.rawTokenAmount) continue;
      const { tokenAmount, decimals } = c.rawTokenAmount;
      if (decimals === 0 && c.mint !== WSOL_MINT) continue; // NFTs / non-fungible
      const v = Number(tokenAmount) / 10 ** decimals;
      if (Number.isFinite(v) && v !== 0) deltas.set(c.mint, (deltas.get(c.mint) ?? 0) + v);
    }
    return deltas;
  }
  for (const t of tx.tokenTransfers ?? []) {
    const sign = t.toUserAccount === wallet ? 1 : t.fromUserAccount === wallet ? -1 : 0;
    if (sign === 0) continue;                               // vault-to-vault / fee legs: not the wallet's
    if (t.tokenStandard && !FUNGIBLE.has(t.tokenStandard)) continue;
    deltas.set(t.mint, (deltas.get(t.mint) ?? 0) + sign * t.tokenAmount);
  }
  return deltas;
}

const SWAP_LIKE = new Set(['SWAP', 'TOKEN_SWAP', 'EXCHANGE', 'BUY', 'SELL']);

export function extractSwapLeg(tx: EnhancedTransaction, wallet: string): SwapLeg {
  const none: SwapLeg = { kind: 'none', mint: null, units: 0, quote_usd: null, quote_sol: null, timestamp: tx.timestamp };
  if (tx.transactionError) return none;                     // failed txs (Helius labels them UNKNOWN) move nothing

  const deltas = walletTokenDeltas(tx, wallet);
  const stableNet = (deltas.get(USDC_MINT) ?? 0) + (deltas.get(USDT_MINT) ?? 0);
  // SOL = the wallet's native balance change + its wrapped-SOL accounts' change. A wrap (native → own WSOL account)
  // and an unwrap (close → native) cancel out inside this sum, so neither is counted twice. Includes the tx fee.
  const nativeChange = (tx.accountData?.find((a) => a.account === wallet)?.nativeBalanceChange ?? 0) / LAMPORTS;
  const solNet = nativeChange + (deltas.get(WSOL_MINT) ?? 0);

  const moved = [...deltas].filter(([mint, v]) => !QUOTE_MINTS.has(mint) && Math.abs(v) > 0);
  if (moved.length === 0) return none;
  const swapLike = SWAP_LIKE.has(String(tx.type).toUpperCase());
  if (moved.length > 1) {
    // Token-to-token swap (or a multi-token tx): no quote leg to price it with.
    return swapLike ? { ...none, kind: 'token_to_token' } : none;
  }
  const [mint, net] = moved[0];
  const quoteUsd = Math.abs(stableNet) > 0 ? Math.abs(stableNet) : null;
  const quoteSol = Math.abs(solNet) >= MIN_SOL_LEG ? Math.abs(solNet) : null;
  if (net > 0 && (stableNet < 0 || (quoteUsd == null && solNet < 0 && quoteSol != null))) {
    return { kind: 'buy', mint, units: net, quote_usd: stableNet < 0 ? quoteUsd : null, quote_sol: stableNet < 0 ? null : quoteSol, timestamp: tx.timestamp };
  }
  if (net < 0 && (stableNet > 0 || (quoteUsd == null && solNet > 0 && quoteSol != null))) {
    return { kind: 'sell', mint, units: -net, quote_usd: stableNet > 0 ? quoteUsd : null, quote_sol: stableNet > 0 ? null : quoteSol, timestamp: tx.timestamp };
  }
  // A token moved but no quote leg moved the other way. In a swap that is a token-to-token trade (unpriced);
  // outside a swap it is a transfer or an airdrop, not a trade.
  return swapLike ? { ...none, kind: 'token_to_token', mint } : none;
}

export interface MatchedTrades {
  closed: ClosedTrade[];
  swaps_seen: number;       // buy + sell legs read
  unpriced_swaps: number;   // token-to-token, or a SOL leg with no SOL price
  unmatched_sells: number;  // sells of a token bought before the window: cost unknown, excluded from PnL
}

/** Average-cost matching of wallet swap legs. SOL legs convert at `solUsd` (current SOL price). Pure. */
export function matchTrades(legs: SwapLeg[], solUsd: number | null): MatchedTrades {
  const sorted = [...legs].sort((a, b) => a.timestamp - b.timestamp);
  const positions = new Map<string, { units: number; cost_usd: number; first_buy_ts: number }>();
  const closed: ClosedTrade[] = [];
  let swaps = 0, unpriced = 0, unmatched = 0;
  const usdOf = (l: SwapLeg): number | null =>
    l.quote_usd != null ? l.quote_usd : l.quote_sol != null && solUsd != null && solUsd > 0 ? l.quote_sol * solUsd : null;

  for (const l of sorted) {
    if (l.kind === 'token_to_token') { unpriced++; continue; }
    if (l.kind !== 'buy' && l.kind !== 'sell') continue;
    swaps++;
    const usd = usdOf(l);
    if (usd == null || !l.mint) { unpriced++; continue; }
    const pos = positions.get(l.mint) ?? { units: 0, cost_usd: 0, first_buy_ts: l.timestamp };
    if (l.kind === 'buy') {
      if (pos.units === 0) pos.first_buy_ts = l.timestamp;
      pos.units += l.units;
      pos.cost_usd += usd;
      positions.set(l.mint, pos);
      continue;
    }
    if (pos.units <= 0) { unmatched++; continue; }
    // Sell more than was bought in the window: only the matched part has a known cost.
    const sellUnits = Math.min(l.units, pos.units);
    const proceeds = usd * (sellUnits / l.units);
    const avgCost = pos.cost_usd / pos.units;
    const costOfSold = sellUnits * avgCost;
    closed.push({
      buy_token: l.mint,
      sell_token: l.mint,
      entry_usd: costOfSold,
      exit_usd: proceeds,
      pnl_usd: proceeds - costOfSold,
      hold_time_days: Math.max(0, (l.timestamp - pos.first_buy_ts) / 86400),
    });
    pos.units -= sellUnits;
    pos.cost_usd -= costOfSold;
    if (pos.units <= 1e-12) { pos.units = 0; pos.cost_usd = 0; }
    positions.set(l.mint, pos);
  }
  return { closed, swaps_seen: swaps, unpriced_swaps: unpriced, unmatched_sells: unmatched };
}

/**
 * Consistency of PROFITABLE returns, 0–1: s / (1 + s) with s = mean / stddev of per-trade PnL, when the mean is
 * positive; 0 otherwise. 0.5 = per-trade Sharpe of 1. Replaces 1 − stddev / max|pnl| (2026-11-17), which stayed
 * high for almost any wallet — a wallet with an 8% win rate and −$104 scored 0.84 and got consistent_trader.
 */
export function consistencyScore(pnls: number[]): number {
  if (pnls.length < 2) return 0;
  const mean = pnls.reduce((s, r) => s + r, 0) / pnls.length;
  if (!(mean > 0)) return 0;
  const std = Math.sqrt(pnls.reduce((s, r) => s + (r - mean) ** 2, 0) / pnls.length);
  if (std === 0) return 1;
  const s = mean / std;
  return s / (1 + s);
}
export const CONSISTENT_TRADER_MIN = 0.5;

/**
 * Buys from enhanced transactions, read with extractSwapLeg (the wallet's balance changes). Before 2026-11-17 this
 * read the token received from tokenTransfers, which can omit a router's delivery leg — those buys were missed. Pure.
 */
export function recentBuysFromTxs(txs: EnhancedTransaction[], address: string, solPrice: number): RecentBuy[] {
  const buys: RecentBuy[] = [];
  for (const tx of txs) {
    const leg = extractSwapLeg(tx, address);
    if (leg.kind !== 'buy' || !leg.mint) continue;
    const spentUsd = leg.quote_usd != null ? leg.quote_usd : leg.quote_sol != null && solPrice > 0 ? leg.quote_sol * solPrice : null;
    buys.push({ mint: leg.mint, timestamp: tx.timestamp, token_units: leg.units, spent_usd: spentUsd });
  }
  return buys;
}

/** A token a wallet acquired recently. Light — no PnL, for the trenches live overlay. */
export interface RecentBuy {
  mint: string;
  timestamp: number;        // unix seconds (block time)
  token_units: number;      // amount of the token received
  spent_usd: number | null; // USD value of the quote leg spent; null if unpriceable
}

export class CopyTradeAnalyzer {
  constructor(
    private helius: HeliusClient,
    private dexscreener: DexScreenerClient,
    private cache: Cache,
    private priceAggregator?: PriceAggregator,
  ) {}

  /**
   * Light "what did this wallet buy recently" path for the trenches live overlay.
   * Unlike enrich() (backward-looking PnL over scored pairs), this returns the
   * raw recent acquisitions — the token received on the non-quote leg of each
   * recent SWAP — so callers can overlay against fresh-launch feeds. No pricing
   * of the bought token is needed; size is taken from the quote leg spent.
   */
  async getRecentBuys(address: string, hoursBack: number): Promise<RecentBuy[]> {
    const cacheKey = `recentbuys:${address}:${hoursBack}`;
    const cached = await this.cache.get<RecentBuy[]>(cacheKey);
    if (cached) return cached;

    const sigs = await this.helius.getSignaturesForAddress(address, 100);
    const cutoff = Date.now() / 1000 - hoursBack * 3600;
    const recentSigs = sigs.filter((s) => (s.blockTime ?? 0) >= cutoff).map((s) => s.signature);
    if (recentSigs.length === 0) return [];

    let txs: EnhancedTransaction[] = [];
    try {
      txs = await this.helius.getEnhancedTransactions(recentSigs);
    } catch {
      return [];
    }

    const buys = recentBuysFromTxs(txs, address, await this.dexscreener.getTokenPrice(WSOL_MINT).catch(() => 0));

    await this.cache.set(cacheKey, buys, CACHE_TTL.copyTrade);
    return buys;
  }

  async enrich(address: string, lookbackDays: number): Promise<CopyTradeEnrichment> {
    const cacheKey = `copytrade:${address}:${lookbackDays}`;
    const cached = await this.cache.get<CopyTradeEnrichment>(cacheKey);
    if (cached) return cached;

    // Signatures back to the lookback cutoff, newest first, up to MAX_SIG_PAGES × 100.
    const cutoff = Date.now() / 1000 - lookbackDays * 86400;
    const sigStrings: string[] = [];
    let before: string | undefined;
    let historyComplete = false;
    let oldestSeen: number | null = null;
    for (let page = 0; page < MAX_SIG_PAGES; page++) {
      const sigs = await this.helius.getSignaturesForAddress(address, 100, before);
      for (const s of sigs) {
        if ((s.blockTime ?? 0) < cutoff) { historyComplete = true; break; }
        sigStrings.push(s.signature);
        oldestSeen = s.blockTime ?? oldestSeen;
      }
      if (historyComplete || sigs.length < 100) { historyComplete = true; break; }
      before = sigs[sigs.length - 1].signature;
    }
    // Days actually covered: the whole lookback when complete, else back to the oldest signature read.
    const coverageDays = historyComplete || oldestSeen == null
      ? lookbackDays
      : Math.max(0, (Date.now() / 1000 - oldestSeen) / 86400);

    let txs: EnhancedTransaction[] = [];
    for (let i = 0; i < sigStrings.length; i += 100) {
      try {
        txs.push(...await this.helius.getEnhancedTransactions(sigStrings.slice(i, i + 100)));
      } catch {
        // A failed batch is reported through history_complete below
        historyComplete = false;
      }
    }

    // Each swap priced from its own quote leg; SOL legs convert at the current SOL price.
    const legs = txs.map((tx) => extractSwapLeg(tx, address));
    const solUsd = legs.some((l) => l.quote_sol != null)
      ? await this.dexscreener.getTokenPrice(WSOL_MINT).catch(() => 0)
      : 0;
    const matched = matchTrades(legs, solUsd > 0 ? solUsd : null);
    const closedTrades = matched.closed;

    // Compute metrics
    const totalTrades = closedTrades.length;
    const wins = closedTrades.filter((t) => t.pnl_usd > 0).length;
    const winRate = totalTrades > 0 ? wins / totalTrades : 0;
    const totalPnl = closedTrades.reduce((sum, t) => sum + t.pnl_usd, 0);
    const avgPnl = totalTrades > 0 ? totalPnl / totalTrades : 0;
    const avgHoldTime = totalTrades > 0
      ? closedTrades.reduce((sum, t) => sum + t.hold_time_days, 0) / totalTrades
      : 0;

    const consistency = consistencyScore(closedTrades.map((t) => t.pnl_usd));

    // Swaps per day over the days actually covered (not the requested lookback).
    const tradeFrequency = coverageDays > 0 ? matched.swaps_seen / coverageDays : 0;

    // Risk-adjusted returns
    let riskAdjusted: RiskAdjustedReturns | undefined;
    if (totalTrades >= 3) {
      const pnls = closedTrades.map((t) => t.pnl_usd);
      const mean = totalPnl / totalTrades;

      // Sharpe: mean return / stddev of all returns
      const allVariance = pnls.reduce((s, r) => s + (r - mean) ** 2, 0) / totalTrades;
      const allStd = Math.sqrt(allVariance);
      const sharpe = allStd > 0 ? mean / allStd : 0;

      // Sortino: mean return / stddev of negative returns only
      const negReturns = pnls.filter((r) => r < 0);
      const downVariance = negReturns.length > 0
        ? negReturns.reduce((s, r) => s + r ** 2, 0) / negReturns.length
        : 0;
      const downStd = Math.sqrt(downVariance);
      const sortino = downStd > 0 ? mean / downStd : (mean > 0 ? 999 : 0);

      // Max drawdown: worst peak-to-trough decline
      let peak = 0;
      let cumulative = 0;
      let maxDdUsd = 0;
      for (const pnl of pnls) {
        cumulative += pnl;
        if (cumulative > peak) peak = cumulative;
        const dd = peak - cumulative;
        if (dd > maxDdUsd) maxDdUsd = dd;
      }
      const maxDdPct = peak > 0 ? (maxDdUsd / peak) * 100 : 0;

      // Profit factor: gross profit / gross loss
      const grossProfit = pnls.filter((r) => r > 0).reduce((s, r) => s + r, 0);
      const grossLoss = Math.abs(pnls.filter((r) => r < 0).reduce((s, r) => s + r, 0));
      const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);

      riskAdjusted = {
        sharpe_ratio: Math.round(sharpe * 100) / 100,
        sortino_ratio: Math.round(Math.min(sortino, 999) * 100) / 100,
        max_drawdown_pct: Math.round(maxDdPct * 100) / 100,
        max_drawdown_usd: Math.round(maxDdUsd * 100) / 100,
        profit_factor: Math.round(Math.min(profitFactor, 999) * 100) / 100,
      };
    }

    // Top performing pairs
    const pairMap = new Map<string, { wins: number; totalPnl: number; count: number }>();
    for (const ct of closedTrades) {
      const key = ct.buy_token;
      const entry = pairMap.get(key) ?? { wins: 0, totalPnl: 0, count: 0 };
      entry.count++;
      entry.totalPnl += ct.pnl_usd;
      if (ct.pnl_usd > 0) entry.wins++;
      pairMap.set(key, entry);
    }

    const topPairs: TopPair[] = [...pairMap.entries()]
      .map(([mint, data]) => ({
        buy_token: mint,
        sell_token: mint,
        win_count: data.wins,
        avg_pnl: data.count > 0 ? data.totalPnl / data.count : 0,
      }))
      .sort((a, b) => b.avg_pnl - a.avg_pnl)
      .slice(0, 5);

    // Labels — use risk-adjusted metrics when available
    const labels: string[] = [];
    if (riskAdjusted && riskAdjusted.sharpe_ratio > 1.0 && totalPnl > 0) {
      labels.push('smart_money');
    } else if (winRate > 0.55 && totalPnl > 500) {
      labels.push('smart_money');
    }
    if (tradeFrequency > 5) labels.push('high_frequency');
    if (consistency >= CONSISTENT_TRADER_MIN && totalPnl > 0) labels.push('consistent_trader');
    if (riskAdjusted && riskAdjusted.max_drawdown_pct > 50) labels.push('high_risk');
    if (riskAdjusted && riskAdjusted.profit_factor > 2.0) labels.push('strong_edge');

    const enrichment: CopyTradeEnrichment = {
      address,
      lookback_days: lookbackDays,
      trades_analyzed: totalTrades,
      win_rate: Math.round(winRate * 1000) / 1000,
      total_pnl_usd: Math.round(totalPnl * 100) / 100,
      avg_pnl_per_trade_usd: Math.round(avgPnl * 100) / 100,
      avg_hold_time_days: Math.round(avgHoldTime * 10) / 10,
      consistency_score: Math.round(consistency * 100) / 100,
      risk_adjusted: riskAdjusted,
      trade_frequency_per_day: Math.round(tradeFrequency * 100) / 100,
      top_performing_pairs: topPairs,
      labels,
      swaps_seen: matched.swaps_seen,
      unpriced_swaps: matched.unpriced_swaps,
      unmatched_sells: matched.unmatched_sells,
      coverage_days: Math.round(coverageDays * 10) / 10,
      history_complete: historyComplete,
      pnl_basis: 'quote_leg',
      last_updated: formatTimestamp(),
    };

    await this.cache.set(cacheKey, enrichment, CACHE_TTL.copyTrade);
    return enrichment;
  }
}
