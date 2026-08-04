import type { AttentionMomentumResult, MomentumEntry } from '../enrichers/signal-tracker';
import type { ConsensusSignalResult } from '../enrichers/signal-tracker';
import { shortenAddress, formatUsd } from '../utils/normalize';

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

const DIVERGENCE_LABEL: Record<string, string> = {
  early_signal: '🟢 EARLY SIGNAL',
  confirmed_momentum: '🔵 confirmed momentum',
  distribution_risk: '🔴 DISTRIBUTION RISK',
  fading: '⚪ fading',
  neutral: '– neutral',
};

function entryName(e: MomentumEntry): string {
  return e.symbol ? `$${e.symbol} (${shortenAddress(e.address)})` : shortenAddress(e.address);
}

export function formatAttentionMomentumBriefing(data: AttentionMomentumResult): string {
  const lines: string[] = [];

  lines.push(`## Attention Momentum — agent-attention acceleration (${data.window})`);
  lines.push('');
  lines.push(
    `${data.aggregate.total_unique_tokens} token(s) in the query stream, ` +
      `${data.aggregate.total_queries_current_window} queries in the current window. ` +
      `Sample quality: **${data.aggregate.sample_quality}**.`,
  );

  if (data.entries.length === 0) {
    lines.push('');
    lines.push(
      `_No token queries recorded across the last 3×${data.window}. ` +
        `Signal accumulates as agents call SolEnrich endpoints._`,
    );
  } else {
    // Divergence callouts first — they ARE the product
    const early = data.entries.filter((e) => e.divergence === 'early_signal');
    const distRisk = data.entries.filter((e) => e.divergence === 'distribution_risk');
    if (early.length > 0) {
      lines.push('');
      lines.push(
        `**Early signals** (attention up, price hasn't moved): ${early.map(entryName).join(', ')}`,
      );
    }
    if (distRisk.length > 0) {
      lines.push(
        `**Distribution risk** (attention cooling while price pumps): ${distRisk.map(entryName).join(', ')}`,
      );
    }

    lines.push('');
    lines.push(`### Ranked by attention acceleration`);
    lines.push('');
    lines.push('| # | Token | Queries (w-2→w-1→now) | Accel | Price Δ | Divergence |');
    lines.push('|---|-------|----------------------|-------|---------|------------|');
    data.entries.forEach((e, i) => {
      const q = `${e.queries.prior2}→${e.queries.prior}→${e.queries.current}`;
      const accel = e.acceleration > 0 ? `+${e.acceleration}` : `${e.acceleration}`;
      const priceD = e.price_change_pct === null ? 'n/a' : `${e.price_change_pct > 0 ? '+' : ''}${e.price_change_pct.toFixed(1)}%`;
      const div = e.divergence ? DIVERGENCE_LABEL[e.divergence] : 'no price data';
      lines.push(`| ${i + 1} | ${entryName(e)} | ${q} | ${accel} | ${priceD} | ${div} |`);
    });

    const priced = data.entries.filter((e) => e.price_usd !== null);
    if (priced.length > 0) {
      lines.push('');
      priced.slice(0, 3).forEach((e) => {
        lines.push(
          `- ${entryName(e)}: ${formatUsd(e.price_usd!)} | liquidity ${e.liquidity_usd !== null ? formatUsd(e.liquidity_usd) : 'n/a'} | attention ${e.attention}`,
        );
      });
    }
  }

  lines.push('');
  lines.push(`_${data.note}_`);

  return lines.join('\n');
}
