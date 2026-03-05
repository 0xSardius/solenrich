import { z } from 'zod';
import { FormatSchema, SolanaAddressSchema } from './common';

export const DueDiligenceInput = z.object({
  mint: SolanaAddressSchema,
  format: FormatSchema,
});
