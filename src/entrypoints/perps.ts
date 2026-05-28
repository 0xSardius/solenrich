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
      'Multi-venue perps trader profile — fetches open positions from BOTH Jupiter Perps and Adrena for the wallet. Returns per-position size/leverage/entry/unrealized PnL/risk flags, per-venue breakdown with venue totals, and combined totals across venues. Output includes a `venue` tag on every position and a `by_venue` breakdown alongside combined `totals`. Adrena PnL requires per-collateral mark prices (jitoSOL/WBTC/BONK via Jupiter price API) and is null when unavailable.',
    input: PerpsTraderInput,
    handler: async (ctx: { input: z.infer<typeof PerpsTraderInput> }) => {
      const data = await analyzer.analyzeTrader(ctx.input.address);
      return { output: formatResponse(data, ctx.input.format, formatPerpsTraderBriefing) };
    },
  });
}
