import { z } from 'zod';
import { FormatSchema, SolanaAddressSchema } from './common';

export const ConsensusSignalInput = z.object({
  type: z.enum(['token', 'wallet']).default('token'),
  address: SolanaAddressSchema.optional(),
  window: z.enum(['1h', '6h', '24h']).default('1h'),
  limit: z.number().int().min(1).max(50).default(10),
  format: FormatSchema,
});
export type ConsensusSignalInput = z.infer<typeof ConsensusSignalInput>;
