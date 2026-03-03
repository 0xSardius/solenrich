import type { TransactionEnrichment } from '../enrichers/tx-parser';
import { shortenAddress, formatNumber } from '../utils/normalize';

export function formatTransactionBriefing(data: TransactionEnrichment): string {
  const lines: string[] = [];

  const shortSig = shortenAddress(data.signature);
  lines.push(`## Transaction: ${shortSig}`);
  lines.push('');

  // Type and description
  let typeLine = `Type: ${data.type}. ${data.description}.`;
  lines.push(typeLine);

  let detailLine = '';
  if (data.protocol) detailLine += `Protocol: ${data.protocol}. `;
  detailLine += `Fee: ${data.fee_sol.toFixed(6)} SOL. Payer: ${shortenAddress(data.fee_payer)}.`;
  lines.push(detailLine);

  lines.push(
    `Status: ${data.success ? 'Confirmed' : 'Failed'}. Time: ${data.timestamp}.`,
  );
  lines.push('');

  // Native transfers
  if (data.native_transfers.length > 0) {
    const transfers = data.native_transfers.slice(0, 5).map(
      (t) => `${shortenAddress(t.from)} → ${shortenAddress(t.to)}: ${t.amount_sol.toFixed(4)} SOL`,
    );
    lines.push(`SOL transfers: ${transfers.join('; ')}.`);
    if (data.native_transfers.length > 5) {
      lines.push(`...and ${data.native_transfers.length - 5} more.`);
    }
  }

  // Token transfers
  if (data.token_transfers.length > 0) {
    const transfers = data.token_transfers.slice(0, 5).map((t) => {
      const label = t.symbol ?? shortenAddress(t.mint);
      return `${shortenAddress(t.from)} → ${shortenAddress(t.to)}: ${formatNumber(t.amount)} ${label}`;
    });
    lines.push(`Token transfers: ${transfers.join('; ')}.`);
    if (data.token_transfers.length > 5) {
      lines.push(`...and ${data.token_transfers.length - 5} more.`);
    }
  }

  lines.push('');
  lines.push(`${data.accounts_involved.length} accounts involved.`);
  lines.push('');
  lines.push(`Data as of: ${data.last_updated}`);

  return lines.join('\n');
}
