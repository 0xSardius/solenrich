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

export const HyperliquidSmartMoneyInput = z.object({
  // Optional single-coin focus (e.g. "HYPE", "BTC"). Omit for the full consensus.
  market: z.string().min(1).max(12).optional(),
  // How many top traders to include in the drill-down (default 10).
  top_traders: z.number().int().min(1).max(25).optional(),
  format: FormatSchema,
});
