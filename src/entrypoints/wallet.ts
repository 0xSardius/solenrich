import { z } from 'zod';
import { PRICING } from '../config';
import { EnrichWalletInput, WalletEnrichmentSchema } from '../schemas/wallet';
import type { WalletProfiler } from '../enrichers/wallet-profiler';
import { formatResponse } from '../formatters';
import { formatWalletBriefing } from '../formatters/llm-wallet';

type AddEntrypoint = (def: any) => void;

export function registerWalletEntrypoints(
  addEntrypoint: AddEntrypoint,
  profiler: WalletProfiler,
) {
  // NOTE: price commented out until @x402/solana ships (no Solana scheme in x402 yet)
  // Prices defined in PRICING config, ready to enable: PRICING['enrich-wallet-light'] = '0.002'

  addEntrypoint({
    key: 'enrich-wallet-light',
    description: 'Light wallet profile with holdings, labels, and risk score',
    input: EnrichWalletInput,
    // output schema omitted — response shape varies by format (json/llm/both)
    // price: PRICING['enrich-wallet-light'],
    handler: async (ctx: { input: z.infer<typeof EnrichWalletInput> }) => {
      const data = await profiler.enrich(ctx.input.address, 'light');
      return { output: formatResponse(data, ctx.input.format, formatWalletBriefing) };
    },
  });

  addEntrypoint({
    key: 'enrich-wallet-full',
    description: 'Full wallet profile with holdings, DeFi positions, labels, risk score, and connected wallets',
    input: EnrichWalletInput,
    // output schema omitted — response shape varies by format (json/llm/both)
    // price: PRICING['enrich-wallet-full'],
    handler: async (ctx: { input: z.infer<typeof EnrichWalletInput> }) => {
      const data = await profiler.enrich(ctx.input.address, 'full');
      return { output: formatResponse(data, ctx.input.format, formatWalletBriefing) };
    },
  });
}
