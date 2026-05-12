import type { ConsensusSignalResult } from '../enrichers/signal-tracker';
import { shortenAddress } from '../utils/normalize';

export function formatConsensusSignalBriefing(data: ConsensusSignalResult): string {
  const lines: string[] = [];
  const typeLabel = data.type === 'token' ? 'Token' : 'Wallet';

  lines.push(`## Consensus Signal — ${typeLabel} attention (${data.window})`);
  lines.push('');
  lines.push(
    `Window: ${data.window_start} → ${data.window_end}. ` +
      `${data.aggregate.total_unique_entities} distinct ${data.type}(s) queried, ` +
      `${data.aggregate.total_queries} total queries.`,
  );

  // Single-entity report
  if (data.entity) {
    const e = data.entity;
    lines.push('');
    lines.push(`### ${shortenAddress(e.address)}`);
    if (e.queries === 0) {
      lines.push(
        `No queries against this ${data.type} in the last ${data.window}. ` +
          `Out of ${data.aggregate.total_unique_entities} queried ${data.type}(s), this one is not in the tracked set.`,
      );
    } else {
      const trend =
        e.change_pct === null
          ? 'new — no prior-window data'
          : e.rising
            ? `rising (+${e.change_pct.toFixed(0)}% vs prior ${data.window})`
            : `cooling (${e.change_pct.toFixed(0)}% vs prior ${data.window})`;
      lines.push(`- Queries: **${e.queries}** in last ${data.window}`);
      lines.push(`- Rank: **#${e.rank}** of ${data.aggregate.total_unique_entities} (${e.percentile}th percentile)`);
      lines.push(`- Trend: ${trend}`);
      lines.push(`- Prior window: ${e.prior_window_queries} queries`);
    }
  }

  // Top-N table
  if (data.top_n.length > 0) {
    lines.push('');
    lines.push(`### Top ${data.top_n.length} ${typeLabel}s by agent attention`);
    lines.push('');
    lines.push('| # | Address | Queries | Trend |');
    lines.push('|---|---------|---------|-------|');
    data.top_n.forEach((row, i) => {
      const trend = row.rising ? '↑ rising' : '↓';
      lines.push(`| ${i + 1} | ${shortenAddress(row.address)} | ${row.queries} | ${trend} |`);
    });
  } else if (!data.entity) {
    lines.push('');
    lines.push(
      `_No agent queries recorded in the last ${data.window}. ` +
        `Signal data accumulates as agents call SolEnrich endpoints._`,
    );
  }

  lines.push('');
  lines.push(
    `_This signal is derived from SolEnrich's own query stream — what agents are actively researching right now. ` +
      `Not a market signal, an **attention signal**._`,
  );

  return lines.join('\n');
}
