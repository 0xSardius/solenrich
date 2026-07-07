import { z } from 'zod';
import { FormatSchema } from './common';

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
