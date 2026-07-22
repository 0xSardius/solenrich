import { z } from 'zod';
import { GachaEvScanInput } from '../schemas/gacha';
import type { GachaAnalyzer } from '../enrichers/gacha-analyzer';
import { formatResponse } from '../formatters';
import { formatGachaScanBriefing } from '../formatters/llm-gacha';

type AddEntrypoint = (def: any) => void;

export function registerGachaEntrypoint(addEntrypoint: AddEntrypoint, analyzer: GachaAnalyzer) {
  addEntrypoint({
    key: 'gacha-ev-scan',
    description:
      'Jupiter Gacha (Collector Crypt) pack EV scan — for each tokenized-card pack machine, computes net-of-exit-mechanics expected value: gross insured EV vs the guaranteed instant-buyback floor (85–93% of insured, ≤72h) vs a marketplace sale (insured value minus 2% fee, fill-risk). Returns a POSITIVE_EV / HOUSE_EDGE / NEGATIVE_EV verdict per machine plus rare+epic stock share, ranked by the chosen exit path. The number the platform hides behind its gross EV headline.',
    input: GachaEvScanInput,
    handler: async (ctx: { input: z.infer<typeof GachaEvScanInput> }) => {
      const data = await analyzer.scan(ctx.input);
      return { output: formatResponse(data, ctx.input.format, formatGachaScanBriefing) };
    },
  });
}
