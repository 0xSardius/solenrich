import { z } from 'zod';
import { FormatSchema } from './common';

// All inputs optional by design — no-required-input endpoints catalog
// automatically in the CDP x402 bazaar (no BAZAAR_INPUT_EXAMPLES entry needed).
export const RunnerScanInput = z.object({
  max_token_age_hours: z.number().min(0.1).max(168).default(24),
  min_liquidity_usd: z.number().min(0).max(10_000_000).default(10_000),
  min_volume_h1_usd: z.number().min(0).max(10_000_000).default(5_000),
  limit: z.number().int().min(1).max(25).default(15),
  format: FormatSchema,
});
export type RunnerScanInput = z.infer<typeof RunnerScanInput>;
