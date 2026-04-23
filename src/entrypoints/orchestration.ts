import { z } from 'zod';
import { TrendingSignalsInput, SmartMoneyFlowInput } from '../schemas/orchestration';
import type { TrendingSignalsAnalyzer } from '../enrichers/trending-signals';
import type { SmartMoneyAnalyzer } from '../enrichers/smart-money-flow';
import { formatResponse } from '../formatters';
import { formatTrendingBriefing } from '../formatters/llm-trending';
import { formatSmartMoneyBriefing } from '../formatters/llm-smart-money';

type AddEntrypoint = (def: any) => void;

export function registerOrchestrationEntrypoints(
  addEntrypoint: AddEntrypoint,
  trending: TrendingSignalsAnalyzer,
  smartMoney: SmartMoneyAnalyzer,
) {
  addEntrypoint({
    key: 'trending-signals',
    description:
      'Orchestrated ranking of trending Solana tokens. Scans DexScreener trending, enriches with token analysis + optional whale-watch flow, and returns a composite-signal ranked list with reasoning. "What\'s worth paying attention to right now?"',
    input: TrendingSignalsInput,
    handler: async (ctx: { input: z.infer<typeof TrendingSignalsInput> }) => {
      const input = ctx.input;
      const data = await trending.enrich(
        input.min_liquidity_usd,
        input.max_risk_score,
        input.limit,
        input.include_whale_watch,
      );
      return { output: formatResponse(data, input.format, formatTrendingBriefing) };
    },
  });

  addEntrypoint({
    key: 'smart-money-flow',
    description:
      'Orchestrated smart-money intelligence. Scores a seed wallet list via copy-trade metrics, filters to qualifying winners (win rate + trade count), then surfaces tokens they\'re accumulating and wallet clusters. Pass your own `wallets` array or use our curated default list.',
    input: SmartMoneyFlowInput,
    handler: async (ctx: { input: z.infer<typeof SmartMoneyFlowInput> }) => {
      const input = ctx.input;
      const data = await smartMoney.enrich(
        input.wallets,
        input.lookback_days,
        input.min_win_rate,
        input.top_n_tokens,
        input.include_graph,
      );
      return { output: formatResponse(data, input.format, formatSmartMoneyBriefing) };
    },
  });
}
