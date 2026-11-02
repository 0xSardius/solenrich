import { formatTimestamp } from '../utils/normalize';
import type { TokenAnalyzer, TokenEnrichment } from './token-analyzer';
import type { TrenchesCheckAnalyzer, TrenchesCheckResult, TrenchesCheckVerdict } from './trenches-check';
import type { ExitSignalAnalyzer, ExitSignalResult } from './exit-analyzer';
import type { ExitVerdict } from './exit-score';
import type { AudaceIntentCheckInput } from '../schemas/audace';

// AudaceFi league intent check (2026-11-01). One call before POST /v1/swap-intents:
// reads the direction from the mints, then runs the existing verdicts on the token
// bought (risk flags, trenches signal for Degen, exit momentum) and the token sold
// (exit verdict). A season-end clock applies first: a League Wallet holding anything
// but USDC at the snapshot forfeits the season.

export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
/** Inside this window before the snapshot, sells proceed and buys hold, with no upstream reads. */
export const SNAPSHOT_BUFFER_MIN = 60;
/** Share of the position a DERISK sell suggests. */
export const DERISK_FRACTION = 0.5;
/** Mainnet only: price impact at the intent's size above this holds a buy. */
export const MAX_PRICE_IMPACT_PCT = 3;
/** Weakest trenches-check verdict that lets a Degen buy proceed. */
export const MIN_DEGEN_SIGNAL: TrenchesCheckVerdict = 'MODERATE';

/**
 * Risk flags that hold a buy. They predict a price collapse on the mainnet identity,
 * which league valuation follows. A mainnet freeze cannot touch a devnet balance, so
 * freeze_authority_active blocks on mainnet only.
 */
export const BLOCK_FLAGS = {
  devnet: ['low_liquidity', 'extreme_volatility', 'whale_dominated', 'mint_authority_active'],
  mainnet: ['low_liquidity', 'extreme_volatility', 'whale_dominated', 'mint_authority_active', 'freeze_authority_active'],
} as const;

const SIGNAL_RANK: Record<TrenchesCheckVerdict, number> = { NO_SIGNAL: 0, SINGLE_SIGNAL: 1, MODERATE: 2, HIGH_CONFLUENCE: 3 };

export type IntentDirection = 'buy' | 'sell' | 'swap';
export type IntentVerdict = 'PROCEED' | 'REDUCE' | 'HOLD';
type Network = 'devnet' | 'mainnet';

export interface BuyCheck {
  mint: string;
  symbol: string | null;
  allow: boolean;
  codes: string[];
  risk_flags: string[] | null;
  degen_signal: TrenchesCheckVerdict | null;
  exit_verdict: ExitVerdict | null;
  /** Mainnet only: estimated price impact at the intent's size. */
  price_impact_pct: number | null;
}

export interface SellCheck {
  mint: string;
  symbol: string | null;
  exit_verdict: ExitVerdict | null;
  exit_score: number | null;
  codes: string[];
}

export interface AudaceIntentCheckResult {
  intent: {
    category: 'degen' | 'crypto_bro' | 'whale';
    network: Network;
    direction: IntentDirection;
    token_in: string;
    token_out: string;
    amount_in: number;
    /** USD size of the intent. Null when the input token's price is unknown. */
    size_usd: number | null;
  };
  /** PROCEED = send the intent as-is. REDUCE = sell only suggested_fraction. HOLD = do not send it now. */
  verdict: IntentVerdict;
  /** Share of amountIn to send: 1, DERISK_FRACTION, or 0. */
  suggested_fraction: number;
  codes: string[];
  season: { ends_at: string; ends_at_source: 'input' | 'default_saturday'; minutes_to_snapshot: number };
  buy_check: BuyCheck | null;
  sell_check: SellCheck | null;
  reasoning: string;
  caveats: string[];
  last_updated: string;
}

/** Leg results as settled promises reduce to: the value, or null when the read failed. */
export interface IntentLegs {
  risk?: TokenEnrichment | null;
  signal?: TrenchesCheckResult | null;
  buyMomentum?: ExitSignalResult | null;
  sellExit?: ExitSignalResult | null;
}

export function normalizeCategory(c: AudaceIntentCheckInput['category']): 'degen' | 'crypto_bro' | 'whale' {
  return c === 'crypto-bro' ? 'crypto_bro' : c;
}

export function intentDirection(tokenIn: string, tokenOut: string): IntentDirection {
  if (tokenIn === USDC_MINT && tokenOut !== USDC_MINT) return 'buy';
  if (tokenOut === USDC_MINT && tokenIn !== USDC_MINT) return 'sell';
  return 'swap';
}

/** A standard season runs Monday 00:00 UTC → Saturday 00:00 UTC. Returns the next Saturday 00:00 UTC after `now`. */
export function nextSaturdayUtc(now: number): string {
  const d = new Date(now);
  const midnight = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  let days = (6 - d.getUTCDay() + 7) % 7;
  if (days === 0 && now >= midnight) days = 7;
  return new Date(midnight + days * 86_400_000).toISOString();
}

/** Price impact at `sizeUsd`: the estimate at the smallest probed size that covers it (else the largest). */
export function impactAtSize(estimates: TokenEnrichment['slippage_estimates'], sizeUsd: number | null): number | null {
  if (!estimates?.length || sizeUsd == null) return null;
  const sorted = [...estimates].sort((a, b) => a.size_usd - b.size_usd);
  const hit = sorted.find((e) => e.size_usd >= sizeUsd) ?? sorted[sorted.length - 1]!;
  return hit.price_impact_pct;
}

/** Which upstream reads an intent needs. Inside the snapshot buffer it needs none. */
export function legsNeeded(direction: IntentDirection, category: 'degen' | 'crypto_bro' | 'whale', minutesToSnapshot: number) {
  if (minutesToSnapshot <= SNAPSHOT_BUFFER_MIN) return { buy: false, signal: false, sell: false };
  return {
    buy: direction !== 'sell',
    signal: direction !== 'sell' && category === 'degen',
    sell: direction !== 'buy',
  };
}

function buyCheck(mint: string, legs: IntentLegs, category: string, network: Network, sizeUsd: number | null): BuyCheck {
  const codes: string[] = [];
  let flags: string[] | null = null;
  if (legs.risk) {
    flags = legs.risk.risk_flags ?? [];
    const block = new Set<string>(BLOCK_FLAGS[network]);
    for (const f of flags) if (block.has(f)) codes.push(`RISK_${f.toUpperCase()}`);
  } else codes.push('RISK_UNAVAILABLE');

  let signal: TrenchesCheckVerdict | null = null;
  if (category === 'degen') {
    if (legs.signal) {
      signal = legs.signal.verdict;
      if (SIGNAL_RANK[signal] < SIGNAL_RANK[MIN_DEGEN_SIGNAL]) codes.push('SIGNAL_TOO_WEAK');
    } else codes.push('SIGNAL_UNAVAILABLE');
  }

  let momentum: ExitVerdict | null = null;
  if (legs.buyMomentum) {
    momentum = legs.buyMomentum.verdict;
    if (momentum === 'EXIT' || momentum === 'DERISK') codes.push(`MOMENTUM_${momentum}`);
  } else codes.push('MOMENTUM_UNAVAILABLE');

  let impact: number | null = null;
  if (network === 'mainnet') {
    impact = impactAtSize(legs.risk?.slippage_estimates, sizeUsd);
    if (impact != null && impact > MAX_PRICE_IMPACT_PCT) codes.push('HIGH_PRICE_IMPACT');
  }

  return {
    mint,
    symbol: legs.risk?.symbol ?? legs.signal?.symbol ?? legs.buyMomentum?.symbol ?? null,
    allow: codes.length === 0,
    codes,
    risk_flags: flags,
    degen_signal: signal,
    exit_verdict: momentum,
    price_impact_pct: impact,
  };
}

function sellCheck(mint: string, legs: IntentLegs): SellCheck {
  const r = legs.sellExit;
  if (!r) return { mint, symbol: null, exit_verdict: null, exit_score: null, codes: ['EXIT_UNAVAILABLE'] };
  return { mint, symbol: r.symbol, exit_verdict: r.verdict, exit_score: r.exit_score, codes: [`EXIT_${r.verdict}`] };
}

/** Pure: the verdict for one intent, given the leg results. */
export function decideIntent(
  input: AudaceIntentCheckInput,
  legs: IntentLegs,
  now: number,
): AudaceIntentCheckResult {
  const category = normalizeCategory(input.category);
  const network = input.network;
  const direction = intentDirection(input.tokenInMint, input.tokenOutMint);
  const endsAt = input.seasonEndsAt ?? nextSaturdayUtc(now);
  const minutes = Math.floor((Date.parse(endsAt) - now) / 60_000);
  const caveats: string[] = [];
  if (!input.seasonEndsAt) {
    caveats.push('seasonEndsAt not given: assumed the standard season end, the next Saturday 00:00 UTC. Pass season.active.endsAt from GET /v1/me/state for the real date.');
  }

  const inPrice = direction === 'buy' ? 1 : legs.sellExit?.price_usd ?? legs.risk?.price_usd ?? null;
  const sizeUsd = inPrice != null ? Math.round(input.amountIn * inPrice * 100) / 100 : null;

  let verdict: IntentVerdict;
  let fraction: number;
  let codes: string[];
  let buy: BuyCheck | null = null;
  let sell: SellCheck | null = null;
  const why: string[] = [];

  if (minutes <= SNAPSHOT_BUFFER_MIN) {
    codes = ['SNAPSHOT_CLOCK'];
    const when = minutes >= 0 ? `${minutes} min to the season-end snapshot` : 'the season-end snapshot has passed';
    if (direction === 'sell') {
      verdict = 'PROCEED';
      fraction = 1;
      why.push(`${when}: the League Wallet must hold USDC only, so sell the whole position.`);
    } else {
      verdict = 'HOLD';
      fraction = 0;
      why.push(`${when}: do not open a position now${direction === 'swap' ? '; swap to USDC instead' : ''}. A non-USDC balance at the snapshot forfeits the season.`);
      if (direction === 'swap') codes.push('ROUTE_TO_USDC');
    }
  } else if (direction === 'sell') {
    sell = sellCheck(input.tokenInMint, legs);
    codes = [...sell.codes];
    const v = sell.exit_verdict;
    verdict = v === 'EXIT' ? 'PROCEED' : v === 'DERISK' ? 'REDUCE' : 'HOLD';
    fraction = verdict === 'PROCEED' ? 1 : verdict === 'REDUCE' ? DERISK_FRACTION : 0;
    if (v === 'EXIT') why.push('Exit verdict EXIT: the tape says get out.');
    else if (v === 'DERISK') why.push(`Exit verdict DERISK: momentum is deteriorating; sell ${DERISK_FRACTION * 100}% and keep the rest under watch.`);
    else if (v === 'HOLD') why.push('Exit verdict HOLD: no exit case in the current tape. Sell anyway if your own plan says so.');
    else why.push('No exit verdict available: SolEnrich sees no basis to sell. Your own plan decides.');
    if (legs.sellExit?.reasoning) why.push(legs.sellExit.reasoning);
  } else {
    buy = buyCheck(input.tokenOutMint, legs, category, network, direction === 'buy' ? input.amountIn : sizeUsd);
    if (direction === 'swap') sell = sellCheck(input.tokenInMint, legs);
    codes = [...buy.codes];
    verdict = buy.allow ? 'PROCEED' : 'HOLD';
    fraction = buy.allow ? 1 : 0;
    if (buy.allow) why.push('All checks on the token bought pass.');
    else why.push(`Hold: ${buy.codes.join(', ')}.`);
    if (legs.signal?.reasoning) why.push(legs.signal.reasoning);
    if (legs.buyMomentum?.reasoning) why.push(legs.buyMomentum.reasoning);
    if (direction === 'swap' && !buy.allow && (sell?.exit_verdict === 'EXIT' || sell?.exit_verdict === 'DERISK')) {
      codes.push('ROUTE_TO_USDC');
      why.push(`The token sold reads ${sell.exit_verdict}: sell it to USDC instead of rotating.`);
    }
  }

  if (network === 'devnet') {
    caveats.push('Devnet league: the verdicts read the mainnet market for each mint identity. Devnet pool depth is not part of the verdict.');
  } else if (direction === 'sell') {
    caveats.push('Mainnet: price impact is checked on buys only. Check your quote before a large sell.');
  }
  caveats.push('A verdict on market signals, not a guarantee. Not financial advice.');

  return {
    intent: { category, network, direction, token_in: input.tokenInMint, token_out: input.tokenOutMint, amount_in: input.amountIn, size_usd: sizeUsd },
    verdict,
    suggested_fraction: fraction,
    codes,
    season: { ends_at: endsAt, ends_at_source: input.seasonEndsAt ? 'input' : 'default_saturday', minutes_to_snapshot: minutes },
    buy_check: buy,
    sell_check: sell,
    reasoning: why.join(' '),
    caveats,
    last_updated: formatTimestamp(),
  };
}

export class AudaceIntentChecker {
  constructor(
    private tokens: TokenAnalyzer,
    private trenches: TrenchesCheckAnalyzer,
    private exits: ExitSignalAnalyzer,
  ) {}

  async check(input: AudaceIntentCheckInput, now = Date.now()): Promise<AudaceIntentCheckResult> {
    const category = normalizeCategory(input.category);
    const direction = intentDirection(input.tokenInMint, input.tokenOutMint);
    const endsAt = input.seasonEndsAt ?? nextSaturdayUtc(now);
    const need = legsNeeded(direction, category, Math.floor((Date.parse(endsAt) - now) / 60_000));

    const settle = async <T>(on: boolean, run: () => Promise<T>): Promise<T | null> => {
      if (!on) return null;
      try {
        return await run();
      } catch (err) {
        console.warn('[audace-intent-check] leg failed:', (err as Error).message);
        return null;
      }
    };
    // Same mint for a token→token swap is impossible (AudaceFi rejects it), so the
    // buy-side momentum and sell-side exit reads never collide.
    const [risk, signal, buyMomentum, sellExit] = await Promise.all([
      settle(need.buy, () => this.tokens.enrich(input.tokenOutMint, false)),
      settle(need.signal, () => this.trenches.check(input.tokenOutMint)),
      settle(need.buy, () => this.exits.analyze(input.tokenOutMint)),
      settle(need.sell, () => this.exits.analyze(input.tokenInMint)),
    ]);
    return decideIntent(input, { risk, signal, buyMomentum, sellExit }, now);
  }
}
