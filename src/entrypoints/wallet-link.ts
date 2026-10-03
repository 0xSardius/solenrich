import { z } from 'zod';
import { WalletLinkInput } from '../schemas/wallet-link';
import type { WalletLinkChecker } from '../enrichers/wallet-link';
import { formatResponse } from '../formatters';
import { formatWalletLinkBriefing } from '../formatters/llm-wallet-link';

type AddEntrypoint = (def: any) => void;

export function registerWalletLinkEntrypoint(addEntrypoint: AddEntrypoint, checker: WalletLinkChecker) {
  addEntrypoint({
    key: 'wallet-link-check',
    description:
      'Are two Solana wallets the same owner? Same-owner confidence and a verdict (LIKELY_SAME_OWNER / LIKELY_ROTATION, UNCERTAIN, SUSPICIOUS) from direct transfers, first funders, the new wallet\'s age and x402 history, and risk flags. Built for x402 trust monitors deciding whether a payout-wallet change is a rotation or a hijack.',
    input: WalletLinkInput,
    handler: async (ctx: { input: z.infer<typeof WalletLinkInput> }) => {
      const data = await checker.check(ctx.input.wallet_a, ctx.input.wallet_b, ctx.input.context);
      return { output: formatResponse(data, ctx.input.format, formatWalletLinkBriefing) };
    },
  });
}
