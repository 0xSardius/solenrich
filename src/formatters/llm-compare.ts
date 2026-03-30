import type { TokenComparison } from '../enrichers/comparator';
import type { WalletComparison } from '../enrichers/comparator';
import { shortenAddress, formatUsd } from '../utils/normalize';

export function formatTokenComparisonBriefing(data: TokenComparison): string {
  const tokens = data.tokens;
  const names = tokens.map((t) => t.symbol || shortenAddress(t.mint)).join(' vs ');

  let out = `## Token Comparison: ${names}\n\n`;

  // Side-by-side overview
  out += '| Metric | ' + tokens.map((t) => `${t.symbol || shortenAddress(t.mint)}`).join(' | ') + ' |\n';
  out += '|--------|' + tokens.map(() => '--------|').join('') + '\n';
  out += `| Price | ${tokens.map((t) => formatUsd(t.price_usd)).join(' | ')} |\n`;
  out += `| 24h Change | ${tokens.map((t) => `${t.price_change_24h >= 0 ? '+' : ''}${t.price_change_24h.toFixed(2)}%`).join(' | ')} |\n`;
  out += `| Market Cap | ${tokens.map((t) => formatUsd(t.market_cap)).join(' | ')} |\n`;
  out += `| 24h Volume | ${tokens.map((t) => formatUsd(t.volume_24h)).join(' | ')} |\n`;
  out += `| Liquidity | ${tokens.map((t) => formatUsd(t.liquidity)).join(' | ')} |\n`;

  // Volatility
  const allVol = tokens.every((t) => t.volatility);
  if (allVol) {
    out += `| Volatility | ${tokens.map((t) => `${t.volatility!.daily_std_7d}% (${t.volatility!.classification})`).join(' | ')} |\n`;
  }

  // Concentration
  const allConc = tokens.every((t) => t.concentration);
  if (allConc) {
    out += `| HHI | ${tokens.map((t) => `${t.concentration!.herfindahl_index}`).join(' | ')} |\n`;
    out += `| Top Holder | ${tokens.map((t) => `${t.concentration!.top1_pct.toFixed(1)}%`).join(' | ')} |\n`;
  }

  out += `| Risk Flags | ${tokens.map((t) => t.risk_flags.length === 0 ? 'None' : t.risk_flags.join(', ')).join(' | ')} |\n`;
  out += `| Verified | ${tokens.map((t) => t.verified ? 'Yes' : 'No').join(' | ')} |\n`;

  // Rankings
  out += '\n### Rankings\n';
  for (const r of data.rankings) {
    const winnerToken = tokens.find((t) => t.mint === r.winner);
    const label = winnerToken?.symbol || shortenAddress(r.winner);
    out += `- **${r.metric.replace(/_/g, ' ')}**: ${label} leads (${r.values[r.winner]})\n`;
  }

  // Summary
  out += '\n### Summary\n';
  const s = data.summary;
  const nameOf = (mint: string) => tokens.find((t) => t.mint === mint)?.symbol || shortenAddress(mint);
  out += `- Safest: **${nameOf(s.safest)}**\n`;
  out += `- Most liquid: **${nameOf(s.most_liquid)}**\n`;
  out += `- Best distributed: **${nameOf(s.best_distributed)}**\n`;
  if (s.lowest_volatility) out += `- Lowest volatility: **${nameOf(s.lowest_volatility)}**\n`;

  out += `\nData as of: ${data.last_updated}`;
  return out;
}

export function formatWalletComparisonBriefing(data: WalletComparison): string {
  const wallets = data.wallets;
  const names = wallets.map((w) => shortenAddress(w.address)).join(' vs ');

  let out = `## Wallet Comparison: ${names}\n\n`;

  // Side-by-side overview
  out += '| Metric | ' + wallets.map((w) => shortenAddress(w.address)).join(' | ') + ' |\n';
  out += '|--------|' + wallets.map(() => '--------|').join('') + '\n';
  out += `| SOL Balance | ${wallets.map((w) => `${w.sol_balance.toFixed(2)} SOL`).join(' | ')} |\n`;
  out += `| Portfolio Value | ${wallets.map((w) => formatUsd(w.portfolio_value_usd)).join(' | ')} |\n`;
  out += `| Token Count | ${wallets.map((w) => `${w.token_count}`).join(' | ')} |\n`;
  out += `| NFTs | ${wallets.map((w) => `${w.nft_count}`).join(' | ')} |\n`;
  out += `| Txs (30d) | ${wallets.map((w) => `${w.tx_count_30d}`).join(' | ')} |\n`;
  out += `| Risk | ${wallets.map((w) => `${w.risk_score.toFixed(2)} (${w.risk_level})`).join(' | ')} |\n`;
  out += `| Labels | ${wallets.map((w) => w.labels.length === 0 ? 'None' : w.labels.join(', ')).join(' | ')} |\n`;

  if (wallets.some((w) => w.first_tx_date)) {
    out += `| First Tx | ${wallets.map((w) => w.first_tx_date ? w.first_tx_date.split('T')[0] : 'Unknown').join(' | ')} |\n`;
  }

  // Rankings
  out += '\n### Rankings\n';
  for (const r of data.rankings) {
    out += `- **${r.metric.replace(/_/g, ' ')}**: ${shortenAddress(r.winner)} leads (${r.values[r.winner]})\n`;
  }

  // Summary
  out += '\n### Summary\n';
  const s = data.summary;
  out += `- Highest value: **${shortenAddress(s.highest_value)}**\n`;
  out += `- Most active: **${shortenAddress(s.most_active)}**\n`;
  out += `- Lowest risk: **${shortenAddress(s.lowest_risk)}**\n`;
  if (s.oldest) out += `- Oldest: **${shortenAddress(s.oldest)}**\n`;

  out += `\nData as of: ${data.last_updated}`;
  return out;
}
