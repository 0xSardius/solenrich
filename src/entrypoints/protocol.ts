import { z } from 'zod';
import { ProtocolProfileInput } from '../schemas/protocol';
import type { ProtocolAnalyzer } from '../enrichers/protocol-analyzer';
import { formatResponse } from '../formatters/index';
import { formatProtocolBriefing } from '../formatters/llm-protocol';

export function registerProtocolEntrypoint(
  addEntrypoint: Function,
  analyzer: ProtocolAnalyzer,
) {
  addEntrypoint({
    key: 'protocol-profile',
    description: 'DeFi protocol analytics: TVL, yield pools, on-chain activity, health signals',
    input: ProtocolProfileInput,
    handler: async (ctx: { input: z.infer<typeof ProtocolProfileInput> }) => {
      const data = await analyzer.enrich(ctx.input.protocol, ctx.input.include_yields);
      return { output: formatResponse(data, ctx.input.format, formatProtocolBriefing) };
    },
  });
}
