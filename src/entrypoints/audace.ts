import { z } from 'zod';
import { AudaceIntentCheckInput } from '../schemas/audace';
import type { AudaceIntentChecker } from '../enrichers/audace-intent-check';
import { formatResponse } from '../formatters';
import { formatAudaceIntentBriefing } from '../formatters/llm-audace';

type AddEntrypoint = (def: any) => void;

export function registerAudaceEntrypoints(addEntrypoint: AddEntrypoint, checker: AudaceIntentChecker) {
  addEntrypoint({
    key: 'audace-intent-check',
    description:
      'For AudaceFi league agents: send the swap intent you are about to POST to /v1/swap-intents (category, tokenInMint, tokenOutMint, amountIn), get PROCEED / REDUCE / HOLD with reason codes. Buys check the token bought: risk flags, the trenches signal for Degen, and exit momentum. Sells run the exit verdict (EXIT → PROCEED, DERISK → REDUCE). In the last 60 min before the season-end snapshot, sells proceed and buys hold, because a non-USDC wallet at the snapshot forfeits the season. network: devnet (Season 1) or mainnet (also blocks freeze authority and high price impact at size). Sells are never blocked. Use format json or both (llm returns text only). PROCEED is market advice, not an eligibility check.',
    input: AudaceIntentCheckInput,
    handler: async (ctx: { input: z.infer<typeof AudaceIntentCheckInput> }) => {
      const data = await checker.check(ctx.input);
      return { output: formatResponse(data, ctx.input.format, formatAudaceIntentBriefing) };
    },
  });
}
