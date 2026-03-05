import { z } from 'zod';
import { FormatSchema, SolanaAddressSchema } from './common';

export const GraphInput = z.object({
  address: SolanaAddressSchema,
  depth: z.number().min(1).max(2).default(1),
  min_interactions: z.number().min(1).default(1),
  format: FormatSchema,
});
