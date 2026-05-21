import type { PerpsVenueComparison, VenueComparisonRow } from '../enrichers/perps-venue-comparison';
import { formatUsd } from '../utils/normalize';

const VENUE_LABEL: Record<string, string> = {
  'jupiter-perps': 'Jupiter Perps',
  'adrena': 'Adrena',
  'hyperliquid': 'Hyperliquid',
  'dydx-v4': 'dYdX v4',
};

function fmtPct(n: number | null, digits = 3): string {
  if (n === null) return 'n/a';
  return `${n.toFixed(digits)}%`;
}

function venueRow(v: VenueComparisonRow, side: 'long' | 'short'): string {
  const label = VENUE_LABEL[v.venue] ?? v.venue;
  if (!v.available) {
    return `- ${label}: unavailable — ${v.unavailable_reason ?? 'no data'}.`;
  }
  const apr = side === 'long' ? v.borrow_apr_long : v.borrow_apr_short;
  const parts: string[] = [
    `${label}`,
    `entry cost ${fmtPct(v.total_entry_cost_pct)}`,
    `borrow ${fmtPct(apr, 2)} APR`,
  ];
  if (v.estimated_slippage_pct !== null) {
    parts.push(`slip ${fmtPct(v.estimated_slippage_pct)}`);
  }
  if (v.fee_pct !== null) parts.push(`fee ${fmtPct(v.fee_pct)}`);
  if (v.oi_cap_headroom_usd !== null) {
    parts.push(`headroom ${formatUsd(v.oi_cap_headroom_usd)}`);
  }
  parts.push(`health ${v.health}`);
  let line = `- ${parts.join(' — ')}`;
  if (v.flags.length > 0) line += ` ⚠ ${v.flags.join(', ')}`;
  return line;
}

export function formatVenueComparisonBriefing(data: PerpsVenueComparison): string {
  const lines: string[] = [];
  lines.push(`## ${data.market}-PERP Venue Comparison — ${formatUsd(data.size_usd)} ${data.side.toUpperCase()}`);
  lines.push('');

  if (data.spot_slippage_source === 'jupiter-quote' && data.spot_slippage_pct !== null) {
    const tier = data.spot_slippage_tier_used;
    const note = tier && data.size_usd > tier ? ` (extrapolated from $${tier.toLocaleString()} tier — underestimate)` : '';
    lines.push(`Spot slippage at ${formatUsd(data.size_usd)}: ${data.spot_slippage_pct.toFixed(3)}%${note}.`);
  } else {
    lines.push(`Spot slippage: unavailable.`);
  }
  lines.push('');

  lines.push('### Venues');
  for (const v of data.venues) lines.push(venueRow(v, data.side));
  lines.push('');

  lines.push('### Rankings (Solana venues with data)');
  const names = (ids: string[]) => ids.map((id) => VENUE_LABEL[id] ?? id).join(' → ');
  if (data.rankings.by_entry_cost.length > 0) {
    lines.push(`- By entry cost: ${names(data.rankings.by_entry_cost)}`);
  }
  if (data.rankings.by_borrow_apr.length > 0) {
    lines.push(`- By borrow APR: ${names(data.rankings.by_borrow_apr)}`);
  }
  if (data.rankings.by_headroom.length > 0) {
    lines.push(`- By headroom: ${names(data.rankings.by_headroom)}`);
  }
  lines.push('');

  lines.push('### Recommendation');
  if (data.recommendation.venue) {
    lines.push(`**${VENUE_LABEL[data.recommendation.venue] ?? data.recommendation.venue}** — ${data.recommendation.reasoning}`);
  } else {
    lines.push(data.recommendation.reasoning);
  }
  if (data.recommendation.warnings.length > 0) {
    lines.push('');
    lines.push(`⚠ ${data.recommendation.warnings.join(', ')}`);
  }

  return lines.join('\n');
}
