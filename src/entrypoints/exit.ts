import { z } from 'zod';
import { ExitSignalInput } from '../schemas/exit';
import type { ExitSignalAnalyzer } from '../enrichers/exit-analyzer';
import { formatResponse } from '../formatters';
import { formatExitSignalBriefing } from '../formatters/llm-exit-signal';

type AddEntrypoint = (def: any) => void;

export function registerExitSignalEntrypoint(
  addEntrypoint: AddEntrypoint,
  analyzer: ExitSignalAnalyzer,
) {
  addEntrypoint({
    key: 'exit-signal',
    description:
      'The sell-side verdict for a token you hold: pass a mint, get EXIT / DERISK / HOLD with an exit score and reasoning. Reads sell pressure, buy-rate deceleration, volume fade, distribution-into-strength divergence, top-holder flow (who is distributing vs accumulating), liquidity trend, and holder churn. Rug triggers (LP pull, active dump) override everything. Works on tokens of any age. Optional entry_price_usd adds unrealized-PnL context.',
    input: ExitSignalInput,
    handler: async (ctx: { input: z.infer<typeof ExitSignalInput> }) => {
      const input = ctx.input;
      const data = await analyzer.analyze(input.mint, input.entry_price_usd);
      return { output: formatResponse(data, input.format, formatExitSignalBriefing) };
    },
  });
}
