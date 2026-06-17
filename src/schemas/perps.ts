import { z } from 'zod';
import { FormatSchema, SolanaAddressSchema, EvmAddressSchema } from './common';

export const PerpsMarketInput = z.object({
  format: FormatSchema,
});

export const PerpsTraderInput = z.object({
  address: SolanaAddressSchema,
  format: FormatSchema,
});

export const HyperliquidTraderInput = z.object({
  address: EvmAddressSchema,
  format: FormatSchema,
});
