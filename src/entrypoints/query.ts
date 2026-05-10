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
import { formatTokenTrendBriefing, formatWalletHistoryBriefing } from '../formatters/llm-trend';
import { formatPerpsMarketBriefing, formatPerpsTraderBriefing } from '../formatters/llm-perps';
import { formatTrendingBriefing } from '../formatters/llm-trending';
import { parallelFetch } from '../utils/parallel';
import type { WalletProfiler } from '../enrichers/wallet-profiler';
import type { TokenAnalyzer } from '../enrichers/token-analyzer';
import type { TxParser } from '../enrichers/tx-parser';
import type { WhaleWatcher } from '../enrichers/whale-watch';
import type { DueDiligenceAnalyzer } from '../enrichers/due-diligence';
import type { CopyTradeAnalyzer } from '../enrichers/copy-trade-analyzer';
import type { GraphMapper } from '../enrichers/graph-mapper';
import type { TrendAnalyzer } from '../enrichers/trend-analyzer';
import type { PerpsAnalyzer } from '../enrichers/perps-analyzer';
import type { TrendingSignalsAnalyzer } from '../enrichers/trending-signals';

type AddEntrypoint = (def: any) => void;

// --- Intent parsing ---

type SimpleIntent =
  | 'wallet'
  | 'token'
  | 'transaction'
  | 'whale-watch'
  | 'due-diligence'
  | 'copy-trade'
  | 'graph';

type CompoundIntent =
  | 'buy-decision'   // token: due-diligence + token-trend + whale-watch
  | 'safety-check'   // token: due-diligence + whale-watch
  | 'wallet-deep'    // wallet: wallet-full + wallet-history + perps-trader-profile
  | 'perps-market'   // no address: perps-market-structure
  | 'trending';      // no address: trending-signals

type Intent = SimpleIntent | CompoundIntent | 'unknown';

interface ParsedIntent {
  intent: Intent;
  address: string | null;
  /** address is required for this intent (false for perps-market, trending) */
  needs_address: boolean;
}

// Base58 patterns
const ADDR_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/;
const SIG_RE = /[1-9A-HJ-NP-Za-km-z]{85,90}/;

// Compound intents — matched FIRST so they beat single-intent keywords
const COMPOUND_RULES: Array<{ pattern: RegExp; intent: CompoundIntent; needs_address: boolean }> = [
  // perps market — no address required
  {
    pattern: /\b(perps?[\s-]?(market|funding|borrow|oi|open\s?interest)|sol[\s-]?perp|funding\s+rate|borrow\s+apr)\b/i,
    intent: 'perps-market',
    needs_address: false,
  },
  // trending — no address required
  {
    pattern: /\b(trending|hot\s+tokens?|what'?s\s+(hot|popping|moving)|top\s+tokens?\s+(right\s+now|today)|find\s+(me\s+)?(a\s+)?(token|trade|coin))\b/i,
    intent: 'trending',
    needs_address: false,
  },
  // buy-decision — strongest signal for compound token analysis
  {
    pattern: /\b(should\s+i\s+(buy|trade|enter|ape|long)|worth\s+(buying|trading|entering)|good\s+(buy|trade|entry)|ape\s+in)\b/i,
    intent: 'buy-decision',
    needs_address: true,
  },
  // safety-check — light compound (DD + whales)
  {
    pattern: /\b(rug\s?(check|pull)?|is\s+\S+\s+(safe|legit|a\s+scam)|safety\s+check)\b/i,
    intent: 'safety-check',
    needs_address: true,
  },
  // wallet-deep — full wallet workup
  {
    pattern: /\b(wallet\s+(deep\s?dive|full\s+profile|workup|breakdown)|tell\s+me\s+(about|everything\s+about)\s+(this\s+)?(wallet|trader)|trader\s+profile|deep\s?dive)\b/i,
    intent: 'wallet-deep',
    needs_address: true,
  },
];

// Single intents — matched after compounds; first match wins
const INTENT_RULES: Array<{ pattern: RegExp; intent: SimpleIntent }> = [
  { pattern: /\b(due.?diligence)\b/i, intent: 'due-diligence' },
  { pattern: /\b(whale|whales|large.?holder|accumulation|distribution)\b/i, intent: 'whale-watch' },
  { pattern: /\b(copy.?trade|signal|pnl|win.?rate|trading\s+performance)\b/i, intent: 'copy-trade' },
  { pattern: /\b(graph|connection|network|cluster|counterpart)\b/i, intent: 'graph' },
  { pattern: /\b(transaction|tx|parse|signature)\b/i, intent: 'transaction' },
  { pattern: /\b(token|price|market.?cap|liquidity|holder|concentration)\b/i, intent: 'token' },
  { pattern: /\b(wallet|profile|balance|portfolio|holdings|enrich)\b/i, intent: 'wallet' },
];

export function parseIntent(question: string): ParsedIntent {
  // Transaction signatures are longer than addresses — try them first
  const sigMatch = question.match(SIG_RE);
  if (sigMatch) {
    return { intent: 'transaction', address: sigMatch[0], needs_address: true };
  }

  const addrMatch = question.match(ADDR_RE);
  const address = addrMatch?.[0] ?? null;

  // Compound intents win when they match
  for (const rule of COMPOUND_RULES) {
    if (rule.pattern.test(question)) {
      return { intent: rule.intent, address, needs_address: rule.needs_address };
    }
  }

  // Single intents
  for (const rule of INTENT_RULES) {
    if (rule.pattern.test(question)) {
      return { intent: rule.intent, address, needs_address: true };
    }
  }

  // Address-only fallback → wallet
  if (address) {
    return { intent: 'wallet', address, needs_address: true };
  }

  return { intent: 'unknown', address: null, needs_address: true };
}

// --- Compound briefing composer ---

interface CompoundComponent {
  title: string;
  briefing: string | null;
  error?: string;
}

function composeCompoundBriefing(headline: string, components: CompoundComponent[]): string {
  const parts: string[] = [`# ${headline}`];
  for (const c of components) {
    parts.push(`\n## ${c.title}`);
    if (c.briefing) parts.push(c.briefing);
    else parts.push(`_${c.error ?? 'No data available.'}_`);
  }
  return parts.join('\n');
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
  trendAnalyzer: TrendAnalyzer,
  perpsAnalyzer: PerpsAnalyzer,
  trendingSignals: TrendingSignalsAnalyzer,
) {
  addEntrypoint({
    key: 'query',
    description:
      'Plain English questions routed to the right enricher. Single-intent questions hit one enricher; compound questions ("should I buy X?", "wallet deep dive on X", "what\'s trending?") chain 2-3 enrichers in parallel and return a unified briefing.',
    input: QueryInput,
    handler: async (ctx: { input: z.infer<typeof QueryInput> }) => {
      const { question, format } = ctx.input;
      const { intent, address, needs_address } = parseIntent(question);

      if (intent === 'unknown' || (needs_address && !address)) {
        return {
          output: {
            error: 'Could not determine intent or find an address in your question.',
            hint: 'Include a Solana address/mint and specify what you want. Examples:',
            examples: [
              'should I buy <mint>?',
              'wallet deep dive on <address>',
              'is <mint> safe?',
              'what\'s trending right now',
              'SOL-PERP funding rate',
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
        // ---- Single intents ----
        case 'wallet': {
          const data = await walletProfiler.enrich(address!, 'light');
          return { output: formatResponse(data, format, formatWalletBriefing) };
        }
        case 'token': {
          const data = await tokenAnalyzer.enrich(address!, true);
          return { output: formatResponse(data, format, formatTokenBriefing) };
        }
        case 'transaction': {
          const data = await txParser.enrich(address!);
          if (!data) return { output: { error: `Transaction ${address} not found or could not be parsed.` } };
          return { output: formatResponse(data, format, formatTransactionBriefing) };
        }
        case 'whale-watch': {
          const data = await whaleWatcher.enrich(address!, 10000, 24);
          return { output: formatResponse(data, format, formatWhaleWatchBriefing) };
        }
        case 'due-diligence': {
          const data = await dueDiligenceAnalyzer.enrich(address!);
          return { output: formatResponse(data, format, formatDueDiligenceBriefing) };
        }
        case 'copy-trade': {
          const data = await copyTradeAnalyzer.enrich(address!, 30);
          return { output: formatResponse(data, format, formatCopyTradeBriefing) };
        }
        case 'graph': {
          const data = await graphMapper.enrich(address!, 1, 1);
          return { output: formatResponse(data, format, formatGraphBriefing) };
        }

        // ---- Compound intents ----
        case 'buy-decision': {
          const results = await parallelFetch<any>([
            { name: 'due_diligence', fn: () => dueDiligenceAnalyzer.enrich(address!) },
            { name: 'token_trend', fn: () => trendAnalyzer.analyzeTokenTrend(address!, 7) },
            { name: 'whale_watch', fn: () => whaleWatcher.enrich(address!, 10000, 24) },
          ], 15_000);

          const components: CompoundComponent[] = [
            { title: 'Due Diligence', briefing: results.due_diligence ? formatDueDiligenceBriefing(results.due_diligence) : null, error: 'Due diligence failed.' },
            { title: '7-Day Trend', briefing: results.token_trend ? formatTokenTrendBriefing(results.token_trend) : null, error: 'Trend snapshot unavailable.' },
            { title: 'Whale Activity (24h)', briefing: results.whale_watch ? formatWhaleWatchBriefing(results.whale_watch) : null, error: 'Whale watch failed.' },
          ];

          const data = {
            intent: 'buy-decision',
            address,
            components: {
              due_diligence: results.due_diligence,
              token_trend: results.token_trend,
              whale_watch: results.whale_watch,
            },
          };

          return {
            output: formatResponse(
              data,
              format,
              () => composeCompoundBriefing(`Buy Decision — ${address}`, components),
            ),
          };
        }

        case 'safety-check': {
          const results = await parallelFetch<any>([
            { name: 'due_diligence', fn: () => dueDiligenceAnalyzer.enrich(address!) },
            { name: 'whale_watch', fn: () => whaleWatcher.enrich(address!, 10000, 24) },
          ], 15_000);

          const components: CompoundComponent[] = [
            { title: 'Due Diligence', briefing: results.due_diligence ? formatDueDiligenceBriefing(results.due_diligence) : null, error: 'Due diligence failed.' },
            { title: 'Whale Activity (24h)', briefing: results.whale_watch ? formatWhaleWatchBriefing(results.whale_watch) : null, error: 'Whale watch failed.' },
          ];

          const data = {
            intent: 'safety-check',
            address,
            components: {
              due_diligence: results.due_diligence,
              whale_watch: results.whale_watch,
            },
          };

          return {
            output: formatResponse(
              data,
              format,
              () => composeCompoundBriefing(`Safety Check — ${address}`, components),
            ),
          };
        }

        case 'wallet-deep': {
          const results = await parallelFetch<any>([
            { name: 'wallet', fn: () => walletProfiler.enrich(address!, 'full') },
            { name: 'history', fn: () => trendAnalyzer.analyzeWalletHistory(address!, 7) },
            { name: 'perps', fn: () => perpsAnalyzer.analyzeTrader(address!) },
          ], 15_000);

          const components: CompoundComponent[] = [
            { title: 'Wallet Profile', briefing: results.wallet ? formatWalletBriefing(results.wallet) : null, error: 'Wallet profile failed.' },
            { title: '7-Day History', briefing: results.history ? formatWalletHistoryBriefing(results.history) : null, error: 'History snapshot unavailable.' },
            { title: 'Jupiter Perps Positions', briefing: results.perps ? formatPerpsTraderBriefing(results.perps) : null, error: 'Perps lookup failed.' },
          ];

          const data = {
            intent: 'wallet-deep',
            address,
            components: {
              wallet: results.wallet,
              history: results.history,
              perps: results.perps,
            },
          };

          return {
            output: formatResponse(
              data,
              format,
              () => composeCompoundBriefing(`Wallet Deep Dive — ${address}`, components),
            ),
          };
        }

        case 'perps-market': {
          const data = await perpsAnalyzer.analyzeMarket();
          return { output: formatResponse(data, format, formatPerpsMarketBriefing) };
        }

        case 'trending': {
          const data = await trendingSignals.enrich(10_000, 0.7, 10, true);
          return { output: formatResponse(data, format, formatTrendingBriefing) };
        }
      }
    },
  });
}
