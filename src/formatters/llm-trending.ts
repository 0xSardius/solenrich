import type { TrendingSignalsResult } from '../enrichers/trending-signals';
import { formatUsd, formatNumber } from '../utils/normalize';

export function formatTrendingBriefing(data: TrendingSignalsResult): string {
  const lines: string[] = [];

  lines.push('## Trending Signals — What\'s Worth Paying Attention To');
  lines.push('');

  if (data.tokens.length === 0) {
    lines.push('No tokens passed the current filters.');
    lines.push(`Scanned ${data.total_scanned} candidates from DexScreener trending. Try loosening filters (lower min_liquidity_usd, raise max_risk_score).`);
    lines.push('');
    lines.push(`Data as of: ${data.last_updated}`);
    return lines.join('\n');
  }

  lines.push(
    `Ranked top ${data.tokens.length} from ${data.total_scanned} candidates. Whale sentiment overall: **${data.overall_sentiment}**.`,
  );
  lines.push('');

  lines.push('| # | Token | Signal | Risk | Liq | Whale Flow | Reasoning |');
  lines.push('|---|-------|--------|------|-----|------------|-----------|');

  for (let i = 0; i < data.tokens.length; i++) {
    const t = data.tokens[i];
    const whale = t.whale_net_flow
      ? `${t.whale_count ?? 0} ${t.whale_net_flow}`
      : '—';
    const reason = t.reasoning.slice(0, 3).join('; ');
    lines.push(
      `| ${i + 1} | ${t.symbol} (${t.recommendation}) | ${t.composite_signal.toFixed(2)} | ${t.risk_level} | ${formatUsd(t.liquidity)} | ${whale} | ${reason} |`,
    );
  }

  lines.push('');
  lines.push('### Interpretation');
  lines.push(
    'Composite signal blends risk score (40%), liquidity (20%), holder concentration (15%), and whale flow (25%). Higher = worth deeper investigation. `recommendation` is SAFE/CAUTION/RISKY from the underlying token analysis, independent of trending rank.',
  );
  lines.push('');

  if (data.tokens[0]) {
    const top = data.tokens[0];
    lines.push(`**Top pick:** ${top.symbol} at ${formatUsd(top.price_usd)}. ${top.reasoning.join('. ')}. `);
    if (top.whale_net_flow === 'accumulating') {
      lines.push(`Whales are accumulating (~${formatUsd(top.total_whale_volume_usd ?? 0)} net buy volume) — supply pressure is to the upside.`);
    } else if (top.whale_net_flow === 'distributing') {
      lines.push(`⚠ Whales are distributing — treat trending signal with caution.`);
    }
    lines.push('');
  }

  lines.push(`Data as of: ${data.last_updated}`);
  return lines.join('\n');
}
