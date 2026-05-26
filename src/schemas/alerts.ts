import { z } from 'zod';
import { FormatSchema, SolanaAddressSchema } from './common';

const AlertCriteriaSchema = z
  .object({
    min_price_change_pct: z.number().min(0).max(1000).optional(),
    min_risk_score_delta: z.number().min(0).max(1).optional(),
    min_whale_volume_usd: z.number().min(0).optional(),
    min_portfolio_change_pct: z.number().min(0).max(10000).optional(),
    min_concentration_shift_pct: z.number().min(0).max(100).optional(),
    perp_max_leverage: z.number().min(1).max(100).optional(),
    perp_min_pnl_swing_pts: z.number().min(0).max(1000).optional(),
    perp_liquidation_buffer_pct: z.number().min(0).max(100).optional(),
  })
  .default({});

export const CheckAlertsInput = z
  .object({
    tokens: z.array(SolanaAddressSchema).max(10).default([]),
    wallets: z.array(SolanaAddressSchema).max(10).default([]),
    since: z.string().datetime(),
    criteria: AlertCriteriaSchema,
    format: FormatSchema,
  })
  .refine((v) => v.tokens.length + v.wallets.length > 0, {
    message: 'At least one token or wallet must be in the watchlist',
  });

export type CheckAlertsInput = z.infer<typeof CheckAlertsInput>;
