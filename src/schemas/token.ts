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
  holder_count: z.number().nullable().describe('Null when no source reported a count'),
  holder_count_source: z.enum(['birdeye', 'jupiter']).nullable(),
  price_usd: z.number().nullable(),
  price_source: z.enum(['dexscreener', 'jupiter', 'birdeye']).nullable(),
  market_cap: z.number().nullable(),
  volume_24h: z.number().nullable(),
  price_change_24h: z.number(),
  bonding_curve: z.boolean().describe('True while the token trades on a pump.fun bonding curve'),
  volatility: z.object({
    window: z.enum(['7d', '24h']),
    source: z.enum(['birdeye_daily', 'dexscreener_intraday']),
    daily_std_7d: z.number().nullable(),
    high_7d: z.number().nullable(),
    low_7d: z.number().nullable(),
    range_pct_7d: z.number().nullable(),
    intraday_std_pct: z.number().optional(),
    high_24h: z.number().optional(),
    low_24h: z.number().optional(),
    range_pct_24h: z.number().optional(),
    classification: z.enum(['LOW', 'MODERATE', 'HIGH', 'EXTREME']),
  }).optional(),
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
  slippage_estimates: z.array(z.object({
    size_usd: z.number(),
    price_impact_pct: z.number(),
    output_amount: z.number(),
    input_amount: z.number(),
  })).optional(),
  slippage_age_s: z.number().optional().describe('Age of the price-impact quotes in seconds (≤120 for tokens < 24h old, else ≤300)'),
  transfer_tax: z.object({
    program: z.enum(['token-2022', 'spl-token', 'other']).nullable(),
    bps: z.number(),
    per_transfer_pct: z.number(),
    round_trip_pct: z.number(),
    fee_mutable_by: z.string().nullable(),
    withdraw_authority: z.string().nullable(),
  }).nullable().optional(),
  liquidity: z.number().nullable().describe('USD; null when no source reported it'),
  liquidity_source: z.enum(['dexscreener', 'jupiter', 'birdeye']).nullable(),
  risk_flags: z.array(z.string()),
  verified: z.boolean().nullable().describe('Null when Jupiter did not answer'),
  mint_authority: z.string().nullable(),
  freeze_authority: z.string().nullable(),
  data_quality: z.object({
    degraded: z.boolean(),
    unavailable: z.array(z.string()),
  }),
  last_updated: z.string(),
});
