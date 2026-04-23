import { z } from 'zod';
import { FormatSchema, SolanaAddressSchema } from './common';

export const TrendingSignalsInput = z.object({
  min_liquidity_usd: z.number().min(0).default(10_000),
  max_risk_score: z.number().min(0).max(1).default(0.7),
  limit: z.number().int().min(1).max(20).default(10),
  include_whale_watch: z.boolean().default(true),
  format: FormatSchema,
});
export type TrendingSignalsInput = z.infer<typeof TrendingSignalsInput>;

export const SmartMoneyFlowInput = z.object({
  wallets: z.array(SolanaAddressSchema).max(30).optional(),
  lookback_days: z.number().int().min(1).max(90).default(14),
  min_win_rate: z.number().min(0).max(1).default(0.55),
  top_n_tokens: z.number().int().min(1).max(20).default(10),
  include_graph: z.boolean().default(true),
  format: FormatSchema,
});
export type SmartMoneyFlowInput = z.infer<typeof SmartMoneyFlowInput>;
