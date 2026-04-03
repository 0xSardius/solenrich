import { z } from 'zod';
import { FormatSchema } from './common';

export const NewTokensInput = z.object({
  min_liquidity_usd: z.number().default(1000).describe('Minimum liquidity in USD to include'),
  max_risk_score: z.number().min(0).max(1).default(0.8).describe('Maximum risk score (0-1) to include'),
  limit: z.number().min(1).max(20).default(10).describe('Number of tokens to return'),
  format: FormatSchema,
});
