import { z } from 'zod';
import { SolanaAddressSchema, FormatSchema } from './common';

export const CompareTokensInput = z.object({
  mints: z.array(SolanaAddressSchema).min(2).max(3).describe('2-3 token mint addresses to compare'),
  format: FormatSchema,
});

export const CompareWalletsInput = z.object({
  addresses: z.array(SolanaAddressSchema).min(2).max(3).describe('2-3 wallet addresses to compare'),
  depth: z.enum(['light', 'full']).default('light'),
  format: FormatSchema,
});
