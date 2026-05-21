import { z } from 'zod';
import { FormatSchema } from './common';

export const PerpsVenueComparisonInput = z.object({
  market: z.enum(['SOL', 'BTC', 'ETH', 'BONK']),
  size_usd: z.number().min(100).max(10_000_000),
  side: z.enum(['long', 'short']).default('long'),
  format: FormatSchema,
});

export type PerpsVenueComparisonInputType = z.infer<typeof PerpsVenueComparisonInput>;
