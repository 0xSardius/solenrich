import { z } from 'zod';
import { QueryInput } from '../schemas/query';
import { formatResponse } from '../formatters';
import { formatWalletBriefing } from '../formatters/llm-wallet';
import { formatTokenBriefing } from '../formatters/llm-token';
import { formatTransactionBriefing } from '../formatters/llm-transaction';
import { formatWhaleWatchBriefing } from '../formatters/llm-whale-watch';
import { formatDueDiligenceBriefing } from '../formatters/llm-due-diligence';
import { formatCopyTradeBriefing } from '../formatters/llm-copy-trade';
import { formatGraphBriefing } from '../formatters/llm-graph';
import type { WalletProfiler } from '../enrichers/wallet-profiler';
import type { TokenAnalyzer } from '../enrichers/token-analyzer';
import type { TxParser } from '../enrichers/tx-parser';
import type { WhaleWatcher } from '../enrichers/whale-watch';
import type { DueDiligenceAnalyzer } from '../enrichers/due-diligence';
import type { CopyTradeAnalyzer } from '../enrichers/copy-trade-analyzer';
import type { GraphMapper } from '../enrichers/graph-mapper';

type AddEntrypoint = (def: any) => void;

// --- Intent parsing ---

type Intent = 'wallet' | 'token' | 'transaction' | 'whale-watch' | 'due-diligence' | 'copy-trade' | 'graph' | 'unknown';

interface ParsedIntent {
  intent: Intent;
  address: string | null;
}

// Base58 patterns
const ADDR_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
const SIG_RE = /[1-9A-HJ-NP-Za-km-z]{85,90}/;

// Ordered intent rules — first match wins
const INTENT_RULES: Array<{ pattern: RegExp; intent: Intent }> = [
  { pattern: /\b(due.?diligence|is\s+\S+\s+safe|rug|rugpull|scam)\b/i, intent: 'due-diligence' },
  { pattern: /\b(whale|whales|large.?holder|accumulation|distribution)\b/i, intent: 'whale-watch' },
  { pattern: /\b(copy.?trade|signal|pnl|win.?rate|trading\s+performance)\b/i, intent: 'copy-trade' },
  { pattern: /\b(graph|connection|network|cluster|counterpart)\b/i, intent: 'graph' },
  { pattern: /\b(transaction|tx|parse|signature)\b/i, intent: 'transaction' },
  { pattern: /\b(token|price|market.?cap|liquidity|holder|concentration)\b/i, intent: 'token' },
  { pattern: /\b(wallet|profile|balance|portfolio|holdings|enrich)\b/i, intent: 'wallet' },
];

function parseIntent(question: string): ParsedIntent {
  // Check for transaction signature first (longer than addresses)
  const sigMatch = question.match(SIG_RE);
  if (sigMatch) {
    return { intent: 'transaction', address: sigMatch[0] };
  }

  // Determine intent from keywords
  let intent: Intent = 'unknown';
  for (const rule of INTENT_RULES) {
    if (rule.pattern.test(question)) {
      intent = rule.intent;
      break;
    }
  }

  // Extract address
  const addrMatch = question.match(ADDR_RE);
  const address = addrMatch?.[0] ?? null;

  // If we found an address but no intent, default to wallet
  if (address && intent === 'unknown') {
    intent = 'wallet';
  }

  return { intent, address };
}

// --- Entrypoint registration ---

export function registerQueryEntrypoint(
  addEntrypoint: AddEntrypoint,
  walletProfiler: WalletProfiler,
  tokenAnalyzer: TokenAnalyzer,
  txParser: TxParser,
  whaleWatcher: WhaleWatcher,
  dueDiligenceAnalyzer: DueDiligenceAnalyzer,
  copyTradeAnalyzer: CopyTradeAnalyzer,
  graphMapper: GraphMapper,
) {
  addEntrypoint({
    key: 'query',
    description: 'Ask a natural language question about any Solana wallet, token, or transaction',
    input: QueryInput,
    handler: async (ctx: { input: z.infer<typeof QueryInput> }) => {
      const { question, format } = ctx.input;
      const { intent, address } = parseIntent(question);

      if (intent === 'unknown' || !address) {
        return {
          output: {
            error: 'Could not determine intent or find an address in your question.',
            hint: 'Include a Solana address or mint and specify what you want. Examples:',
            examples: [
              'wallet profile for <address>',
              'is <mint> safe?',
              'whales for <mint>',
              'token analysis for <mint>',
              'parse transaction <signature>',
              'copy trade signals for <address>',
              'graph connections for <address>',
            ],
            parsed: { intent, address },
          },
        };
      }

      switch (intent) {
        case 'wallet': {
          const data = await walletProfiler.enrich(address, 'light');
          return { output: formatResponse(data, format, formatWalletBriefing) };
        }
        case 'token': {
          const data = await tokenAnalyzer.enrich(address, true);
          return { output: formatResponse(data, format, formatTokenBriefing) };
        }
        case 'transaction': {
          const data = await txParser.enrich(address);
          if (!data) return { output: { error: `Transaction ${address} not found or could not be parsed.` } };
          return { output: formatResponse(data, format, formatTransactionBriefing) };
        }
        case 'whale-watch': {
          const data = await whaleWatcher.enrich(address, 10000, 24);
          return { output: formatResponse(data, format, formatWhaleWatchBriefing) };
        }
        case 'due-diligence': {
          const data = await dueDiligenceAnalyzer.enrich(address);
          return { output: formatResponse(data, format, formatDueDiligenceBriefing) };
        }
        case 'copy-trade': {
          const data = await copyTradeAnalyzer.enrich(address, 30);
          return { output: formatResponse(data, format, formatCopyTradeBriefing) };
        }
        case 'graph': {
          const data = await graphMapper.enrich(address, 1, 1);
          return { output: formatResponse(data, format, formatGraphBriefing) };
        }
      }
    },
  });
}
