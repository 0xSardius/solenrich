import type { DueDiligenceEnrichment } from '../enrichers/due-diligence';
import { formatUsd } from '../utils/normalize';

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
    `${t.symbol} is trading at ${formatUsd(t.price_usd)} (${priceDirection(t.price_change_24h)} 24h). Market cap: ${formatUsd(t.market_cap)}. 24h volume: ${formatUsd(t.volume_24h)}.`,
  );
  lines.push(`Liquidity: ${formatUsd(t.liquidity)}.`);
  lines.push('');

  // Holder concentration
  if (t.concentration) {
    lines.push('### Holder Concentration');
    lines.push(`Top holder: ${t.concentration.top1_pct.toFixed(1)}% of supply. Top 5: ${t.concentration.top5_pct.toFixed(1)}%. Top 10: ${t.concentration.top10_pct.toFixed(1)}%.`);
    if (t.concentration.top1_pct > 50) {
      lines.push('⚠ Single holder controls majority of supply — high rug-pull risk.');
    } else if (t.concentration.top5_pct > 80) {
      lines.push('⚠ Supply highly concentrated among top holders.');
    } else if (t.concentration.top10_pct < 30) {
      lines.push('Supply is well-distributed across holders.');
    }
    lines.push('');
  }

  // Security
  lines.push('### Security Assessment');
  if (t.verified) {
    lines.push('Verified on Jupiter.');
  } else {
    lines.push('Not verified on Jupiter — exercise caution.');
  }
  if (t.mint_authority) {
    lines.push('Mint authority is **active** — token supply can be inflated.');
  }
  if (t.freeze_authority) {
    lines.push('Freeze authority is **active** — accounts can be frozen.');
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
      `${data.whales.whale_count} whale(s) tracked. Total volume: ${formatUsd(data.whales.total_whale_volume_usd)}. Net flow: **${data.whales.net_flow_direction}**.`,
    );
    const topWhales = data.whales.whales.slice(0, 3);
    for (const w of topWhales) {
      const activity = w.transaction_count > 0
        ? `${w.flow_direction} (${formatUsd(w.buy_volume_usd)} in, ${formatUsd(w.sell_volume_usd)} out)`
        : 'no recent activity';
      lines.push(`  - ${w.address.slice(0, 8)}...${w.address.slice(-4)}: holds ${w.pct_supply.toFixed(1)}% — ${activity}`);
    }
  } else {
    lines.push('No significant whale activity detected.');
  }
  lines.push('');

  // Verdict
  lines.push('### Verdict');
  lines.push(
    `Risk score: ${(data.overall_risk_score * 100).toFixed(0)}/100 (${data.risk_level}). Recommendation: **${data.recommendation}**.`,
  );

  if (data.risk_factors.length > 0) {
    lines.push('');
    lines.push('Key risk factors:');
    for (const factor of data.risk_factors) {
      lines.push(`  - ${factor}`);
    }
  } else {
    lines.push('No significant risks identified.');
  }

  lines.push('');
  lines.push(`Data as of: ${data.last_updated}`);

  return lines.join('\n');
}
