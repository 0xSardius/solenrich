import type { CrossVenueFunding, VenueQuote } from '../enrichers/perps-cross-venue';
import { formatUsd } from '../utils/normalize';

const VENUE_LABEL: Record<string, string> = {
  'jupiter-perps': 'Jupiter Perps',
  'adrena': 'Adrena',
  'hyperliquid': 'Hyperliquid',
  'dydx-v4': 'dYdX v4',
};

function fmtApr(n: number | null): string {
  if (n === null) return 'n/a';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}% APR`;
}

function venueLine(v: VenueQuote): string {
  const label = VENUE_LABEL[v.venue] ?? v.venue;
  if (!v.available) {
    return `- ${label}: unavailable — ${v.unavailable_reason ?? 'no data'}.`;
  }
  const parts: string[] = [`- ${label}`];
  if (v.type === 'solana-onchain') {
    parts.push(`borrow ${fmtApr(v.borrow_apr_long)} (long/short paid)`);
  } else {
    parts.push(`funding long ${fmtApr(v.borrow_apr_long)} / short ${fmtApr(v.borrow_apr_short)}`);
  }
  if (v.open_interest_usd !== null) parts.push(`OI ${formatUsd(v.open_interest_usd)}`);
  if (v.utilization_pct !== null) parts.push(`util ${v.utilization_pct.toFixed(1)}%`);
  if (v.skew !== 'unknown') parts.push(`skew ${v.skew}`);
  let line = parts.join(' — ');
  if (v.notes?.length) line += ` (${v.notes.join('; ')})`;
  return line;
}

export function formatCrossVenueFundingBriefing(data: CrossVenueFunding): string {
  const lines: string[] = [];
  lines.push(`## ${data.market}-PERP Cross-Venue Funding`);
  lines.push('');

  lines.push('### Venues');
  for (const v of data.venues) lines.push(venueLine(v));
  lines.push('');

  lines.push('### Best Entry (Solana venues)');
  const long = data.best_entry.long;
  const short = data.best_entry.short;
  lines.push(`- LONG: ${long.venue ? VENUE_LABEL[long.venue] ?? long.venue : 'none available'} — ${long.reasoning}`);
  lines.push(`- SHORT: ${short.venue ? VENUE_LABEL[short.venue] ?? short.venue : 'none available'} — ${short.reasoning}`);
  lines.push('');

  if (data.basis.summary) {
    lines.push('### Basis vs Hyperliquid');
    lines.push(data.basis.summary);
    lines.push('');
  }

  if (data.arbitrage_opportunities.length > 0) {
    lines.push('### Arbitrage Opportunities');
    for (const a of data.arbitrage_opportunities) {
      lines.push(`- ${a.description}`);
    }
    lines.push('');
  }

  lines.push('### Notes');
  lines.push(
    `Solana venues quote borrow APR (utilization-based, paid by both sides). Reference venues quote funding rate (longs pay shorts when positive). Reference rates are cross-chain context — to capture them, position must be opened on the reference venue itself.`,
  );
  if (data.market === 'ETH') {
    lines.push(`Note: Adrena has no ETH custody on mainnet. Jupiter Perps is the only Solana venue for ${data.market}.`);
  }
  if (data.market === 'BONK') {
    lines.push(`Note: BONK is not tradable on Jupiter Perps (only SOL/BTC/ETH). Adrena is the only Solana venue for BONK.`);
  }
  if (data.market === 'SOL' || data.market === 'BTC') {
    lines.push(`Note: Adrena routes ${data.market} exposure through wrapped collateral (${data.market === 'SOL' ? 'jitoSOL' : 'WBTC'}), not native ${data.market}.`);
  }

  return lines.join('\n');
}
