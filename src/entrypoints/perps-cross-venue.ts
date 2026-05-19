import { z } from 'zod';
import { PerpsCrossVenueInput } from '../schemas/perps-cross-venue';
import type { PerpsCrossVenueAnalyzer } from '../enrichers/perps-cross-venue';
import { formatResponse } from '../formatters';
import { formatCrossVenueFundingBriefing } from '../formatters/llm-perps-cross-venue';

type AddEntrypoint = (def: any) => void;

export function registerPerpsCrossVenueEntrypoint(
  addEntrypoint: AddEntrypoint,
  analyzer: PerpsCrossVenueAnalyzer,
) {
  addEntrypoint({
    key: 'perps-cross-venue-funding',
    description:
      'Cross-venue perps funding rate aggregator. Compares borrow/funding APR + open interest across Solana on-chain venues (Jupiter Perps, Adrena) with cross-chain reference (Hyperliquid, dYdX v4). Returns best entry per side, basis vs Hyperliquid, and arbitrage opportunities.',
    input: PerpsCrossVenueInput,
    handler: async (ctx: { input: z.infer<typeof PerpsCrossVenueInput> }) => {
      const data = await analyzer.analyze(ctx.input.market, ctx.input.include_reference);
      return { output: formatResponse(data, ctx.input.format, formatCrossVenueFundingBriefing) };
    },
  });
}
