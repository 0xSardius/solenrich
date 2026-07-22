import type { GachaEvScan, GachaMachineVerdict } from '../enrichers/gacha-analyzer';
import { formatUsd } from '../utils/normalize';

const VERDICT_LABEL: Record<string, string> = {
  POSITIVE_EV: '🟢 POSITIVE EV',
  HOUSE_EDGE: '🟡 HOUSE EDGE',
  NEGATIVE_EV: '🔴 NEGATIVE EV',
};

function sign(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
}

function machineLine(v: GachaMachineVerdict): string {
  return (
    `- **${v.name}** (${v.code}) — ${VERDICT_LABEL[v.verdict] ?? v.verdict}\n` +
    `  price ${formatUsd(v.price)} · gross EV ${formatUsd(v.gross_ev)} (${sign(v.gross_edge_pct)})\n` +
    `  guaranteed buyback @ ${v.buyback.payout_pct}% → ${formatUsd(v.buyback.net_ev)} (${sign(v.buyback.edge_pct)}) · ` +
    `marketplace −${v.marketplace.fee_pct}% → ${formatUsd(v.marketplace.net_ev)} (${sign(v.marketplace.edge_pct)})\n` +
    `  rare+epic stock share ${(v.high_tier_stock_share * 100).toFixed(1)}%`
  );
}

export function formatGachaScanBriefing(data: GachaEvScan): string {
  const lines: string[] = [];
  lines.push('## Jupiter Gacha — Pack EV Scan');
  lines.push(
    `Scanned ${data.machine_count} machine${data.machine_count === 1 ? '' : 's'}` +
      `${data.franchise !== 'all' ? ` (${data.franchise})` : ''}, ranked by ${data.exit_strategy} exit edge.`,
  );
  lines.push('');

  if (data.best) {
    const b = data.best;
    const leg = data.exit_strategy === 'buyback' ? b.buyback : b.marketplace;
    lines.push(
      `**Best (${data.exit_strategy} exit):** ${b.name} — ${sign(leg.edge_pct)} net edge, ${VERDICT_LABEL[b.verdict] ?? b.verdict}.`,
    );
    lines.push('');
  }

  lines.push(
    `**Read:** ${data.summary.positive_ev_count} positive-EV, ` +
      `${data.summary.house_edge_count} house-edge, ${data.summary.negative_ev_count} negative-EV.`,
  );
  lines.push('');

  lines.push('### Machines');
  if (data.machines.length === 0) {
    lines.push('_No machines matched the filter._');
  } else {
    for (const v of data.machines) lines.push(machineLine(v));
  }
  lines.push('');

  lines.push('### How to read this');
  lines.push(data.summary.note);

  return lines.join('\n');
}
