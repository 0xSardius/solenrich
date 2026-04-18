import { z } from 'zod';
import { PerpsMarketInput, PerpsTraderInput } from '../schemas/perps';
import type { PerpsAnalyzer } from '../enrichers/perps-analyzer';
import { formatResponse } from '../formatters';
import { formatPerpsMarketBriefing, formatPerpsTraderBriefing } from '../formatters/llm-perps';

type AddEntrypoint = (def: any) => void;

export function registerPerpsEntrypoints(addEntrypoint: AddEntrypoint, analyzer: PerpsAnalyzer) {
  addEntrypoint({
    key: 'perps-market-structure',
    description:
      'Jupiter Perps market structure — per-market OI, utilization, borrow APR, skew, OI caps, and health flags for SOL/BTC/ETH',
    input: PerpsMarketInput,
    handler: async (ctx: { input: z.infer<typeof PerpsMarketInput> }) => {
      const data = await analyzer.analyzeMarket();
      return { output: formatResponse(data, ctx.input.format, formatPerpsMarketBriefing) };
    },
  });

  addEntrypoint({
    key: 'perps-trader-profile',
    description:
      'Jupiter Perps trader profile — open positions for a wallet with size, leverage, entry, unrealized PnL, and risk flags',
    input: PerpsTraderInput,
    handler: async (ctx: { input: z.infer<typeof PerpsTraderInput> }) => {
      const data = await analyzer.analyzeTrader(ctx.input.address);
      return { output: formatResponse(data, ctx.input.format, formatPerpsTraderBriefing) };
    },
  });
}
