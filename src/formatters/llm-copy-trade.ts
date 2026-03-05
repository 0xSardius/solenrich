import type { CopyTradeEnrichment } from '../enrichers/copy-trade-analyzer';
import { formatUsd, shortenAddress, formatPercent } from '../utils/normalize';

export function formatCopyTradeBriefing(data: CopyTradeEnrichment): string {
  const lines: string[] = [];

  lines.push(`## Copy Trade Analysis: ${shortenAddress(data.address)}`);
  lines.push('');

  if (data.trades_analyzed === 0) {
    lines.push(`No closed trades found in the last ${data.lookback_days} days.`);
    lines.push('');
    lines.push(`Data as of: ${data.last_updated}`);
    return lines.join('\n');
  }

  // Overview
  lines.push(
    `${data.trades_analyzed} closed trade(s) over ${data.lookback_days} days. Win rate: **${formatPercent(data.win_rate * 100)}**.`,
  );
  lines.push(
    `Total PnL: ${formatUsd(data.total_pnl_usd)}. Average PnL per trade: ${formatUsd(data.avg_pnl_per_trade_usd)}.`,
  );
  lines.push('');

  // Performance
  lines.push(
    `Average hold time: ${data.avg_hold_time_days} days. Consistency: ${formatPercent(data.consistency_score * 100)} (higher = more stable).`,
  );
  lines.push(`Trade frequency: ${data.trade_frequency_per_day} trades/day.`);
  lines.push('');

  // Labels
  if (data.labels.length > 0) {
    lines.push(`Labels: ${data.labels.join(', ')}.`);
  }

  // Top pairs
  if (data.top_performing_pairs.length > 0) {
    lines.push('');
    lines.push('### Top Performing Tokens');
    for (const pair of data.top_performing_pairs) {
      lines.push(
        `- ${shortenAddress(pair.buy_token)}: ${pair.win_count} win(s), avg PnL ${formatUsd(pair.avg_pnl)}`,
      );
    }
  }

  lines.push('');
  lines.push(`Data as of: ${data.last_updated}`);

  return lines.join('\n');
}
