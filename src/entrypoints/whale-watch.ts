import { z } from 'zod';
import { WhaleWatchInput } from '../schemas/whale-watch';
import type { WhaleWatcher } from '../enrichers/whale-watch';
import { formatResponse } from '../formatters';
import { formatWhaleWatchBriefing } from '../formatters/llm-whale-watch';

type AddEntrypoint = (def: any) => void;

export function registerWhaleWatchEntrypoint(
  addEntrypoint: AddEntrypoint,
  watcher: WhaleWatcher,
) {
  addEntrypoint({
    key: 'whale-watch',
    description: 'Identify large token holders and track accumulation/distribution patterns',
    input: WhaleWatchInput,
    // price: PRICING['whale-watch'],
    handler: async (ctx: { input: z.infer<typeof WhaleWatchInput> }) => {
      const data = await watcher.enrich(ctx.input.mint, ctx.input.threshold_usd, ctx.input.lookback_hours);
      return { output: formatResponse(data, ctx.input.format, formatWhaleWatchBriefing) };
    },
  });
}
