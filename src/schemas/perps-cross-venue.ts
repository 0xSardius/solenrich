import { z } from 'zod';
import { FormatSchema } from './common';

export const PerpsCrossVenueInput = z.object({
  market: z.enum(['SOL', 'BTC', 'ETH', 'BONK']),
  include_reference: z.boolean().default(true),
  format: FormatSchema,
});

export type PerpsCrossVenueInputType = z.infer<typeof PerpsCrossVenueInput>;
