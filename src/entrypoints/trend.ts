import { z } from 'zod';
import {
  TokenTrendInput,
  WalletHistoryInput,
  PortfolioHistoryInput,
  PerpsMarketTrendInput,
  parseLookback,
} from '../schemas/trend';
import { formatResponse } from '../formatters/index';
import {
  formatTokenTrendBriefing,
  formatWalletHistoryBriefing,
  formatPortfolioHistoryBriefing,
  formatPerpsMarketTrendBriefing,
} from '../formatters/llm-trend';
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

  addEntrypoint({
    key: 'portfolio-history',
    description:
      'Full portfolio time-series for a wallet — daily snapshots of value, balance, holdings, risk, plus summary stats (peak, trough, max drawdown, average, change vs period start). Distinct from wallet-history which returns two-point deltas; this returns the series for charting.',
    input: PortfolioHistoryInput,
    handler: async (ctx: { input: z.infer<typeof PortfolioHistoryInput> }) => {
      const days = parseLookback(ctx.input.period);
      const data = await trendAnalyzer.analyzePortfolioHistory(ctx.input.address, days);
      return { output: formatResponse(data, ctx.input.format, formatPortfolioHistoryBriefing) };
    },
  });

  addEntrypoint({
    key: 'perps-market-trend',
    description:
      'Jupiter Perps market trend: per-symbol (SOL/BTC/ETH) deltas for mark price, total open interest, long/short skew, utilization, and borrow APR over 7/14/30 days. Direction indicators per metric and per market. Mirror of token-trend for perps markets — required for regime-detection strategies and any bot that adjusts behavior based on whether the market is growing, stressed, or rebalancing.',
    input: PerpsMarketTrendInput,
    handler: async (ctx: { input: z.infer<typeof PerpsMarketTrendInput> }) => {
      const days = parseLookback(ctx.input.lookback);
      const data = await trendAnalyzer.analyzePerpsMarketTrend(days);
      return { output: formatResponse(data, ctx.input.format, formatPerpsMarketTrendBriefing) };
    },
  });
}
