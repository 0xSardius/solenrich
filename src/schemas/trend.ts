import { z } from 'zod';
import { SolanaAddressSchema, FormatSchema } from './common';

const LookbackSchema = z.enum(['7d', '14d', '30d']).default('7d');

export const TokenTrendInput = z.object({
  mint: SolanaAddressSchema,
  lookback: LookbackSchema,
  format: FormatSchema,
});

export const WalletHistoryInput = z.object({
  address: SolanaAddressSchema,
  lookback: LookbackSchema,
  format: FormatSchema,
});

export function parseLookback(lookback: string): number {
  return parseInt(lookback.replace('d', ''), 10);
}
