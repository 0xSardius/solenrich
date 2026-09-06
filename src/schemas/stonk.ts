import { z } from 'zod';
import { FormatSchema, SolanaAddressSchema } from './common';

// StonkFun product line — quote-paired and reward-mode (transfer-tax) coins.

export const StonkCategorySchema = z.enum(['xstock', 'prestock', 'currency', 'leverage', 'solana', 'collectible', 'custom']);

export const StonkPairsInput = z.object({
  /** Normalized category filter. */
  category: StonkCategorySchema.optional(),
  /** Only pairs an agent can launch against right now (launchable + launchLabReady + allowed category). */
  launchable_only: z.boolean().default(false),
  format: FormatSchema,
});
export type StonkPairsInput = z.infer<typeof StonkPairsInput>;

// Required `mint` → BAZAAR_INPUT_EXAMPLES entry in agent.ts (checklist item 9).
export const StonkRewardRiskInput = z.object({
  mint: SolanaAddressSchema,
  format: FormatSchema,
});
export type StonkRewardRiskInput = z.infer<typeof StonkRewardRiskInput>;

export const StonkYieldInput = z.object({
  mint: SolanaAddressSchema,
  format: FormatSchema,
});
export type StonkYieldInput = z.infer<typeof StonkYieldInput>;

export const StonkScreenerInput = z.object({
  quote_mint: SolanaAddressSchema.optional(),
  category: StonkCategorySchema.optional(),
  min_holders: z.number().int().min(0).optional(),
  min_age_days: z.number().min(0).optional(),
  sort: z.enum(['yield7d', 'yield30d', 'rewardsUsd', 'volume24h']).default('rewardsUsd'),
  limit: z.number().int().min(1).max(100).default(25),
  format: FormatSchema,
});
export type StonkScreenerInput = z.infer<typeof StonkScreenerInput>;

export const StonkPreflightInput = z.object({
  /** Base64 unsigned transaction (legacy or v0) carrying the LaunchLab initialize. */
  unsigned_transaction: z.string().min(64).max(6000),
  quote_mint: SolanaAddressSchema,
  mode: z.enum(['standard', 'reward']),
  /** Optional: the params object you passed to the SDK — lets preflight catch misspelled field names directly. */
  launch_params: z.record(z.string(), z.unknown()).optional(),
  format: FormatSchema,
});
export type StonkPreflightInput = z.infer<typeof StonkPreflightInput>;
