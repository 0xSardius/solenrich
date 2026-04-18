import { z } from 'zod';
import { FormatSchema, SolanaAddressSchema } from './common';

export const PerpsMarketInput = z.object({
  format: FormatSchema,
});

export const PerpsTraderInput = z.object({
  address: SolanaAddressSchema,
  format: FormatSchema,
});
