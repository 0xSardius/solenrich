import { z } from 'zod';
import { FormatSchema, SolanaAddressSchema } from './common';

export const EnrichTokenInput = z.object({
  mint: SolanaAddressSchema,
  include_holders: z.boolean().default(false),
  format: FormatSchema,
});

export const TokenEnrichmentSchema = z.object({
  mint: z.string(),
  symbol: z.string(),
  name: z.string(),
  decimals: z.number(),
  supply: z.number(),
  holder_count: z.number(),
  price_usd: z.number(),
  market_cap: z.number(),
  volume_24h: z.number(),
  price_change_24h: z.number(),
  top_holders: z.array(z.object({
    address: z.string(),
    balance: z.number(),
    pct_supply: z.number(),
  })).optional(),
  concentration: z.object({
    top1_pct: z.number(),
    top5_pct: z.number(),
    top10_pct: z.number(),
    herfindahl_index: z.number(),
  }).optional(),
  liquidity: z.number(),
  risk_flags: z.array(z.string()),
  verified: z.boolean(),
  mint_authority: z.string().nullable(),
  freeze_authority: z.string().nullable(),
  last_updated: z.string(),
});
