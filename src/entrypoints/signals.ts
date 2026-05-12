import { z } from 'zod';
import { ConsensusSignalInput } from '../schemas/signals';
import type { SignalTracker } from '../enrichers/signal-tracker';
import { formatResponse } from '../formatters';
import { formatConsensusSignalBriefing } from '../formatters/llm-signals';

type AddEntrypoint = (def: any) => void;

export function registerSignalEntrypoint(addEntrypoint: AddEntrypoint, tracker: SignalTracker) {
  addEntrypoint({
    key: 'consensus-signal',
    description:
      'Agent attention signal — what tokens or wallets are being queried by other agents right now. Proprietary data: derived from SolEnrich\'s own query stream, not market volume. Two modes: pass `address` to get that entity\'s rank/percentile/trend; omit it to get the top-N most-queried entities. Windows: 1h, 6h, 24h.',
    input: ConsensusSignalInput,
    handler: async (ctx: { input: z.infer<typeof ConsensusSignalInput> }) => {
      const { type, address, window, limit, format } = ctx.input;
      const data = await tracker.getSignal(type, address, window, limit);
      return { output: formatResponse(data, format, formatConsensusSignalBriefing) };
    },
  });
}
