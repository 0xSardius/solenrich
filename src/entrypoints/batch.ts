import { z } from 'zod';
import { BatchEnrichInput } from '../schemas/batch';
import type { WalletProfiler } from '../enrichers/wallet-profiler';
import type { TokenAnalyzer } from '../enrichers/token-analyzer';
import { formatResponse } from '../formatters';
import { formatWalletBriefing } from '../formatters/llm-wallet';
import { formatTokenBriefing } from '../formatters/llm-token';
import { formatTimestamp } from '../utils/normalize';

type AddEntrypoint = (def: any) => void;

// Concurrency limiter: run at most N tasks at a time
async function withConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<Array<T | null>> {
  const results: Array<T | null> = new Array(tasks.length).fill(null);
  let idx = 0;

  async function next(): Promise<void> {
    while (idx < tasks.length) {
      const i = idx++;
      try {
        results[i] = await tasks[i]();
      } catch (e: any) {
        console.warn(`[batch] Task ${i} failed: ${e.message}`);
        results[i] = null;
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

function formatBatchBriefing(results: any[], type: string): string {
  const lines: string[] = [];
  lines.push(`## Batch Enrichment Results`);
  lines.push('');
  lines.push(`Enriched ${results.filter(Boolean).length} of ${results.length} ${type}(s).`);
  lines.push('');

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (!r) {
      lines.push(`**#${i + 1}**: Failed`);
      continue;
    }
    if (type === 'wallet') {
      lines.push(`**#${i + 1}** ${r.address}: ${r.labels?.join(', ') || 'no labels'}, risk ${r.risk_score}`);
    } else {
      lines.push(`**#${i + 1}** ${r.symbol}: $${r.price_usd}, ${r.risk_flags?.length || 0} risk flags`);
    }
  }

  return lines.join('\n');
}

export function registerBatchEntrypoint(
  addEntrypoint: AddEntrypoint,
  walletProfiler: WalletProfiler,
  tokenAnalyzer: TokenAnalyzer,
) {
  addEntrypoint({
    key: 'batch-enrich',
    description: 'Enrich multiple wallets or tokens in parallel',
    input: BatchEnrichInput,
    // price: PRICING['batch-enrich'],
    handler: async (ctx: { input: z.infer<typeof BatchEnrichInput> }) => {
      const { addresses, type, depth, format } = ctx.input;
      const start = Date.now();

      let results: any[];

      if (type === 'wallet') {
        const tasks = addresses.map((addr) => () => walletProfiler.enrich(addr, depth));
        results = await withConcurrency(tasks, 5);
      } else {
        const includeHolders = depth === 'full';
        const tasks = addresses.map((addr) => () => tokenAnalyzer.enrich(addr, includeHolders));
        results = await withConcurrency(tasks, 5);
      }

      const processingTimeMs = Date.now() - start;
      const successfulResults = results.filter(Boolean);

      if (format === 'json') {
        return {
          output: {
            results: successfulResults,
            total_count: addresses.length,
            success_count: successfulResults.length,
            processing_time_ms: processingTimeMs,
            last_updated: formatTimestamp(),
          },
        };
      }

      if (format === 'llm') {
        return {
          output: {
            briefing: formatBatchBriefing(results, type),
            content_type: 'text/markdown',
          },
        };
      }

      // both
      return {
        output: {
          results: successfulResults,
          total_count: addresses.length,
          success_count: successfulResults.length,
          processing_time_ms: processingTimeMs,
          llm_summary: formatBatchBriefing(results, type),
          last_updated: formatTimestamp(),
        },
      };
    },
  });
}
