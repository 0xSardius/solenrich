import { z } from 'zod';
import { TokenTrendInput, WalletHistoryInput, parseLookback } from '../schemas/trend';
import { formatResponse } from '../formatters/index';
import { formatTokenTrendBriefing, formatWalletHistoryBriefing } from '../formatters/llm-trend';
import type { TrendAnalyzer } from '../enrichers/trend-analyzer';

export function registerTrendEntrypoints(
  addEntrypoint: Function,
  trendAnalyzer: TrendAnalyzer,
) {
  addEntrypoint({
    key: 'token-trend',
    description: 'Token trend analysis: price, liquidity, concentration changes over 7/14/30 days with direction indicators',
    input: TokenTrendInput,
    handler: async (ctx: { input: z.infer<typeof TokenTrendInput> }) => {
      const days = parseLookback(ctx.input.lookback);
      const data = await trendAnalyzer.analyzeTokenTrend(ctx.input.mint, days);
      return { output: formatResponse(data, ctx.input.format, formatTokenTrendBriefing) };
    },
  });

  addEntrypoint({
    key: 'wallet-history',
    description: 'Wallet history: portfolio value, balance, risk score changes over 7/14/30 days with position changes',
    input: WalletHistoryInput,
    handler: async (ctx: { input: z.infer<typeof WalletHistoryInput> }) => {
      const days = parseLookback(ctx.input.lookback);
      const data = await trendAnalyzer.analyzeWalletHistory(ctx.input.address, days);
      return { output: formatResponse(data, ctx.input.format, formatWalletHistoryBriefing) };
    },
  });
}
