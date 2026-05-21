import { z } from 'zod';
import { PerpsBasisSignalInput } from '../schemas/perps-basis-signal';
import type { PerpsBasisAnalyzer } from '../enrichers/perps-basis-signal';
import { formatResponse } from '../formatters';
import { formatBasisSignalBriefing } from '../formatters/llm-perps-basis-signal';

type AddEntrypoint = (def: any) => void;

export function registerPerpsBasisSignalEntrypoint(
  addEntrypoint: AddEntrypoint,
  analyzer: PerpsBasisAnalyzer,
) {
  addEntrypoint({
    key: 'perps-basis-signal',
    description:
      'Net-yield-after-borrow basis trade scanner. Computes perp mark vs spot price across venues and surfaces actually-earnable yield — funding APR on reference venues (Hyperliquid, dYdX v4), correctly flagged as not-viable on Solana pool perps (Jupiter, Adrena) which charge borrow on both sides. Returns per-venue trade, filtered opportunities, and best trade.',
    input: PerpsBasisSignalInput,
    handler: async (ctx: { input: z.infer<typeof PerpsBasisSignalInput> }) => {
      const data = await analyzer.analyze(ctx.input.asset, ctx.input.min_yield_apr_pct);
      return { output: formatResponse(data, ctx.input.format, formatBasisSignalBriefing) };
    },
  });
}
