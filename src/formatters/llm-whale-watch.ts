import type { WhaleWatchEnrichment } from '../enrichers/whale-watch';
import { formatUsd, shortenAddress } from '../utils/normalize';

export function formatWhaleWatchBriefing(data: WhaleWatchEnrichment): string {
  const lines: string[] = [];

  lines.push(`## Whale Watch: ${shortenAddress(data.mint)}`);
  lines.push('');

  if (data.whale_count === 0) {
    lines.push(`No whale activity detected above ${formatUsd(data.threshold_usd)} threshold in the last ${data.lookback_hours}h.`);
    lines.push('');
    lines.push(`Data as of: ${data.last_updated}`);
    return lines.join('\n');
  }

  lines.push(`${data.whale_count} whale(s) tracked. Threshold: ${formatUsd(data.threshold_usd)} in the last ${data.lookback_hours}h.`);
  lines.push(`Total whale volume: ${formatUsd(data.total_whale_volume_usd)}. Net flow: **${data.net_flow_direction}**.`);
  lines.push('');

  // Top whales with balance context
  const topWhales = data.whales.slice(0, 5);
  if (topWhales.length > 0) {
    lines.push('### Top Holders');
    for (const whale of topWhales) {
      const balanceStr = whale.balance_usd > 0 ? ` | Holds ${formatUsd(whale.balance_usd)} (${whale.pct_supply.toFixed(1)}% supply)` : '';
      const activityStr = whale.transaction_count > 0
        ? `${formatUsd(whale.total_volume_usd)} across ${whale.transaction_count} txs — ${whale.flow_direction}`
        : 'No recent activity';
      lines.push(
        `- ${shortenAddress(whale.address)}${balanceStr} | ${activityStr}`,
      );
    }
    lines.push('');
  }

  // Flow summary
  const accumulating = data.whales.filter((w) => w.flow_direction === 'accumulating').length;
  const distributing = data.whales.filter((w) => w.flow_direction === 'distributing').length;
  const neutral = data.whales.filter((w) => w.flow_direction === 'neutral').length;
  lines.push(`Flow breakdown: ${accumulating} accumulating, ${distributing} distributing, ${neutral} neutral.`);

  lines.push('');
  lines.push(`Data as of: ${data.last_updated}`);

  return lines.join('\n');
}
