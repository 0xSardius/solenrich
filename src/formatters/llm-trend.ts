import type { TokenTrend, WalletHistory, MetricDelta, PortfolioHistory } from '../enrichers/trend-analyzer';
import { shortenAddress, formatUsd } from '../utils/normalize';

const ARROWS: Record<string, string> = {
  improving: '↑',
  declining: '↓',
  stable: '→',
  insufficient_data: '?',
};

function fmtDelta(d: MetricDelta): string {
  const arrow = ARROWS[d.direction];
  const sign = d.pct_change >= 0 ? '+' : '';
  return `${arrow} ${sign}${d.pct_change.toFixed(1)}% (${d.direction})`;
}

export function formatTokenTrendBriefing(data: TokenTrend): string {
  const t = data.current;
  const sym = t.symbol || shortenAddress(t.mint);

  let out = `## Token Trend: ${sym} (${data.lookback_days}-day lookback)\n\n`;
  out += `Current: ${formatUsd(t.price_usd)} | Market cap: ${formatUsd(t.market_cap)} | Liquidity: ${formatUsd(t.liquidity)}\n\n`;

  if (data.data_points === 0) {
    out += `No historical data available yet. Snapshots are captured automatically — check back after the first day of usage.\n`;
  } else {
    out += `### Changes (${data.data_points} data point${data.data_points > 1 ? 's' : ''})\n`;
    for (const d of data.deltas) {
      const label = d.metric.replace(/_/g, ' ');
      out += `- **${label}**: ${formatMetricValue(d.metric, d.oldest)} → ${formatMetricValue(d.metric, d.current)} ${fmtDelta(d)}\n`;
    }

    out += `\nOverall direction: **${data.overall_direction}**\n`;
  }

  out += `\nData as of: ${data.last_updated}`;
  return out;
}

export function formatWalletHistoryBriefing(data: WalletHistory): string {
  const w = data.current;

  let out = `## Wallet History: ${shortenAddress(w.address)} (${data.lookback_days}-day lookback)\n\n`;
  out += `Current: ${formatUsd(w.portfolio_value_usd)} | ${w.sol_balance.toFixed(2)} SOL | ${w.token_count} tokens | Risk: ${w.risk_score.toFixed(2)} (${w.risk_level})\n\n`;

  if (data.data_points === 0) {
    out += `No historical data available yet. Snapshots are captured automatically — check back after the first day of usage.\n`;
  } else {
    out += `### Changes (${data.data_points} data point${data.data_points > 1 ? 's' : ''})\n`;
    for (const d of data.deltas) {
      const label = d.metric.replace(/_/g, ' ');
      out += `- **${label}**: ${formatMetricValue(d.metric, d.oldest)} → ${formatMetricValue(d.metric, d.current)} ${fmtDelta(d)}\n`;
    }

    if (data.position_changes.added.length > 0 || data.position_changes.removed.length > 0) {
      out += `\n### Position Changes\n`;
      for (const mint of data.position_changes.added) {
        out += `- Added: ${shortenAddress(mint)}\n`;
      }
      for (const mint of data.position_changes.removed) {
        out += `- Removed: ${shortenAddress(mint)}\n`;
      }
    }

    out += `\nOverall direction: **${data.overall_direction}**\n`;
  }

  out += `\nData as of: ${data.last_updated}`;
  return out;
}

function formatMetricValue(metric: string, value: number): string {
  if (metric.includes('price') || metric.includes('value') || metric.includes('liquidity') || metric.includes('market_cap') || metric.includes('volume')) {
    return formatUsd(value);
  }
  if (metric.includes('sol_balance')) return `${value.toFixed(2)} SOL`;
  if (metric.includes('risk_score')) return value.toFixed(2);
  if (metric.includes('pct')) return `${value.toFixed(1)}%`;
  return String(Math.round(value * 100) / 100);
}

export function formatPortfolioHistoryBriefing(data: PortfolioHistory): string {
  const short = shortenAddress(data.address);
  const s = data.summary;
  const lines: string[] = [];

  lines.push(`## Portfolio History: ${short} (${s.lookback_days}-day lookback)`);
  lines.push('');
  lines.push(
    `Current: ${formatUsd(data.current.portfolio_value_usd)} | ` +
      `${data.current.sol_balance.toFixed(2)} SOL | ` +
      `${data.current.token_count} tokens | ` +
      `Risk: ${data.current.risk_score.toFixed(2)} (${data.current.risk_level})`,
  );

  if (s.data_points === 0) {
    lines.push('');
    lines.push('_No historical snapshots yet. Density improves as this wallet is queried over time._');
    return lines.join('\n');
  }

  lines.push('');
  lines.push(`### Summary (${s.data_points} data point${s.data_points === 1 ? '' : 's'})`);
  if (s.peak) {
    lines.push(`- Peak: ${formatUsd(s.peak.portfolio_value_usd)} on ${s.peak.date}`);
  }
  if (s.trough) {
    lines.push(`- Trough: ${formatUsd(s.trough.portfolio_value_usd)} on ${s.trough.date}`);
  }
  if (s.average_portfolio_value_usd !== null) {
    lines.push(`- Average: ${formatUsd(s.average_portfolio_value_usd)}`);
  }
  if (s.max_drawdown_pct !== null) {
    lines.push(`- Max drawdown: ${s.max_drawdown_pct.toFixed(2)}%`);
  }
  if (s.change_vs_start_pct !== null) {
    const sign = s.change_vs_start_pct >= 0 ? '+' : '';
    lines.push(`- Change vs period start: ${sign}${s.change_vs_start_pct.toFixed(2)}%`);
  }

  // Series table — capped at 30 rows so 30d lookbacks stay readable
  lines.push('');
  lines.push('### Series');
  lines.push('');
  lines.push('| Date | Portfolio | SOL | Tokens | Risk |');
  lines.push('|------|-----------|-----|--------|------|');
  for (const point of data.series) {
    lines.push(
      `| ${point.date} | ${formatUsd(point.portfolio_value_usd)} | ` +
        `${point.sol_balance.toFixed(2)} | ${point.token_count} | ${point.risk_score.toFixed(2)} |`,
    );
  }

  if (s.data_points < s.lookback_days) {
    lines.push('');
    lines.push(
      `_Note: ${s.data_points} of ${s.lookback_days} possible daily points present. ` +
        `Gaps indicate days this wallet was not queried — snapshots accumulate fire-and-forget on every enrichment call._`,
    );
  }

  return lines.join('\n');
}
