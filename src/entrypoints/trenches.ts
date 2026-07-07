import { z } from 'zod';
import { SmartMoneyTrenchesInput } from '../schemas/trenches';
import type { TrenchesSmartMoneyAnalyzer } from '../enrichers/trenches-smart-money';
import { formatResponse } from '../formatters';
import { formatTrenchesBriefing } from '../formatters/llm-trenches';

type AddEntrypoint = (def: any) => void;

export function registerTrenchesEntrypoints(
  addEntrypoint: AddEntrypoint,
  trenchesSmartMoney: TrenchesSmartMoneyAnalyzer,
) {
  addEntrypoint({
    key: 'smart-money-trenches',
    description:
      'Which proven-winner wallets are aping fresh (<6h) memecoin launches right now, and what are they buying? Scans a vetted seed set of realized-PnL winners (bot-filtered, re-checked live each scan), overlays their recent buys against token launch times, and ranks fresh tokens by distinct smart buyers + recency. The trenches attention signal.',
    input: SmartMoneyTrenchesInput,
    handler: async (ctx: { input: z.infer<typeof SmartMoneyTrenchesInput> }) => {
      const input = ctx.input;
      const data = await trenchesSmartMoney.enrich(
        input.hours_back,
        input.max_token_age_hours,
        input.min_buyers,
        input.limit,
      );
      return { output: formatResponse(data, input.format, formatTrenchesBriefing) };
    },
  });
}
