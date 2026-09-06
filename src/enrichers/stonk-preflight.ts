import type { Connection } from '@solana/web3.js';
import type { StonkFunClient, StonkLaunchLabPricing, StonkMode } from '../sources/stonkfun';
import {
  decodeLaunchTransaction,
  LaunchLabDecodeError,
  LAUNCHLAB_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  type DecodedLaunchTransaction,
  type DecodedLaunchLabInitialize,
} from '../sources/launchlab';

// Launch preflight: decode the LaunchLab initialize instruction an agent is
// about to broadcast and diff every parameter against StonkFun's published
// shape for that quote + mode. A pool built to any other shape is not
// adopted — for a taxed mint that means the tax is collected by nobody.

export interface PreflightMismatch {
  field: string;
  expected: string;
  actual: string;
  fix: string;
}

export interface StonkPreflightResult {
  ok: boolean;
  quote_mint: string;
  mode: StonkMode;
  mismatches: PreflightMismatch[];
  warnings: string[];
  decoded: {
    variant: string | null;
    instruction_index: number | null;
    account_count: number | null;
    fee_payer: string | null;
    base_mint: string | null;
    name: string | null;
    symbol: string | null;
    params: DecodedLaunchLabInitialize['params'] | null;
    trailing_accounts: string[];
  };
  expected: {
    program_id: string;
    config_id: string;
    platform_id: string;
    curve_rule: string;
    base_decimals: number;
    supply: string;
    total_sell_a: string;
    total_fund_raising_b: string;
    curve_type: string;
    migrate_type: string;
    transfer_fee_bps: number[] | null;
    withdraw_withheld_authority: string | null;
    pricing_observed_at: string;
  };
  next_steps: string[];
}

/** Raise tolerance: the quote price moves between pricing reads. */
const RAISE_WARN_PCT = 2;
const RAISE_FAIL_PCT = 10;

const RAYDIUM_FEE_FIELDS = { bps: 'transferFeeBasePoints', max: 'maxinumFee' } as const;
const FEE_FIELD_TYPOS: Record<string, string> = {
  transferfeebasispoints: RAYDIUM_FEE_FIELDS.bps,
  transfer_fee_basis_points: RAYDIUM_FEE_FIELDS.bps,
  transfer_fee_base_points: RAYDIUM_FEE_FIELDS.bps,
  transferfeebps: RAYDIUM_FEE_FIELDS.bps,
  feebps: RAYDIUM_FEE_FIELDS.bps,
  maximumfee: RAYDIUM_FEE_FIELDS.max,
  maximum_fee: RAYDIUM_FEE_FIELDS.max,
  maxfee: RAYDIUM_FEE_FIELDS.max,
  max_fee: RAYDIUM_FEE_FIELDS.max,
  maxinum_fee: RAYDIUM_FEE_FIELDS.max,
};

function pctDiff(a: string, b: string): number {
  const x = Number(a); const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y) || y === 0) return Infinity;
  return Math.abs((x - y) / y) * 100;
}

/** Walk an object and report any transfer-fee field spelled the way Raydium does NOT spell it. */
export function lintLaunchParamNames(params: unknown, path = ''): PreflightMismatch[] {
  const out: PreflightMismatch[] = [];
  if (!params || typeof params !== 'object') return out;
  for (const [key, value] of Object.entries(params as Record<string, unknown>)) {
    const here = path ? `${path}.${key}` : key;
    const canonical = FEE_FIELD_TYPOS[key.toLowerCase()];
    if (canonical && key !== canonical) {
      out.push({
        field: `launch_params.${here}`,
        expected: canonical,
        actual: key,
        fix: `Rename to \`${canonical}\` — Raydium's LaunchLab SDK spells the transfer-fee fields \`${RAYDIUM_FEE_FIELDS.bps}\` and \`${RAYDIUM_FEE_FIELDS.max}\` (sic). Any other spelling is dropped and serializes as a zero-rate fee.`,
      });
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) out.push(...lintLaunchParamNames(value, here));
  }
  return out;
}

/** Pure diff. Exported for fixture-driven tests. */
export function diffLaunchAgainstPricing(
  decoded: DecodedLaunchTransaction,
  pricing: StonkLaunchLabPricing,
  mode: StonkMode,
  quoteMint: string,
  launchParams?: unknown,
): Omit<StonkPreflightResult, 'next_steps'> {
  const mismatches: PreflightMismatch[] = [];
  const warnings: string[] = [];
  const m = (field: string, expected: unknown, actual: unknown, fix: string) =>
    mismatches.push({ field, expected: String(expected), actual: String(actual), fix });

  const platformId = mode === 'reward' ? pricing.platform.reward : pricing.platform.standard;
  const curveRule = mode === 'reward' ? pricing.curveRule.reward : pricing.curveRule.standard;
  const expected: StonkPreflightResult['expected'] = {
    program_id: pricing.curve.programId,
    config_id: pricing.curve.configId,
    platform_id: platformId,
    curve_rule: curveRule,
    base_decimals: pricing.curve.baseDecimals,
    supply: pricing.curve.supply,
    total_sell_a: pricing.curve.totalSellA,
    total_fund_raising_b: pricing.raise.raw,
    curve_type: pricing.curve.curveType,
    migrate_type: pricing.curve.migrateType,
    transfer_fee_bps: mode === 'reward' ? pricing.modes.reward.transferFeeBps : null,
    withdraw_withheld_authority: mode === 'reward' ? pricing.modes.reward.withdrawWithheldAuthority : null,
    pricing_observed_at: pricing.prices.observedAt,
  };

  if (quoteMint !== pricing.quote.mint) {
    m('quoteMint', pricing.quote.mint, quoteMint, 'The pricing document is for a different quote. Fetch /launchlab/pricing?quoteMint=<your quote> and rebuild.');
  }
  mismatches.push(...lintLaunchParamNames(launchParams));

  const ix = decoded.initialize;
  const base = {
    ok: false,
    quote_mint: quoteMint,
    mode,
    mismatches,
    warnings,
    expected,
  };

  if (!ix) {
    m('instruction', `${LAUNCHLAB_PROGRAM_ID} initialize_with_token_2022`, decoded.programIds.join(', ') || 'no instructions',
      'No LaunchLab initialize instruction found. Build the launch with Raydium\'s launchpad SDK (initializeWithToken2022) against the LaunchLab program.');
    return { ...base, decoded: { variant: null, instruction_index: null, account_count: null, fee_payer: decoded.feePayer, base_mint: null, name: null, symbol: null, params: null, trailing_accounts: [] } };
  }

  const p = ix.params;
  const a = ix.named;

  // --- program / accounts --------------------------------------------------
  if (ix.programId !== pricing.curve.programId) m('programId', pricing.curve.programId, ix.programId, 'Target the LaunchLab program id from the pricing document.');
  if (a.configId.pubkey !== pricing.curve.configId) m('configId (GlobalConfig)', pricing.curve.configId, a.configId.pubkey, 'Use the GlobalConfig for this quote exactly as published — it fixes the fee tier and migration wallet.');
  if (a.platformId.pubkey !== platformId) {
    const other = mode === 'reward' ? pricing.platform.standard : pricing.platform.reward;
    m('platformId', platformId, a.platformId.pubkey,
      a.platformId.pubkey === other
        ? `This is the ${mode === 'reward' ? 'STANDARD' : 'REWARD'} platform id. For ${mode} mode attribute the create to ${platformId}.`
        : `Attribute the create to StonkFun's ${mode} platform config ${platformId}; any other platform id means the launch is never adopted.`);
  }
  if (a.mintB.pubkey !== pricing.quote.mint) m('mintB (quote)', pricing.quote.mint, a.mintB.pubkey, 'The pool quote mint must be the quote you priced against.');
  if (a.tokenProgramB.pubkey !== pricing.quote.tokenProgram) m('tokenProgramB (quote token program)', pricing.quote.tokenProgram, a.tokenProgramB.pubkey, `${pricing.quote.symbol} lives under ${pricing.quote.tokenProgram}; pass that program for the quote side.`);
  if (!a.mintA.isSigner) warnings.push('mintA is not marked as a signer — the new mint keypair must sign the create.');

  // --- variant / base token program -----------------------------------------
  const expectedVariant = 'initialize_with_token_2022';
  if (ix.variant !== expectedVariant) {
    m('instruction variant', expectedVariant, ix.variant, 'StonkFun adopts launches whose base mint is a 6-decimal Token-2022 mint. Use initializeWithToken2022 (also required for the transfer-fee extension in reward mode).');
  }
  if (a.tokenProgramA.pubkey !== TOKEN_2022_PROGRAM_ID) {
    m('tokenProgramA (base token program)', TOKEN_2022_PROGRAM_ID, a.tokenProgramA.pubkey, 'The base mint must be created under Token-2022.');
  }

  // --- curve shape ---------------------------------------------------------
  if (p.decimals !== pricing.curve.baseDecimals) m('decimals', pricing.curve.baseDecimals, p.decimals, `Base mint decimals must be ${pricing.curve.baseDecimals}.`);
  if (p.curveType !== pricing.curve.curveType) m('curveType', pricing.curve.curveType, p.curveType, `Use curve type ${pricing.curve.curveType} (index ${pricing.curve.curveType === 'ConstantCurve' ? 0 : pricing.curve.curveType === 'FixedCurve' ? 1 : 2}).`);
  if (p.supply !== pricing.curve.supply) m('supply', pricing.curve.supply, p.supply, `Total supply must be exactly ${pricing.curve.supply} raw (${pricing.curve.totalSupplyTokens.toLocaleString()} tokens at ${pricing.curve.baseDecimals} decimals).`);
  if (p.curveType === 'ConstantCurve' && p.totalSellA !== pricing.curve.totalSellA) m('totalSellA', pricing.curve.totalSellA, p.totalSellA ?? 'absent', `totalSellA must be exactly ${pricing.curve.totalSellA} raw.`);
  if (p.migrateType !== pricing.curve.migrateType) m('migrateType', pricing.curve.migrateType, p.migrateType, `Migrate to ${pricing.curve.migrateType} (${pricing.curve.migrateType === 'cpmm' ? 1 : 0}).`);
  const raiseDiff = pctDiff(p.totalFundRaisingB, pricing.raise.raw);
  if (raiseDiff > RAISE_FAIL_PCT) {
    m('totalFundRaisingB (raise)', pricing.raise.raw, p.totalFundRaisingB,
      `The raise is a RAW amount in ${pricing.quote.symbol}'s ${pricing.quote.decimals} decimals — ${pricing.raise.raw} sizes the launch like the default 85 SOL raise. Reusing Raydium's 85-SOL lamport constant on another quote is the classic mistake.`);
  } else if (raiseDiff > RAISE_WARN_PCT) {
    warnings.push(`totalFundRaisingB ${p.totalFundRaisingB} differs from the current raise ${pricing.raise.raw} by ${raiseDiff.toFixed(1)}% — prices moved since the pricing read (observed ${pricing.prices.observedAt}); re-fetch if you want the exact graduation cap.`);
  }
  const v = pricing.curve.vesting;
  if (p.totalLockedAmount !== v.totalLockedAmount) m('totalLockedAmount', v.totalLockedAmount, p.totalLockedAmount, 'No vesting lock: set totalLockedAmount to 0.');
  if (p.cliffPeriod !== v.cliffPeriod) m('cliffPeriod', v.cliffPeriod, p.cliffPeriod, 'Set cliffPeriod to 0.');
  if (p.unlockPeriod !== v.unlockPeriod) m('unlockPeriod', v.unlockPeriod, p.unlockPeriod, 'Set unlockPeriod to 0.');
  if (p.cpmmCreatorFeeOn !== pricing.curve.cpmmCreatorFeeOn) m('cpmmCreatorFeeOn', pricing.curve.cpmmCreatorFeeOn, p.cpmmCreatorFeeOn, `Set cpmmCreatorFeeOn to ${pricing.curve.cpmmCreatorFeeOn}.`);

  // --- transfer fee --------------------------------------------------------
  if (mode === 'reward') {
    const tiers = pricing.modes.reward.transferFeeBps;
    const tf = p.transferFee;
    if (!tf || !tf.present) {
      m('transferFeeExtensionParams', `{ ${RAYDIUM_FEE_FIELDS.bps}: ${tiers.join(' | ')}, ${RAYDIUM_FEE_FIELDS.max}: ${pricing.curve.supply} }`, tf ? 'Option = None (0)' : 'absent',
        `Reward mode needs the Token-2022 transfer-fee extension. Pass transferFeeExtensionParams as { ${RAYDIUM_FEE_FIELDS.bps}, ${RAYDIUM_FEE_FIELDS.max} } — Raydium's exact (misspelled) field names. A misspelled key is silently ignored by the SDK and serializes as no fee, which is what this transaction carries.`);
    } else {
      if (tf.transferFeeBasePoints === 0) {
        m(`transferFeeExtensionParams.${RAYDIUM_FEE_FIELDS.bps}`, tiers.join(' | '), 0,
          `Zero-rate transfer fee: holders would receive nothing. Set ${RAYDIUM_FEE_FIELDS.bps} to ${tiers.join(' or ')}. If you passed \`transferFeeBasisPoints\`, the SDK dropped it — the field is spelled ${RAYDIUM_FEE_FIELDS.bps}.`);
      } else if (!tiers.includes(tf.transferFeeBasePoints)) {
        m(`transferFeeExtensionParams.${RAYDIUM_FEE_FIELDS.bps}`, tiers.join(' | '), tf.transferFeeBasePoints, `StonkFun publishes ${tiers.join(' and ')} bps as the reward tiers; other rates are not adopted.`);
      }
      if (tf.maxinumFee === '0') {
        m(`transferFeeExtensionParams.${RAYDIUM_FEE_FIELDS.max}`, pricing.curve.supply, '0',
          `${RAYDIUM_FEE_FIELDS.max} = 0 caps every transfer's fee at zero. Set it to the full supply (${pricing.curve.supply}) so the cap never binds. If you passed \`maximumFee\`, the SDK dropped it — the field is spelled ${RAYDIUM_FEE_FIELDS.max}.`);
      } else if (BigInt(tf.maxinumFee) < BigInt(pricing.curve.supply) / 100n) {
        warnings.push(`${RAYDIUM_FEE_FIELDS.max} ${tf.maxinumFee} is under 1% of supply — large transfers will be under-taxed. Platform launches use the full supply (${pricing.curve.supply}).`);
      }
    }
  } else {
    const tf = p.transferFee;
    if (tf?.present && tf.transferFeeBasePoints > 0) {
      m('transferFeeExtensionParams', 'None (omit the extension)', `${tf.transferFeeBasePoints} bps`, 'Standard mode must carry no transfer-fee extension. Either omit it, or launch in reward mode against the reward platform id.');
    } else if (tf?.present) {
      warnings.push('Standard mode with a present-but-zero transfer-fee option — StonkFun expects the extension omitted entirely.');
    }
  }

  // --- curve rule account --------------------------------------------------
  const last = a.trailing[a.trailing.length - 1];
  if (!last) {
    m('curve rule account (last account)', curveRule, 'missing',
      `Append ${curveRule} as the LAST account of the initialize instruction (read-only). ${pricing.curveRule.note ?? 'Required once the platform enforces its launch shape on-chain (error 6018 without it).'}`);
  } else if (last.pubkey !== curveRule) {
    const other = mode === 'reward' ? pricing.curveRule.standard : pricing.curveRule.reward;
    m('curve rule account (last account)', curveRule, last.pubkey,
      last.pubkey === other
        ? `That is the ${mode === 'reward' ? 'STANDARD' : 'REWARD'} curve rule. Append ${curveRule} for ${mode} mode.`
        : `The last account must be StonkFun's ${mode} curve rule ${curveRule} (derived ${pricing.curveRule.derivation ?? 'from the platform + global config'}).`);
  } else if (last.isWritable) {
    warnings.push('curve rule account is marked writable — pass it read-only.');
  }
  if (a.trailing.length > 2) warnings.push(`${a.trailing.length} trailing accounts — expected at most [platformAllowConfig?, curveRule].`);

  if (decoded.usesLookupTables) warnings.push('transaction uses address lookup tables — checked after resolving them.');
  if (decoded.instructionCount > 1) warnings.push(`${decoded.instructionCount} instructions in the transaction; only the LaunchLab initialize was checked.`);

  return {
    ...base,
    ok: mismatches.length === 0,
    decoded: {
      variant: ix.variant,
      instruction_index: ix.instructionIndex,
      account_count: ix.accounts.length,
      fee_payer: decoded.feePayer,
      base_mint: a.mintA.pubkey,
      name: p.name,
      symbol: p.symbol,
      params: p,
      trailing_accounts: a.trailing.map((t) => t.pubkey),
    },
  };
}

export class StonkPreflightAnalyzer {
  constructor(
    private readonly client: StonkFunClient,
    private readonly connection: Connection,
  ) {}

  async preflight(input: { unsignedTransaction: string; quoteMint: string; mode: StonkMode; launchParams?: unknown }): Promise<StonkPreflightResult> {
    const pricing = await this.client.getLaunchLabPricing(input.quoteMint);
    let decoded: DecodedLaunchTransaction;
    try {
      decoded = await decodeLaunchTransaction(input.unsignedTransaction, this.connection);
    } catch (err) {
      if (err instanceof LaunchLabDecodeError) {
        decoded = { version: 'legacy', feePayer: null, instructionCount: 0, usesLookupTables: false, programIds: [], initialize: null };
        const diff = diffLaunchAgainstPricing(decoded, pricing, input.mode, input.quoteMint, input.launchParams);
        diff.mismatches.unshift({ field: 'unsignedTransaction', expected: 'base64 unsigned legacy or v0 transaction', actual: err.message, fix: 'Serialize the unsigned transaction with requireAllSignatures=false and base64-encode it.' });
        return { ...diff, ok: false, next_steps: nextSteps(false) };
      }
      throw err;
    }
    const diff = diffLaunchAgainstPricing(decoded, pricing, input.mode, input.quoteMint, input.launchParams);
    return { ...diff, next_steps: nextSteps(diff.ok) };
  }
}

function nextSteps(ok: boolean): string[] {
  return ok
    ? ['Sign and broadcast. Once the pool lands it is adopted automatically — the token page, fee forwarding, and holder rewards work like an API launch.', 'After launch: stonk-reward-risk on the new mint confirms the on-chain fee config.']
    : ['Apply every fix, rebuild, and preflight again before signing. A mismatched pool is left alone by StonkFun — for a taxed mint the tax then goes to nobody.'];
}
