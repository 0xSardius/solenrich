import { z } from 'zod';
import { FormatSchema } from './common';

export const GachaEvScanInput = z.object({
  /** Restrict to one machine code (e.g. "pokemon_50"). Omit to scan all. */
  machine: z.string().min(1).max(64).optional(),
  /** Franchise filter. Machine codes are prefixed pokemon_/onepiece_. */
  franchise: z.enum(['pokemon', 'onepiece', 'all']).default('all'),
  /**
   * Which exit path to rank/verdict against:
   *  - buyback: the guaranteed cash floor (instant-buyback %, ≤72h)
   *  - marketplace: sell each card at insured value minus fees (fill-risk)
   *  - both: report both, rank by marketplace edge
   */
  exit_strategy: z.enum(['buyback', 'marketplace', 'both']).default('both'),
  /** Only surface machines whose net edge (per exit_strategy) ≥ this %. */
  min_edge_pct: z.number().min(-100).max(100).optional(),
  format: FormatSchema,
});

export type GachaEvScanInputType = z.infer<typeof GachaEvScanInput>;
