import { z } from 'zod';
import { XstockBasisInput } from '../schemas/xstock-basis';
import type { XstockBasisAnalyzer } from '../enrichers/xstock-basis';
import { formatResponse } from '../formatters';
import { formatXstockBasisBriefing } from '../formatters/llm-xstock-basis';

type AddEntrypoint = (def: any) => void;

export function registerXstockBasisEntrypoint(addEntrypoint: AddEntrypoint, analyzer: XstockBasisAnalyzer) {
  addEntrypoint({
    key: 'xstock-basis',
    description:
      'Tokenized-stock basis trade: an xStock (NVDAx, TSLAx, SPYx, QQQx, AMZNx, METAx, GOOGLx, MSTRx, COINx, HOODx, CRCLx) vs its Phoenix perp. Long the xStock on Jupiter, short the perp, collect funding. Returns xStock / perp mark / Phoenix index prices and gaps in bps, funding APR, the real round-trip cost at your size (Jupiter buy + sell quotes, Phoenix order-book walk both ways, taker fees), breakeven days, open-interest headroom, after-hours and earnings flags. Verdict TRADE (breakeven ≤ 7 days) / MARGINAL (≤ 30) / NO_TRADE / TOO_THIN / UNAVAILABLE.',
    input: XstockBasisInput,
    handler: async (ctx: { input: z.infer<typeof XstockBasisInput> }) => {
      const data = await analyzer.analyze(ctx.input.symbol, ctx.input.size_usd);
      return { output: formatResponse(data, ctx.input.format, formatXstockBasisBriefing) };
    },
  });
}
