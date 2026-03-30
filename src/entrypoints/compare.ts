import { z } from 'zod';
import { CompareTokensInput, CompareWalletsInput } from '../schemas/compare';
import { formatResponse } from '../formatters/index';
import { formatTokenComparisonBriefing, formatWalletComparisonBriefing } from '../formatters/llm-compare';
import type { TokenComparator, WalletComparator } from '../enrichers/comparator';

export function registerCompareEntrypoints(
  addEntrypoint: Function,
  tokenComparator: TokenComparator,
  walletComparator: WalletComparator,
) {
  addEntrypoint({
    key: 'compare-tokens',
    description: 'Compare 2-3 tokens side-by-side: price, liquidity, volatility, holder concentration, risk flags',
    input: CompareTokensInput,
    handler: async (ctx: { input: z.infer<typeof CompareTokensInput> }) => {
      const data = await tokenComparator.compare(ctx.input.mints);
      return { output: formatResponse(data, ctx.input.format, formatTokenComparisonBriefing) };
    },
  });

  addEntrypoint({
    key: 'compare-wallets',
    description: 'Compare 2-3 wallets side-by-side: portfolio value, activity, risk, labels, holdings',
    input: CompareWalletsInput,
    handler: async (ctx: { input: z.infer<typeof CompareWalletsInput> }) => {
      const data = await walletComparator.compare(ctx.input.addresses, ctx.input.depth);
      return { output: formatResponse(data, ctx.input.format, formatWalletComparisonBriefing) };
    },
  });
}
