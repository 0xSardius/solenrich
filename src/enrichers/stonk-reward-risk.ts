import { CACHE_TTL } from '../config';
import type { PayoutStatus } from './stonk-gems';
import type { Cache } from '../cache';
import type { SolanaRpcClient } from '../sources/solana-rpc';
import type { StonkFunClient, StonkToken, StonkLaunch, StonkRewardTotals } from '../sources/stonkfun';
import { readMintInfo, type MintInfo } from '../sources/token-2022';
import { PublicKey } from '@solana/web3.js';
import { normalizeCategory, type StonkCategory } from './stonk-index';

// Reward-coin health score (0-100, higher = the holder tax reaches holders
// and the coin has a track record). The hard rule: a coin whose tax provably
// goes nowhere — zero-rate, zero cap, unadopted mint, or a withdraw authority
// that is not StonkFun's distributor — scores under 20 regardless of market.

/**
 * Top-10 share of supply held by wallets. Accounts whose owner is off-curve (a program PDA: the LaunchLab curve vault,
 * the CPMM pool vault, a locker) are excluded, because they hold the unsold or pooled supply and receive no rewards.
 * owners null (the owner read failed) → the raw token-account sum, labelled `token_accounts`. Pure, for tests.
 */
export function walletTop10Pct(
  largest: Array<{ address: string; amount: number }>,
  owners: Array<{ tokenAccount: string; owner: string | null }> | null,
  supply: number,
): { pct: number | null; basis: 'wallets' | 'token_accounts'; excluded_program_accounts: number } {
  if (!(supply > 0) || !largest.length) return { pct: null, basis: owners ? 'wallets' : 'token_accounts', excluded_program_accounts: 0 };
  const pct = (rows: Array<{ amount: number }>) => Math.round((rows.slice(0, 10).reduce((a, h) => a + h.amount, 0) / supply) * 10000) / 100;
  if (!owners) return { pct: pct(largest), basis: 'token_accounts', excluded_program_accounts: 0 };
  const ownerOf = new Map(owners.map((o) => [o.tokenAccount, o.owner]));
  const isProgram = (a: { address: string }) => {
    const o = ownerOf.get(a.address);
    if (!o) return false; // unresolved: keep it (unknown, not proven a program)
    try { return !PublicKey.isOnCurve(new PublicKey(o).toBytes()); } catch { return false; }
  };
  const wallets = largest.filter((a) => !isProgram(a));
  return { pct: pct(wallets), basis: 'wallets', excluded_program_accounts: largest.length - wallets.length };
}

/** StonkFun's transfer-fee withdraw authority (from /launchlab/pricing modes.reward). */
export const STONKFUN_WITHDRAW_AUTHORITY = '5KXDF6QnqhBj72hDtJNkkpFaQVUfbFXNybMsp3DiK6tD';

export type RewardMechanism = 'transfer_tax' | 'legacy_fee_share' | 'none';
/** UNKNOWN: StonkFun did not answer, so adoption cannot be judged. PENDING_ADOPTION: StonkFun has no listing (404)
 *  but the mint's tax is withheld to StonkFun's own distributor — a fresh launch the list has not picked up yet. */
export type RewardRiskLevel = 'HEALTHY' | 'MIXED' | 'WEAK' | 'BROKEN' | 'PENDING_ADOPTION' | 'UNKNOWN';

/** 'ok' = StonkFun answered with a record; 'missing' = StonkFun answered 404; 'failed' = no answer (timeout, 5xx, 429). */
export type ReadState = 'ok' | 'missing' | 'failed';

export interface RewardRiskInput {
  mint: string;
  listed: boolean;
  /** How the StonkFun token read went. Defaults from `listed` when absent (older callers / fixtures). */
  tokenRead?: ReadState;
  rewardsRead?: ReadState;
  token: StonkToken | null;
  launch: StonkLaunch | null;
  rewards: StonkRewardTotals | null;
  rewardsQuote: { symbol: string; decimals: number } | null;
  onchain: MintInfo;
  expectedWithdrawAuthority: string;
  top10Pct: number | null;
  /** How top10Pct was summed (see walletTop10Pct). Absent = 'token_accounts'. */
  top10Basis?: 'wallets' | 'token_accounts';
  /** @deprecated ignored since 2026-11-17: the top-20 largest-accounts length is a cap, not a holder count. */
  holderCountRpc?: number;
  /** Hours since the mint's first transaction, read only for unlisted StonkFun-shaped mints. null/absent = unknown. */
  mintAgeHours?: number | null;
  now: number;
}

/** An unlisted mint whose tax goes to StonkFun's distributor is PENDING_ADOPTION while younger than this; after that,
 *  StonkFun has had time to list it, and it is BROKEN (not adopted). */
export const PENDING_ADOPTION_MAX_AGE_H = 6;

export interface RewardRiskResult {
  mint: string;
  symbol: string | null;
  name: string | null;
  /** The thing a holder observes: PAYING (payout in the last 24h), STALE (has paid, not recently), NEVER (adopted, no payouts), NOT_REWARD (nothing pays holders). */
  payout_status: PayoutStatus;
  /** Transfer tax as a trading cost: one transfer and a full round trip, from the on-chain bps. */
  trading_cost: { bps: number | null; per_transfer_pct: number | null; round_trip_pct: number | null };
  score: number;
  level: RewardRiskLevel;
  reasons: string[];
  warnings: string[];
  reward_mechanism: RewardMechanism;
  adoption: {
    listed_on_stonkfun: boolean;
    mode: string | null;
    launchpad: string | null;
    withdraw_authority_is_stonkfun: boolean | null;
  };
  transfer_fee: {
    onchain_bps: number | null;
    onchain_maximum_fee_raw: string | null;
    maximum_fee_binds: boolean | null;
    withdraw_withheld_authority: string | null;
    config_authority: string | null;
    withheld_amount_raw: string | null;
    stonkfun_bps: number | null;
    token_program: MintInfo['program'];
  };
  rewards: {
    distributed_tokens: number | null;
    distributed_raw: string | null;
    reward_asset: string | null;
    payout_count: number | null;
    holder_count: number | null;
    last_payout_at: string | null;
    hours_since_last_payout: number | null;
  };
  flywheel_active: boolean;
  /** count: StonkFun's reward-receiving holder count, or null. ('rpc' is no longer produced.) */
  /** top10_basis: 'wallets' = pool/curve vaults (program-owned accounts) excluded; 'token_accounts' = owners not read. */
  holders: { count: number | null; top10_pct: number | null; top10_basis: 'wallets' | 'token_accounts'; source: 'stonkfun' | 'rpc' | 'none' };
  /** StonkFun reads that failed. degraded = adoption or payout status could not be judged. */
  data_quality: { degraded: boolean; unavailable: string[] };
  quote: { mint: string | null; symbol: string | null; category: StonkCategory | null; category_raw: string | null };
  market: { price_usd: number | null; market_cap_usd: number | null; volume_24h_usd: number | null; price_change_24h_pct: number | null };
  age_days: number | null;
  status: string | null;
  graduated: boolean;
  next_steps: string[];
  llm_brief: string;
}

const BROKEN_CAP = 15;

/** Pure scorer. Exported for fixture-driven unit tests. */
export function scoreRewardRisk(input: RewardRiskInput): Omit<RewardRiskResult, 'llm_brief'> {
  const { token, launch, rewards, onchain } = input;
  const reasons: string[] = [];
  const warnings: string[] = [];
  let score = 0;
  let cap = 100;
  const capTo = (n: number, why: string) => { cap = Math.min(cap, n); reasons.push(why); };

  const listedReward = input.listed && token?.mode === 'reward';
  const tokenRead: ReadState = input.tokenRead ?? (input.listed ? 'ok' : 'missing');
  const rewardsRead: ReadState = input.rewardsRead ?? (rewards ? 'ok' : 'missing');
  const fee = onchain.transferFee;
  // Withheld to StonkFun's own distributor, with a non-zero rate and cap: the on-chain shape of a StonkFun reward coin.
  const stonkfunShapedFee = !!fee && fee.withdrawWithheldAuthority === input.expectedWithdrawAuthority && fee.bps > 0
    && BigInt(fee.maximumFeeRaw || '0') > 0n;
  let pendingAdoption = false;
  const supply = onchain.supplyRaw ? BigInt(onchain.supplyRaw) : null;
  const maxFee = fee ? BigInt(fee.maximumFeeRaw || '0') : null;

  // --- mechanism -----------------------------------------------------------
  let mechanism: RewardMechanism = 'none';
  if (fee) mechanism = 'transfer_tax';
  else if (listedReward && onchain.program === 'spl-token') mechanism = 'legacy_fee_share';

  // --- adoption (max 25) ---------------------------------------------------
  if (!onchain.exists) {
    capTo(0, 'mint account does not exist on-chain');
  } else if (listedReward) {
    score += 20;
    reasons.push(`listed on StonkFun as a reward-mode ${token?.launchpad ?? 'unknown'} launch`);
    if (token?.launchpad) score += 5;
  } else if (input.listed && token?.mode === 'standard') {
    capTo(BROKEN_CAP, 'listed on StonkFun as a STANDARD launch — no holder rewards; the creator earns the trade fee instead');
  } else if (tokenRead === 'failed') {
    // StonkFun did not answer: adoption is unknown, not refused. No cap; the level becomes UNKNOWN below.
    warnings.push('StonkFun did not answer for this mint (timeout or error) — adoption and payouts could not be checked; retry in a minute');
  } else if (fee && stonkfunShapedFee && input.mintAgeHours != null && input.mintAgeHours < PENDING_ADOPTION_MAX_AGE_H) {
    // 404, but the tax is withheld to StonkFun's distributor and the mint is new: StonkFun has not listed it yet.
    pendingAdoption = true;
    warnings.push(`StonkFun has no listing for this ${input.mintAgeHours.toFixed(1)}h-old mint yet, but its transfer tax is withheld to StonkFun's distributor — a new launch usually appears within minutes; check again before relying on payouts`);
  } else if (fee) {
    const age = input.mintAgeHours != null ? ` ${input.mintAgeHours >= 48 ? `${(input.mintAgeHours / 24).toFixed(0)} days` : `${input.mintAgeHours.toFixed(0)}h`} after launch` : '';
    capTo(BROKEN_CAP, `not adopted by StonkFun${age} — a transfer tax is configured but no platform distributes it, so the tax reaches nobody`);
  } else {
    capTo(BROKEN_CAP, 'not a StonkFun coin and no transfer tax on the mint — nothing pays holders');
  }

  // --- tax integrity (max 25) ---------------------------------------------
  let withdrawIsStonkfun: boolean | null = null;
  let maxFeeBinds: boolean | null = null;
  if (fee) {
    withdrawIsStonkfun = fee.withdrawWithheldAuthority === input.expectedWithdrawAuthority;
    maxFeeBinds = supply != null && maxFee != null ? maxFee < supply / 100n : null;
    if (fee.bps <= 0) {
      capTo(BROKEN_CAP, 'transfer tax is ZERO-RATE on-chain (0 bps) — holders receive nothing');
    } else if (maxFee === 0n) {
      capTo(BROKEN_CAP, 'transfer-fee maximum is 0 on-chain — the tax is capped at nothing per transfer');
    } else if (!withdrawIsStonkfun) {
      capTo(BROKEN_CAP, `withheld tax is withdrawable by ${fee.withdrawWithheldAuthority ?? 'nobody'}, not StonkFun's distributor — rewards cannot be paid out to holders by the platform`);
    } else {
      score += 25;
      reasons.push(`on-chain transfer tax ${fee.bps} bps, withheld to StonkFun's distributor`);
      if (maxFeeBinds) {
        score -= 5;
        warnings.push(`maximum fee per transfer (${fee.maximumFeeRaw}) is below 1% of supply — large transfers are under-taxed`);
      }
    }
    if (fee.configAuthority) {
      score -= 5;
      warnings.push(`transfer fee is MUTABLE — ${fee.configAuthority} can change the rate later`);
    }
    const stonkBps = token?.transferFee?.bps ?? launch?.transferFee?.bps ?? null;
    if (stonkBps != null && stonkBps !== fee.bps) {
      warnings.push(`StonkFun records ${stonkBps} bps but the mint carries ${fee.bps} bps on-chain`);
    }
  } else if (mechanism === 'legacy_fee_share') {
    score += 12;
    reasons.push('legacy reward mechanism (classic SPL mint, pre-V3 fee share) — no on-chain transfer tax to verify; rely on the distribution record');
  } else if (listedReward && onchain.program === 'token-2022') {
    capTo(BROKEN_CAP, 'listed as reward mode but the Token-2022 mint has NO transfer-fee extension — nothing is withheld for holders');
  }

  // --- distribution record (max 20) ---------------------------------------
  let hoursSince: number | null = null;
  if (rewards) {
    if (rewards.distributedTokens > 0) {
      score += 8;
      reasons.push(`${formatQty(rewards.distributedTokens)} ${input.rewardsQuote?.symbol ?? 'quote'} distributed over ${rewards.payoutCount} payouts to ${rewards.holderCount} holders`);
    } else {
      warnings.push('no rewards distributed yet');
    }
    if (rewards.lastPayoutAt) {
      hoursSince = Math.round(((input.now - Date.parse(rewards.lastPayoutAt)) / 3_600_000) * 10) / 10;
      if (hoursSince <= 24) { score += 8; reasons.push(`last payout ${hoursSince}h ago`); }
      else if (hoursSince <= 24 * 7) { score += 5; reasons.push(`last payout ${(hoursSince / 24).toFixed(1)} days ago`); }
      else warnings.push(`last payout ${(hoursSince / 24).toFixed(0)} days ago — distributions have gone quiet`);
    }
    if (rewards.payoutCount >= 100) score += 4;
  } else if (listedReward && rewardsRead === 'failed') {
    warnings.push('StonkFun\'s rewards record did not load (timeout or error) — payout status is unknown, not "never paid"');
  } else if (listedReward) {
    warnings.push('StonkFun returned no rewards record for this coin');
  }

  // --- flywheel (5) --------------------------------------------------------
  const flywheel = token?.flywheel?.active === true;
  if (flywheel) { score += 5; reasons.push('flywheel active — in the platform buyback rankings'); }

  // --- holders (max 15) ----------------------------------------------------
  // StonkFun's reward-receiving holder count only. The top-20 largest-accounts length used to fill in here: a cap
  // reported as a count (always ≤ 20, and +3 score for "≥ 20" when there were exactly 20 accounts).
  const stonkHolders = rewards?.holderCount ?? 0;
  const holderCount = stonkHolders > 0 ? stonkHolders : null;
  const holderSource: RewardRiskResult['holders']['source'] = stonkHolders > 0 ? 'stonkfun' : 'none';
  if (holderCount != null) {
    if (holderCount >= 1000) score += 10;
    else if (holderCount >= 100) score += 6;
    else if (holderCount >= 20) score += 3;
    else warnings.push(`only ${holderCount} reward-receiving holders`);
  }
  if (input.top10Pct != null && input.top10Basis !== 'wallets') {
    // Owners not read: the sum can include the pool/curve vault, which receives no rewards. Reported, not scored.
    warnings.push(`top-10 token accounts hold ${input.top10Pct.toFixed(1)}% of supply (owners not read — may include the pool vault; not scored)`);
  } else if (input.top10Pct != null) {
    if (input.top10Pct < 30) { score += 5; reasons.push(`top-10 holders own ${input.top10Pct.toFixed(1)}% — distributed`); }
    else if (input.top10Pct < 50) { score += 3; }
    else if (input.top10Pct >= 70) { score -= 5; warnings.push(`top-10 holders own ${input.top10Pct.toFixed(1)}% of supply — rewards concentrate in a few wallets`); }
    else warnings.push(`top-10 holders own ${input.top10Pct.toFixed(1)}% of supply`);
  }

  // --- quote asset (max 5) -------------------------------------------------
  const quoteCategoryRaw = token?.quote?.category ?? null;
  const quoteCategory = quoteCategoryRaw ? normalizeCategory(quoteCategoryRaw) : null;
  if (quoteCategory) {
    if (['xstock', 'prestock', 'currency', 'solana'].includes(quoteCategory)) { score += 5; reasons.push(`rewards paid in ${token?.quote?.symbol} (${quoteCategoryRaw})`); }
    else if (quoteCategory === 'custom') { score += 2; warnings.push(`rewards paid in ${token?.quote?.symbol}, a custom mint — the reward asset carries its own token risk`); }
    else if (quoteCategory === 'leverage') { score += 1; warnings.push(`rewards paid in a leveraged asset (${token?.quote?.symbol})`); }
    else score += 3;
  }

  // --- age / graduation (5) ------------------------------------------------
  const createdAt = token?.createdAt ?? launch?.createdAt ?? null;
  const ageDays = createdAt ? Math.round(((input.now - Date.parse(createdAt)) / 86_400_000) * 100) / 100 : null;
  const graduated = token?.status === 'graduated';
  if (graduated) score += 3;
  if (ageDays != null && ageDays >= 7) score += 2;
  else if (ageDays != null) warnings.push(`launched ${ageDays < 1 ? `${(ageDays * 24).toFixed(1)}h` : `${ageDays.toFixed(1)}d`} ago — thin track record`);

  score = Math.max(0, Math.min(cap, Math.round(score)));
  const scoredLevel: RewardRiskLevel = score >= 70 ? 'HEALTHY' : score >= 45 ? 'MIXED' : score >= 20 ? 'WEAK' : 'BROKEN';
  // A hard on-chain BROKEN (zero rate, zero cap, foreign withdraw authority, mint missing) stands even when StonkFun
  // is down. Otherwise a failed StonkFun read means the coin cannot be judged.
  const hardBroken = cap <= BROKEN_CAP;
  const level: RewardRiskLevel = hardBroken ? scoredLevel
    : tokenRead === 'failed' ? 'UNKNOWN'
    : pendingAdoption ? 'PENDING_ADOPTION'
    : scoredLevel;

  const nextSteps = level === 'BROKEN'
    ? ['Do not buy for the holder yield — the tax does not reach holders.', 'If you own it, exit-signal gives the sell-side read.']
    : level === 'UNKNOWN' ? ['Retry stonk-reward-risk in a minute — StonkFun did not answer.', 'due-diligence for structural safety meanwhile.']
    : level === 'PENDING_ADOPTION' ? ['Check again in a few minutes, once StonkFun lists the launch.', 'stonk-launch-preflight validates a launch before it is sent.']
    : ['stonk-yield for the realized 7d/30d holder yield on this coin.', 'due-diligence for structural safety (authorities, liquidity, rug flags).', 'exit-signal while you hold it.'];

  const payout: PayoutStatus =
    level === 'BROKEN' || mechanism === 'none' ? 'NOT_REWARD'
    : level === 'UNKNOWN' || level === 'PENDING_ADOPTION' ? 'UNKNOWN'
    : !rewards && rewardsRead === 'failed' ? 'UNKNOWN'
    : !rewards || rewards.payoutCount <= 0 ? 'NEVER'
    : hoursSince != null && hoursSince <= 24 ? 'PAYING'
    : 'STALE';
  const unavailable = [tokenRead === 'failed' ? 'stonkfun_token' : null, rewardsRead === 'failed' ? 'stonkfun_rewards' : null]
    .filter((s): s is string => s != null);

  return {
    mint: input.mint,
    symbol: token?.symbol ?? launch?.symbol ?? null,
    name: token?.name ?? launch?.name ?? null,
    payout_status: payout,
    trading_cost: {
      bps: fee?.bps ?? null,
      per_transfer_pct: fee ? Math.round(fee.bps) / 100 : null,
      round_trip_pct: fee ? Math.round(fee.bps * 2) / 100 : null,
    },
    score,
    level,
    reasons,
    warnings,
    reward_mechanism: mechanism,
    adoption: {
      listed_on_stonkfun: input.listed,
      mode: token?.mode ?? launch?.mode ?? null,
      launchpad: token?.launchpad ?? launch?.launchpad ?? null,
      withdraw_authority_is_stonkfun: withdrawIsStonkfun,
    },
    transfer_fee: {
      onchain_bps: fee?.bps ?? null,
      onchain_maximum_fee_raw: fee?.maximumFeeRaw ?? null,
      maximum_fee_binds: maxFeeBinds,
      withdraw_withheld_authority: fee?.withdrawWithheldAuthority ?? null,
      config_authority: fee?.configAuthority ?? null,
      withheld_amount_raw: fee?.withheldAmountRaw ?? null,
      stonkfun_bps: token?.transferFee?.bps ?? launch?.transferFee?.bps ?? null,
      token_program: onchain.program,
    },
    rewards: {
      distributed_tokens: rewards?.distributedTokens ?? null,
      distributed_raw: rewards?.distributedRaw ?? null,
      reward_asset: input.rewardsQuote?.symbol ?? token?.quote?.symbol ?? null,
      payout_count: rewards?.payoutCount ?? null,
      holder_count: rewards?.holderCount ?? null,
      last_payout_at: rewards?.lastPayoutAt ?? null,
      hours_since_last_payout: hoursSince,
    },
    flywheel_active: flywheel,
    holders: { count: holderCount, top10_pct: input.top10Pct, top10_basis: input.top10Basis ?? 'token_accounts', source: holderSource },
    data_quality: { degraded: unavailable.length > 0, unavailable },
    quote: { mint: token?.quote?.mint ?? launch?.quote?.mint ?? null, symbol: token?.quote?.symbol ?? launch?.quote?.symbol ?? null, category: quoteCategory, category_raw: quoteCategoryRaw },
    market: {
      price_usd: token?.market?.priceUsd ?? null,
      market_cap_usd: token?.market?.marketCapUsd ?? null,
      volume_24h_usd: token?.market?.volume24hUsd ?? null,
      price_change_24h_pct: token?.market?.priceChange24h ?? null,
    },
    age_days: ageDays,
    status: token?.status ?? null,
    graduated,
    next_steps: nextSteps,
  };
}

function formatQty(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(2)}K`;
  if (n >= 1) return n.toFixed(2);
  return n.toPrecision(3);
}

export class StonkRewardRiskAnalyzer {
  constructor(
    private readonly client: StonkFunClient,
    private readonly rpc: SolanaRpcClient,
    private readonly cache: Cache,
    private readonly brief: (r: Omit<RewardRiskResult, 'llm_brief'>) => string,
  ) {}

  async analyze(mint: string): Promise<RewardRiskResult> {
    const cacheKey = `stonk:reward-risk:${mint}`;
    const cached = await this.cache.get<RewardRiskResult>(cacheKey);
    if (cached) return cached;

    const now = Date.now();
    const [tokenRes, rewardsRes, onchainRes, holdersRes] = await Promise.allSettled([
      this.client.getToken(mint),
      this.client.getTokenRewards(mint),
      readMintInfo(this.rpc.getConnection(), mint),
      this.rpc.getTokenLargestAccounts(mint),
    ]);

    // getToken / getTokenRewards return null for a 404 and throw for anything else (timeout, 5xx, second 429).
    // Before 2026-11-17 both became null, so a StonkFun timeout read as "not adopted" → BROKEN for a paying coin.
    const tokenData = tokenRes.status === 'fulfilled' ? tokenRes.value : null;
    const rewardsData = rewardsRes.status === 'fulfilled' ? rewardsRes.value : null;
    const tokenRead: ReadState = tokenRes.status === 'rejected' ? 'failed' : tokenData ? 'ok' : 'missing';
    const rewardsRead: ReadState = rewardsRes.status === 'rejected' ? 'failed' : rewardsData ? 'ok' : 'missing';
    if (onchainRes.status === 'rejected') throw new Error(`on-chain mint read failed: ${onchainRes.reason instanceof Error ? onchainRes.reason.message : String(onchainRes.reason)}`);
    const onchain = onchainRes.value;
    const largest = holdersRes.status === 'fulfilled' ? holdersRes.value : [];

    // Top-10 by wallet: one getMultipleAccounts call resolves the owners so pool/curve vaults drop out.
    let owners: Array<{ tokenAccount: string; owner: string | null }> | null = null;
    if (largest.length) {
      owners = await this.rpc.resolveTokenAccountOwners(largest.map((a) => a.address)).catch(() => null);
    }
    const top10 = walletTop10Pct(largest, owners, onchain.supplyRaw ? Number(onchain.supplyRaw) : 0);
    const top10Pct = top10.pct;

    // Try the expected authority from the live pricing doc for this quote;
    // fall back to the recorded constant so the score never depends on it.
    let expectedAuthority = STONKFUN_WITHDRAW_AUTHORITY;
    const quoteMint = tokenData?.token?.quote?.mint;
    if (quoteMint) {
      try {
        const pricing = await this.client.getLaunchLabPricing(quoteMint);
        if (pricing?.modes?.reward?.withdrawWithheldAuthority) expectedAuthority = pricing.modes.reward.withdrawWithheldAuthority;
      } catch { /* keep the constant */ }
    }

    // Age only matters for an unlisted mint (PENDING_ADOPTION vs not adopted): one signatures read, newest 1,000.
    // Fewer than 1,000 = the oldest is the mint's first tx; a full page = a busy mint, not a fresh launch.
    let mintAgeHours: number | null = null;
    if (tokenRead === 'missing' && onchain.transferFee) {
      try {
        const sigs = await this.rpc.getConnection().getSignaturesForAddress(new PublicKey(mint), { limit: 1000 });
        const oldest = sigs.length > 0 && sigs.length < 1000 ? sigs[sigs.length - 1].blockTime : null;
        mintAgeHours = oldest ? (now / 1000 - oldest) / 3600 : null;
      } catch { /* unknown age → treated as not fresh */ }
    }

    const scored = scoreRewardRisk({
      mint,
      listed: tokenData != null,
      mintAgeHours,
      tokenRead,
      rewardsRead,
      token: tokenData?.token ?? null,
      launch: tokenData?.launch ?? null,
      rewards: rewardsData?.rewards ?? null,
      rewardsQuote: rewardsData?.quote ?? null,
      onchain,
      expectedWithdrawAuthority: expectedAuthority,
      top10Pct,
      top10Basis: top10.basis,
      now,
    });
    const result: RewardRiskResult = { ...scored, llm_brief: this.brief(scored) };
    // A failed StonkFun read is cached briefly (retry soon); a pending listing for a minute; the rest as before.
    const ttl = scored.data_quality.degraded ? 15 : scored.level === 'PENDING_ADOPTION' ? 60 : CACHE_TTL.stonkRewardRisk;
    await this.cache.set(cacheKey, result, ttl);
    return result;
  }
}
