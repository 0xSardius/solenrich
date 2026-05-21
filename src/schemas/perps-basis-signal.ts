import { z } from 'zod';
import { FormatSchema } from './common';

export const PerpsBasisSignalInput = z.object({
  asset: z.enum(['SOL', 'BTC', 'ETH', 'BONK']),
  min_yield_apr_pct: z.number().min(0).max(100).default(5),
  format: FormatSchema,
});

export type PerpsBasisSignalInputType = z.infer<typeof PerpsBasisSignalInput>;
