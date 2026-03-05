import { z } from 'zod';
import { CopyTradeInput } from '../schemas/copy-trade';
import type { CopyTradeAnalyzer } from '../enrichers/copy-trade-analyzer';
import { formatResponse } from '../formatters';
import { formatCopyTradeBriefing } from '../formatters/llm-copy-trade';

type AddEntrypoint = (def: any) => void;

export function registerCopyTradeEntrypoint(
  addEntrypoint: AddEntrypoint,
  analyzer: CopyTradeAnalyzer,
) {
  addEntrypoint({
    key: 'copy-trade-signals',
    description: 'Analyze wallet trading performance and copyability',
    input: CopyTradeInput,
    // price: PRICING['copy-trade-signals'],
    handler: async (ctx: { input: z.infer<typeof CopyTradeInput> }) => {
      const data = await analyzer.enrich(ctx.input.address, ctx.input.lookback_days);
      return { output: formatResponse(data, ctx.input.format, formatCopyTradeBriefing) };
    },
  });
}
