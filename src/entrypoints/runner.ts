import { z } from 'zod';
import { RunnerScanInput } from '../schemas/runner';
import type { RunnerDetector } from '../enrichers/runner-detector';
import { formatResponse } from '../formatters';
import { formatRunnerBriefing } from '../formatters/llm-runner';

type AddEntrypoint = (def: any) => void;

export function registerRunnerEntrypoint(
  addEntrypoint: AddEntrypoint,
  runnerDetector: RunnerDetector,
) {
  addEntrypoint({
    key: 'runner-scan',
    description:
      'Detect Solana memecoins whose on-chain buying is accelerating right now — the signature of a run in progress. Measures buy-rate acceleration across 5m/1h/6h windows, buy pressure, volume and price velocity, holder growth, and liquidity trend, then classifies each token IGNITING / RUNNING / PARABOLIC_LATE / FADING with a 0-1 velocity score and reasoning. Flags already-ran tokens as entry risk and liquidity pulls as rugs rather than dressing them up as runners.',
    input: RunnerScanInput,
    handler: async (ctx: { input: z.infer<typeof RunnerScanInput> }) => {
      const input = ctx.input;
      const data = await runnerDetector.scan(
        input.max_token_age_hours,
        input.min_liquidity_usd,
        input.min_volume_h1_usd,
        input.limit,
      );
      return { output: formatResponse(data, input.format, formatRunnerBriefing) };
    },
  });
}
