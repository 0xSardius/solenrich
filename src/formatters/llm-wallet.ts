import type { WalletEnrichment } from '../enrichers/wallet-profiler';
import { shortenAddress, formatUsd, formatNumber } from '../utils/normalize';

function riskLevel(score: number): string {
  if (score < 0.2) return 'low';
  if (score < 0.5) return 'moderate';
  if (score < 0.75) return 'elevated';
  return 'high';
}

function walletAge(firstTxDate: string | null): string {
  if (!firstTxDate) return 'Unknown-age';

  const first = new Date(firstTxDate);
  const daysOld = Math.floor((Date.now() - first.getTime()) / (24 * 60 * 60 * 1000));

  if (daysOld < 30) return `New wallet (created ${daysOld} days ago)`;

  const month = first.toLocaleString('en-US', { month: 'long' });
  const year = first.getFullYear();
  return `Active since ${month} ${year}`;
}

export function formatWalletBriefing(data: WalletEnrichment): string {
  const lines: string[] = [];

  lines.push(`## Wallet Profile: ${shortenAddress(data.address)}`);
  lines.push('');

  // Overview
  const age = walletAge(data.first_tx_date);
  lines.push(
    `${age} Solana wallet. Holds ${data.sol_balance.toFixed(2)} SOL and ${data.token_count} SPL tokens.`,
  );
  lines.push(
    `Portfolio value: ~${formatUsd(data.portfolio_value_usd)} across tokens, NFTs, and DeFi positions.`,
  );
  lines.push('');

  // Top holdings
  const holdingStrs = data.top_holdings
    .slice(0, 5)
    .map((h) => `${h.symbol} (${formatUsd(h.usd_value)})`);
  let holdingsLine = `Top holdings: ${holdingStrs.join(', ')}.`;
  if (data.nft_count > 0) holdingsLine += ` Holds ${data.nft_count} NFTs.`;
  lines.push(holdingsLine);
  lines.push('');

  // DeFi positions
  if (data.defi_positions.length > 0) {
    const protocols = [...new Set(data.defi_positions.map((p) => p.protocol))];
    const totalDefi = data.defi_positions.reduce((s, p) => s + p.value_usd, 0);
    lines.push(
      `DeFi activity: ${protocols.join(', ')}` +
        (totalDefi > 0 ? ` (~${formatUsd(totalDefi)} total).` : '.'),
    );
    lines.push('');
  }

  // Labels
  if (data.labels.length > 0) {
    lines.push(`Classified as: ${data.labels.join(', ')}.`);
  }

  // Activity and risk
  const level = riskLevel(data.risk_score);
  lines.push(
    `${data.tx_count_30d} transactions in 30 days. Risk score: ${data.risk_score.toFixed(2)}/1.0 (${level}).`,
  );

  if (data.risk_factors.length > 0) {
    lines.push(`Key risk factors: ${data.risk_factors.slice(0, 3).join('; ')}.`);
  }

  if (data.connected_wallets.length > 0) {
    const labeled = data.connected_wallets.filter((w) => w.entity_label);
    const unlabeled = data.connected_wallets.length - labeled.length;
    if (labeled.length > 0) {
      const names = labeled.map((w) => `${w.entity_label} (${w.entity_type})`).join(', ');
      lines.push(`Known connections: ${names}.`);
    }
    if (unlabeled > 0) {
      lines.push(`${unlabeled} additional connected wallet(s).`);
    }
  }

  lines.push('');
  lines.push(`Data as of: ${data.last_updated}`);

  return lines.join('\n');
}
