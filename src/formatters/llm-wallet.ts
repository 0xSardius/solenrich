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
  lines.push(`Top holdings: ${holdingStrs.join(', ')}.`);
  lines.push('');

  // NFTs — report the split, not the raw count. Most non-fungibles on Solana are
  // unsolicited compressed drops, so a bare count reads as collecting activity
  // that is not there.
  const nft = data.nft_summary;
  if (nft && nft.total > 0) {
    const parts: string[] = [];
    if (nft.collected > 0) {
      parts.push(
        `${nft.collected} collected across ${nft.distinct_collections} collection${nft.distinct_collections === 1 ? '' : 's'}`,
      );
    }
    if (nft.airdropped > 0) parts.push(`${nft.airdropped} compressed airdrop${nft.airdropped === 1 ? '' : 's'}`);
    if (nft.suspected_spam > 0) parts.push(`${nft.suspected_spam} suspected spam`);

    lines.push(`NFTs: ${nft.total} total — ${parts.join(', ')}.`);

    const real = (data.nft_collections ?? []).filter((c) => !c.compressed && !c.suspected_spam);
    if (real.length > 0) {
      const named = real.slice(0, 4).map((c) => `${c.name} (${c.count})`).join(', ');
      lines.push(`Holds: ${named}.`);
    }
    if (nft.suspected_spam > 0) {
      lines.push(
        'Suspected spam is flagged from name patterns (claim bait, embedded links, invisible characters). Treat it as a signal, not a verdict.',
      );
    }
    lines.push('');
  } else if (data.nft_count > 0) {
    // Older cached payloads predate nft_summary.
    lines.push(`Holds ${data.nft_count} NFTs.`);
    lines.push('');
  }

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

  // Labels — split behavioral flags from other labels for clarity.
  // Behavioral flags are algorithmic signals from tx timing patterns, not classifications.
  const BEHAVIORAL_FLAGS = new Set([
    'regular_intervals',
    'high_frequency',
    '24_7_active',
    'repetitive_actions',
  ]);
  const behavioralFlags = data.labels.filter((l) => BEHAVIORAL_FLAGS.has(l));
  const otherLabels = data.labels.filter((l) => !BEHAVIORAL_FLAGS.has(l));

  if (otherLabels.length > 0) {
    lines.push(`Classified as: ${otherLabels.join(', ')}.`);
  }
  if (behavioralFlags.length > 0) {
    lines.push(
      `Behavioral signals (from tx timing): ${behavioralFlags.join(', ')}. These indicate automated activity patterns — interpret alongside other labels.`,
    );
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
