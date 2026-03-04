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
    `Market cap: ${formatUsd(data.market_cap)}. 24h volume: ${formatUsd(data.volume_24h)}. ${formatNumber(data.holder_count)} holders.`,
  );
  lines.push('');

  // Liquidity
  const assessment = liquidityAssessment(data.liquidity, data.market_cap);
  lines.push(`Liquidity: ${formatUsd(data.liquidity)}. ${assessment} relative to market cap.`);
  lines.push('');

  // Holders
  if (data.top_holders && data.top_holders.length > 0 && data.top_holders[0].pct_supply != null) {
    lines.push(`Top holder controls ${data.top_holders[0].pct_supply.toFixed(1)}% of supply.`);
  } else {
    lines.push('Holder distribution data not available.');
  }

  // Verification
  if (data.verified) {
    lines.push('Verified on Jupiter.');
  } else {
    lines.push('Not verified on Jupiter -- exercise caution.');
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
