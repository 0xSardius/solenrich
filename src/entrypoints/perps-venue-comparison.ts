import { z } from 'zod';
import { PerpsVenueComparisonInput } from '../schemas/perps-venue-comparison';
import type { PerpsVenueComparator } from '../enrichers/perps-venue-comparison';
import { formatResponse } from '../formatters';
import { formatVenueComparisonBriefing } from '../formatters/llm-perps-venue-comparison';

type AddEntrypoint = (def: any) => void;

export function registerPerpsVenueComparisonEntrypoint(
  addEntrypoint: AddEntrypoint,
  comparator: PerpsVenueComparator,
) {
  addEntrypoint({
    key: 'perps-venue-comparison',
    description:
      'Where to trade this market at this size. Compares total entry cost (slippage + fee + first-hour borrow), OI cap headroom, and venue health across Jupiter Perps, Adrena, Hyperliquid, and dYdX v4. Returns rankings + recommendation with warnings.',
    input: PerpsVenueComparisonInput,
    handler: async (ctx: { input: z.infer<typeof PerpsVenueComparisonInput> }) => {
      const data = await comparator.compare(ctx.input.market, ctx.input.size_usd, ctx.input.side);
      return { output: formatResponse(data, ctx.input.format, formatVenueComparisonBriefing) };
    },
  });
}
