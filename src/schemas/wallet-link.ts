import { z } from 'zod';
import { FormatSchema, SolanaAddressSchema } from './common';

export const WalletLinkInput = z.object({
  wallet_a: SolanaAddressSchema,
  wallet_b: SolanaAddressSchema,
  context: z.enum(['payout_rotation', 'general']).default('general'),
  format: FormatSchema,
});
