import { z } from 'zod';
import { FormatSchema, DepthSchema, SolanaAddressSchema } from './common';

export const BatchEnrichInput = z.object({
  addresses: z.array(SolanaAddressSchema).min(1).max(25),
  type: z.enum(['wallet', 'token']),
  depth: DepthSchema,
  format: FormatSchema,
});
