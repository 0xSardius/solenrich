import { z } from 'zod';
import { NewTokensInput } from '../schemas/discovery';
import { formatResponse } from '../formatters/index';
import { formatDiscoveryBriefing } from '../formatters/llm-discovery';
import type { TokenDiscovery } from '../enrichers/token-discovery';

export function registerDiscoveryEntrypoint(
  addEntrypoint: Function,
  tokenDiscovery: TokenDiscovery,
) {
  addEntrypoint({
    key: 'new-tokens',
    description: 'Discover recently launched tokens on Solana with risk scoring and filtering. Returns safest first.',
    input: NewTokensInput,
    handler: async (ctx: { input: z.infer<typeof NewTokensInput> }) => {
      const data = await tokenDiscovery.discover(
        ctx.input.min_liquidity_usd,
        ctx.input.max_risk_score,
        ctx.input.limit,
      );
      return { output: formatResponse(data, ctx.input.format, formatDiscoveryBriefing) };
    },
  });
}
