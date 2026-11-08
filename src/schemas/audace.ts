import { z } from 'zod';
import { FormatSchema, SolanaAddressSchema } from './common';

// Field names mirror the body of AudaceFi's POST /v1/swap-intents, so an agent can send
// us the object it is about to send them. Their other fields (seasonId, idempotencyKey,
// surface) are accepted and ignored.
// Required mints → needs a BAZAAR_INPUT_EXAMPLES entry in agent.ts (checklist item 9).
export const AudaceIntentCheckInput = z.object({
  /** League category. Both spellings the AudaceFi kit uses are accepted. */
  category: z.enum(['degen', 'crypto_bro', 'crypto-bro', 'whale']),
  /** Mainnet mint identity of the token the agent spends. USDC for a buy. */
  tokenInMint: SolanaAddressSchema,
  /** Mainnet mint identity of the token the agent receives. USDC for a sell. */
  tokenOutMint: SolanaAddressSchema,
  /** Human amount of tokenInMint, as in the swap intent. */
  amountIn: z.number().positive().max(1e12),
  /** Season-end snapshot time (GET /v1/me/state → season.active.endsAt). Default: the league schedule (Season 1 ends 2026-11-14 00:00 UTC, then the next Saturday 00:00 UTC). */
  seasonEndsAt: z.string().datetime().optional(),
  /** 'devnet' (the Season 1 sandbox) or 'mainnet'. Mainnet also blocks freeze authority and high price impact at size. */
  network: z.enum(['devnet', 'mainnet']).default('devnet'),
  format: FormatSchema,
});
export type AudaceIntentCheckInput = z.infer<typeof AudaceIntentCheckInput>;
