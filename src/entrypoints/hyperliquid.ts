import { z } from 'zod';
import { HyperliquidTraderInput } from '../schemas/perps';
import type { HyperliquidAnalyzer } from '../enrichers/hyperliquid-analyzer';
import { formatResponse } from '../formatters';
import { formatHyperliquidTraderBriefing } from '../formatters/llm-hyperliquid';

type AddEntrypoint = (def: any) => void;

export function registerHyperliquidEntrypoints(addEntrypoint: AddEntrypoint, analyzer: HyperliquidAnalyzer) {
  addEntrypoint({
    key: 'hyperliquid-trader-profile',
    description:
      "Hyperliquid trader profile for an EVM (0x) address. Reads the trader's live perp positions directly from Hyperliquid's public on-chain state: per-position coin, side, leverage, notional, entry, unrealized PnL, distance-to-liquidation, and risk flags (high_leverage, extreme_leverage, approaching_liquidation, losing). Plus account value, directional bias, profile (directional/market-neutral/diversified), weighted leverage, and realized+unrealized PnL over week/month/all-time. Hyperliquid is uniquely transparent — every position is public — making this the building block for smart-money tracking.",
    input: HyperliquidTraderInput,
    handler: async (ctx: { input: z.infer<typeof HyperliquidTraderInput> }) => {
      const data = await analyzer.analyzeTrader(ctx.input.address);
      return { output: formatResponse(data, ctx.input.format, formatHyperliquidTraderBriefing) };
    },
  });
}
