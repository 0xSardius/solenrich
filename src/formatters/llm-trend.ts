import type { TokenTrend, WalletHistory, MetricDelta } from '../enrichers/trend-analyzer';
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
