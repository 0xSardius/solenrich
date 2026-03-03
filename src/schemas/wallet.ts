import { z } from 'zod';
import { FormatSchema, DepthSchema, SolanaAddressSchema } from './common';

export const EnrichWalletInput = z.object({
  address: SolanaAddressSchema,
  depth: DepthSchema,
  format: FormatSchema,
});

export const WalletEnrichmentSchema = z.object({
  address: z.string(),
  sol_balance: z.number(),
  portfolio_value_usd: z.number(),
  token_count: z.number(),
  top_holdings: z.array(z.object({
    mint: z.string(),
    symbol: z.string(),
    balance: z.number(),
    usd_value: z.number(),
  })),
  nft_count: z.number(),
  defi_positions: z.array(z.object({
    protocol: z.string(),
    type: z.string(),
    value_usd: z.number(),
  })),
  tx_count_30d: z.number(),
  first_tx_date: z.string().nullable(),
  labels: z.array(z.string()),
  risk_score: z.number(),
  risk_factors: z.array(z.string()),
  connected_wallets: z.array(z.string()),
  last_updated: z.string(),
});
