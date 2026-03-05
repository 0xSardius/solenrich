import { z } from 'zod';
import { FormatSchema, SolanaAddressSchema } from './common';

export const CopyTradeInput = z.object({
  address: SolanaAddressSchema,
  lookback_days: z.number().min(1).max(90).default(30),
  format: FormatSchema,
});
