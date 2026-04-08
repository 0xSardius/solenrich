import { z } from 'zod';
import { FormatSchema } from './common';

export const ProtocolProfileInput = z.object({
  protocol: z.string().min(1).max(64).describe('Protocol slug (e.g. "raydium", "orca") or Solana program ID'),
  include_yields: z.boolean().default(true),
  format: FormatSchema,
});
