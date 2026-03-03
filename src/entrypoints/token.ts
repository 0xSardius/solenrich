import { z } from 'zod';
import { PRICING } from '../config';
import { EnrichTokenInput, TokenEnrichmentSchema } from '../schemas/token';
import type { TokenAnalyzer } from '../enrichers/token-analyzer';
import { formatResponse } from '../formatters';
import { formatTokenBriefing } from '../formatters/llm-token';

type AddEntrypoint = (def: any) => void;

export function registerTokenEntrypoints(
  addEntrypoint: AddEntrypoint,
  analyzer: TokenAnalyzer,
) {
  // NOTE: price commented out until @x402/solana ships
  // Prices defined in PRICING config, ready to enable

  addEntrypoint({
    key: 'enrich-token-light',
    description: 'Token analysis with price, market data, liquidity, and risk flags',
    input: EnrichTokenInput,
    // output schema omitted — response shape varies by format (json/llm/both)
    // price: PRICING['enrich-token-light'],
    handler: async (ctx: { input: z.infer<typeof EnrichTokenInput> }) => {
      const data = await analyzer.enrich(ctx.input.mint, false);
      return { output: formatResponse(data, ctx.input.format, formatTokenBriefing) };
    },
  });

  addEntrypoint({
    key: 'enrich-token-full',
    description: 'Full token analysis with price, market data, liquidity, risk flags, and top holders',
    input: EnrichTokenInput,
    // output schema omitted — response shape varies by format (json/llm/both)
    // price: PRICING['enrich-token-full'],
    handler: async (ctx: { input: z.infer<typeof EnrichTokenInput> }) => {
      const data = await analyzer.enrich(ctx.input.mint, true);
      return { output: formatResponse(data, ctx.input.format, formatTokenBriefing) };
    },
  });
}
