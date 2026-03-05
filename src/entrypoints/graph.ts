import { z } from 'zod';
import { GraphInput } from '../schemas/graph';
import type { GraphMapper } from '../enrichers/graph-mapper';
import { formatResponse } from '../formatters';
import { formatGraphBriefing } from '../formatters/llm-graph';

type AddEntrypoint = (def: any) => void;

export function registerGraphEntrypoint(
  addEntrypoint: AddEntrypoint,
  mapper: GraphMapper,
) {
  addEntrypoint({
    key: 'wallet-graph',
    description: 'Map wallet transaction connections and detect suspicious clusters',
    input: GraphInput,
    // price: PRICING['wallet-graph'],
    handler: async (ctx: { input: z.infer<typeof GraphInput> }) => {
      const data = await mapper.enrich(ctx.input.address, ctx.input.depth, ctx.input.min_interactions);
      return { output: formatResponse(data, ctx.input.format, formatGraphBriefing) };
    },
  });
}
