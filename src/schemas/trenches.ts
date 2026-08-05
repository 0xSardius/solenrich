import { z } from 'zod';
import { FormatSchema, SolanaAddressSchema } from './common';

// All inputs optional by design — no-required-input endpoints catalog
// automatically in the CDP x402 bazaar (no BAZAAR_INPUT_EXAMPLES entry needed).
export const SmartMoneyTrenchesInput = z.object({
  hours_back: z.number().int().min(1).max(48).default(12),
  max_token_age_hours: z.number().min(1).max(72).default(6),
  min_buyers: z.number().int().min(1).max(14).default(1),
  limit: z.number().int().min(1).max(25).default(10),
  format: FormatSchema,
});
export type SmartMoneyTrenchesInput = z.infer<typeof SmartMoneyTrenchesInput>;

export const TrenchesScanInput = z.object({
  max_token_age_hours: z.number().min(1).max(72).default(24),
  min_liquidity_usd: z.number().min(0).max(10_000_000).default(5_000),
  limit: z.number().int().min(1).max(20).default(10),
  format: FormatSchema,
});
export type TrenchesScanInput = z.infer<typeof TrenchesScanInput>;

// Required `mint` → needs a BAZAAR_INPUT_EXAMPLES entry in agent.ts or the
// endpoint stays invisible in the CDP bazaar (checklist item 9).
export const TrenchesCheckInput = z.object({
  mint: SolanaAddressSchema,
  format: FormatSchema,
});
export type TrenchesCheckInput = z.infer<typeof TrenchesCheckInput>;
