import { z } from 'zod';
import { FeedLatestInput } from '../schemas/feed';
import type { FeedStore } from '../enrichers/feed-store';
import { formatResponse } from '../formatters';
import { formatFeedLatestBriefing } from '../formatters/llm-feed';

type AddEntrypoint = (def: any) => void;

export function registerFeedEntrypoint(addEntrypoint: AddEntrypoint, feedStore: FeedStore) {
  addEntrypoint({
    key: 'feed-latest',
    description:
      'Daily SolEnrich intelligence brief — pre-computed ranking of trending Solana tokens with composite signal scoring (liquidity, risk, holder concentration, whale flow). Cached 24h. Pass `since` (ISO 8601) to short-circuit on no-change. Pay-per-poll model — designed for agents that want recurring signal without orchestration cost.',
    input: FeedLatestInput,
    handler: async (ctx: { input: z.infer<typeof FeedLatestInput> }) => {
      const input = ctx.input;
      const data = await feedStore.getLatest(input.since);
      return { output: formatResponse(data, input.format, formatFeedLatestBriefing) };
    },
  });
}
