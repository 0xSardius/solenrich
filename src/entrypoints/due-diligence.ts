import { z } from 'zod';
import { DueDiligenceInput } from '../schemas/due-diligence';
import type { DueDiligenceAnalyzer } from '../enrichers/due-diligence';
import { formatResponse } from '../formatters';
import { formatDueDiligenceBriefing } from '../formatters/llm-due-diligence';

type AddEntrypoint = (def: any) => void;

export function registerDueDiligenceEntrypoint(
  addEntrypoint: AddEntrypoint,
  analyzer: DueDiligenceAnalyzer,
) {
  addEntrypoint({
    key: 'due-diligence',
    description: 'Comprehensive token research briefing with security, whales, and holder analysis',
    input: DueDiligenceInput,
    // price: PRICING['due-diligence'],
    handler: async (ctx: { input: z.infer<typeof DueDiligenceInput> }) => {
      const data = await analyzer.enrich(ctx.input.mint);
      return { output: formatResponse(data, ctx.input.format, formatDueDiligenceBriefing) };
    },
  });
}
