import { z } from 'zod';
import { FormatSchema, SolanaAddressSchema } from './common';

export const WhaleWatchInput = z.object({
  mint: SolanaAddressSchema,
  threshold_usd: z.number().min(100).default(10000),
  lookback_hours: z.number().min(1).max(168).default(24),
  format: FormatSchema,
});
