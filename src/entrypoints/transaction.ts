import { z } from 'zod';
import { PRICING } from '../config';
import { FormatSchema, TxSignatureSchema } from '../schemas/common';
import type { TxParser } from '../enrichers/tx-parser';
import { formatResponse } from '../formatters';
import { formatTransactionBriefing } from '../formatters/llm-transaction';

const ParseTransactionInput = z.object({
  signature: TxSignatureSchema,
  format: FormatSchema,
});

const TransactionEnrichmentSchema = z.object({
  signature: z.string(),
  type: z.string(),
  description: z.string(),
  protocol: z.string().nullable(),
  fee_sol: z.number(),
  fee_payer: z.string(),
  timestamp: z.string(),
  success: z.boolean(),
  native_transfers: z.array(z.object({
    from: z.string(),
    to: z.string(),
    amount_sol: z.number(),
  })),
  token_transfers: z.array(z.object({
    from: z.string(),
    to: z.string(),
    mint: z.string(),
    symbol: z.string().optional(),
    amount: z.number(),
  })),
  accounts_involved: z.array(z.string()),
  last_updated: z.string(),
});

type AddEntrypoint = (def: any) => void;

export function registerTransactionEntrypoint(
  addEntrypoint: AddEntrypoint,
  parser: TxParser,
) {
  addEntrypoint({
    key: 'parse-transaction',
    description: 'Parse and enrich a Solana transaction with type detection, protocol identification, and transfer details',
    input: ParseTransactionInput,
    // output schema omitted — response shape varies by format (json/llm/both)
    // price: PRICING['parse-transaction'],  // Enable when @x402/solana ships
    handler: async (ctx: { input: z.infer<typeof ParseTransactionInput> }) => {
      const data = await parser.enrich(ctx.input.signature);
      if (!data) throw new Error('Transaction not found');
      return { output: formatResponse(data, ctx.input.format, formatTransactionBriefing) };
    },
  });
}
