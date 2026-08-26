import { z } from 'zod';
import { FormatSchema, SolanaAddressSchema } from './common';

// Required `mint` → needs a BAZAAR_INPUT_EXAMPLES entry in agent.ts or the
// endpoint stays invisible in the CDP bazaar (checklist item 9).
export const ExitSignalInput = z.object({
  mint: SolanaAddressSchema,
  /** Optional: your entry price. Adds unrealized-PnL context to the briefing;
   *  does not change the verdict — the tape reads the same wherever you bought. */
  entry_price_usd: z.number().positive().optional(),
  format: FormatSchema,
});
export type ExitSignalInput = z.infer<typeof ExitSignalInput>;
