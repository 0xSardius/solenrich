import type { DueDiligenceEnrichment } from '../enrichers/due-diligence';
import { formatUsd, formatNumber, formatPercent, shortenAddress } from '../utils/normalize';

function priceDirection(change: number): string {
  if (change > 0) return `up ${change.toFixed(2)}%`;
  if (change < 0) return `down ${Math.abs(change).toFixed(2)}%`;
  return 'flat';
}

export function formatDueDiligenceBriefing(data: DueDiligenceEnrichment): string {
  const lines: string[] = [];
  const t = data.token;

  lines.push(`## Due Diligence: ${t.symbol} (${t.name})`);
  lines.push('');

  // Token basics
  lines.push('### Token Overview');
  lines.push(
    `${t.symbol} is trading at ${formatUsd(t.price_usd)} (${priceDirection(t.price_change_24h)} 24h). Market cap: ${formatUsd(t.market_cap)}. 24h volume: ${formatUsd(t.volume_24h)}. ${formatNumber(t.holder_count)} holders.`,
  );
  lines.push('');

  // Security
  lines.push('### Security Assessment');
  if (t.verified) {
    lines.push('Verified on Jupiter.');
  } else {
    lines.push('Not verified on Jupiter — exercise caution.');
  }
  if (t.risk_flags.length > 0) {
    lines.push(`Risk flags: ${t.risk_flags.join(', ')}.`);
  } else {
    lines.push('No risk flags identified.');
  }
  lines.push('');

  // Whale activity
  lines.push('### Whale Activity (72h)');
  if (data.whales.whale_count > 0) {
    lines.push(
      `${data.whales.whale_count} whale(s) detected. Total volume: ${formatUsd(data.whales.total_whale_volume_usd)}. Net flow: **${data.whales.net_flow_direction}**.`,
    );
  } else {
    lines.push('No significant whale activity detected.');
  }
  lines.push('');

  // Holder concentration
  lines.push('### Holder Concentration');
  lines.push(
    `Top 10 holders: ${formatPercent(data.holder_concentration.top_10_percent)}. Top 50 holders: ${formatPercent(data.holder_concentration.top_50_percent)}. Risk: **${data.holder_concentration.risk_level}**.`,
  );

  if (data.top_holders.length > 0) {
    const topHolder = data.top_holders[0];
    lines.push(`Largest holder (${shortenAddress(topHolder.address)}) controls ${formatPercent(topHolder.percentage)}.`);
  }
  lines.push('');

  // Verdict
  lines.push('### Verdict');
  lines.push(
    `Overall risk score: ${(data.overall_risk_score * 100).toFixed(0)}/100. Recommendation: **${data.recommendation}**.`,
  );

  const risks: string[] = [];
  if (!t.verified) risks.push('unverified token');
  if (data.holder_concentration.risk_level === 'high') risks.push('high holder concentration');
  if (data.whales.net_flow_direction === 'distributing') risks.push('whale distribution detected');
  if (t.risk_flags.length > 0) risks.push(`${t.risk_flags.length} risk flag(s)`);

  if (risks.length > 0) {
    lines.push(`Key risks: ${risks.join(', ')}.`);
  } else {
    lines.push('No significant risks identified.');
  }

  lines.push('');
  lines.push(`Data as of: ${data.last_updated}`);

  return lines.join('\n');
}
