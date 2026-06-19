import { z } from 'zod';
import { HyperliquidTraderInput, HyperliquidSmartMoneyInput } from '../schemas/perps';
import type { HyperliquidAnalyzer } from '../enrichers/hyperliquid-analyzer';
import type { HyperliquidSmartMoneyAnalyzer } from '../enrichers/hyperliquid-smart-money';
import { formatResponse } from '../formatters';
import { formatHyperliquidTraderBriefing } from '../formatters/llm-hyperliquid';
import { formatHyperliquidSmartMoneyBriefing } from '../formatters/llm-hyperliquid-smart-money';

type AddEntrypoint = (def: any) => void;

export function registerHyperliquidEntrypoints(
  addEntrypoint: AddEntrypoint,
  analyzer: HyperliquidAnalyzer,
  smartMoney: HyperliquidSmartMoneyAnalyzer,
) {
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

  addEntrypoint({
    key: 'hyperliquid-smart-money',
    description:
      "Where Hyperliquid smart money is positioned right now. Scans the HL leaderboard, excludes market-makers/HFT (turnover filter) and dust/mega-funds (account band), keeps only CONSISTENT directional traders (week+month PnL > 0, not a systematic book), then aggregates their live positions into a per-coin consensus signal (long/short trader counts, net notional, bias, conviction) plus a top-trader drill-down ranked by robust month PnL. Pass `market` (e.g. HYPE/BTC/ETH) to focus one coin. NOTE: a positioning signal, not a trade — consensus is often late/crowded and regime-dependent; use as confluence/risk context, not a standalone entry.",
    input: HyperliquidSmartMoneyInput,
    handler: async (ctx: { input: z.infer<typeof HyperliquidSmartMoneyInput> }) => {
      const data = await smartMoney.analyze({
        market: ctx.input.market,
        topTraders: ctx.input.top_traders,
      });
      return { output: formatResponse(data, ctx.input.format, formatHyperliquidSmartMoneyBriefing) };
    },
  });
}
