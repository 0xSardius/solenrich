import type { TokenEnrichment } from '../enrichers/token-analyzer';
import { formatUsd, formatNumber } from '../utils/normalize';

function liquidityAssessment(liquidity: number, marketCap: number): string {
  if (marketCap <= 0) return 'Unknown';
  const ratio = liquidity / marketCap;
  if (ratio > 0.1) return 'Deep';
  if (ratio > 0.03) return 'Moderate';
  return 'Thin';
}

function priceDirection(change: number): string {
  if (change > 0) return `↑ ${change.toFixed(2)}%`;
  if (change < 0) return `↓ ${Math.abs(change).toFixed(2)}%`;
  return '→ 0.00%';
}

export function formatTokenBriefing(data: TokenEnrichment): string {
  const lines: string[] = [];

  lines.push(`## Token: ${data.symbol} (${data.name})`);
  lines.push('');

  // Price and market data
  lines.push(
    `Solana SPL token. Price: ${formatUsd(data.price_usd)} (${priceDirection(data.price_change_24h)} 24h).`,
  );
  lines.push(
    `Market cap: ${formatUsd(data.market_cap)}. 24h volume: ${formatUsd(data.volume_24h)}.`,
  );
  lines.push('');

  // Liquidity
  const assessment = liquidityAssessment(data.liquidity, data.market_cap);
  lines.push(`Liquidity: ${formatUsd(data.liquidity)}. ${assessment} relative to market cap.`);
  lines.push('');

  // Holder concentration
  if (data.concentration) {
    lines.push('### Holder Concentration');
    lines.push(`Top holder: ${data.concentration.top1_pct.toFixed(1)}% of supply. Top 5: ${data.concentration.top5_pct.toFixed(1)}%. Top 10: ${data.concentration.top10_pct.toFixed(1)}%.`);
    if (data.concentration.top1_pct > 50) {
      lines.push('⚠ Single holder controls majority of supply.');
    } else if (data.concentration.top5_pct > 80) {
      lines.push('⚠ Supply highly concentrated among top 5 holders.');
    }
    if (data.top_holders && data.top_holders.length > 0) {
      const top3 = data.top_holders.slice(0, 3);
      for (const h of top3) {
        lines.push(`  - ${h.address.slice(0, 8)}...${h.address.slice(-4)}: ${h.pct_supply.toFixed(1)}% (${formatNumber(h.balance)} tokens)`);
      }
    }
    lines.push('');
  } else {
    lines.push('Holder distribution data not available.');
    lines.push('');
  }

  // Verification
  if (data.verified) {
    lines.push('Verified on Jupiter.');
  } else {
    lines.push('Not verified on Jupiter -- exercise caution.');
  }

  // Authorities
  if (data.mint_authority || data.freeze_authority) {
    const authorities: string[] = [];
    if (data.mint_authority) authorities.push('mint authority active');
    if (data.freeze_authority) authorities.push('freeze authority active');
    lines.push(`Authorities: ${authorities.join(', ')}.`);
  }
  lines.push('');

  // Risk flags
  if (data.risk_flags.length > 0) {
    lines.push(`Risk flags: ${data.risk_flags.join(', ')}.`);
  } else {
    lines.push('Risk flags: None identified.');
  }

  lines.push('');
  lines.push(`Data as of: ${data.last_updated}`);

  return lines.join('\n');
}
