import { z } from 'zod';
import { SmartMoneyTrenchesInput, TrenchesScanInput, TrenchesCheckInput } from '../schemas/trenches';
import type { TrenchesSmartMoneyAnalyzer } from '../enrichers/trenches-smart-money';
import type { TrenchesScanOrchestrator } from '../enrichers/trenches-scan';
import type { TrenchesCheckAnalyzer } from '../enrichers/trenches-check';
import { formatResponse } from '../formatters';
import { formatTrenchesBriefing } from '../formatters/llm-trenches';
import { formatTrenchesScanBriefing } from '../formatters/llm-trenches-scan';
import { formatTrenchesCheckBriefing } from '../formatters/llm-trenches-check';

type AddEntrypoint = (def: any) => void;

export function registerTrenchesEntrypoints(
  addEntrypoint: AddEntrypoint,
  trenchesSmartMoney: TrenchesSmartMoneyAnalyzer,
) {
  addEntrypoint({
    key: 'smart-money-trenches',
    description:
      'Which proven-winner wallets are aping fresh (<6h) memecoin launches right now, and what are they buying? Scans a vetted seed set of realized-PnL winners (bot-filtered, re-checked live each scan), overlays their recent buys against token launch times, and ranks fresh tokens by distinct smart buyers + recency. The trenches attention signal.',
    input: SmartMoneyTrenchesInput,
    handler: async (ctx: { input: z.infer<typeof SmartMoneyTrenchesInput> }) => {
      const input = ctx.input;
      const data = await trenchesSmartMoney.enrich(
        input.hours_back,
        input.max_token_age_hours,
        input.min_buyers,
        input.limit,
      );
      return { output: formatResponse(data, input.format, formatTrenchesBriefing) };
    },
  });
}

export function registerTrenchesScanEntrypoint(
  addEntrypoint: AddEntrypoint,
  orchestrator: TrenchesScanOrchestrator,
) {
  addEntrypoint({
    key: 'trenches-scan',
    description:
      'The three-signal memecoin scan in one call: on-chain velocity (runner-scan), proven-winner buys (smart-money-trenches), and agent attention (attention-momentum), composited into a ranked ape-able list with per-token reasoning and HIGH_CONFLUENCE / MODERATE / SINGLE_SIGNAL verdicts. Legs degrade independently — one upstream failure annotates the result instead of killing it.',
    input: TrenchesScanInput,
    handler: async (ctx: { input: z.infer<typeof TrenchesScanInput> }) => {
      const input = ctx.input;
      const data = await orchestrator.scan(
        input.max_token_age_hours,
        input.min_liquidity_usd,
        input.limit,
      );
      return { output: formatResponse(data, input.format, formatTrenchesScanBriefing) };
    },
  });
}

export function registerTrenchesCheckEntrypoint(
  addEntrypoint: AddEntrypoint,
  analyzer: TrenchesCheckAnalyzer,
) {
  addEntrypoint({
    key: 'trenches-check',
    description:
      'The trenches suite pointed at ONE token: pass a mint, get a HIGH_CONFLUENCE / MODERATE / SINGLE_SIGNAL / NO_SIGNAL verdict with reasoning. Runs the same three legs as trenches-scan — on-chain velocity (runner stage + score), proven-winner buys, agent attention — but targeted. The follow-up call to a new-tokens discovery or any token someone shilled you: before you ape, run the check.',
    input: TrenchesCheckInput,
    handler: async (ctx: { input: z.infer<typeof TrenchesCheckInput> }) => {
      const input = ctx.input;
      const data = await analyzer.check(input.mint);
      return { output: formatResponse(data, input.format, formatTrenchesCheckBriefing) };
    },
  });
}
