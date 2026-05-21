import type { PerpsBasisSignal, BasisVenueRow } from '../enrichers/perps-basis-signal';

const VENUE_LABEL: Record<string, string> = {
  'jupiter-perps': 'Jupiter Perps',
  'adrena': 'Adrena',
  'hyperliquid': 'Hyperliquid',
  'dydx-v4': 'dYdX v4',
};

function venueLine(v: BasisVenueRow): string {
  const label = VENUE_LABEL[v.venue] ?? v.venue;
  if (!v.available) {
    return `- ${label}: unavailable — ${v.unavailable_reason ?? 'no data'}.`;
  }
  const parts: string[] = [
    `${label}`,
    `mark ${v.mark_price_usd !== null ? `$${v.mark_price_usd.toFixed(4)}` : 'n/a'}`,
    `basis ${v.basis_bps !== null ? `${v.basis_bps >= 0 ? '+' : ''}${v.basis_bps}bps` : 'n/a'}`,
    `rate ${v.rate_apr_pct !== null ? `${v.rate_apr_pct >= 0 ? '+' : ''}${v.rate_apr_pct.toFixed(2)}% APR` : 'n/a'} (${v.rate_mechanism})`,
  ];
  let line = `- ${parts.join(' — ')}`;
  if (v.trade.viable) {
    line += `\n  ↳ ${v.trade.direction === 'short_perp_long_spot' ? 'SHORT perp, LONG spot' : 'LONG perp, SHORT spot'} → net ${v.trade.net_yield_pct.toFixed(2)}% APR`;
  } else if (v.available) {
    line += `\n  ↳ no viable trade: ${v.trade.reasoning}`;
  }
  return line;
}

export function formatBasisSignalBriefing(data: PerpsBasisSignal): string {
  const lines: string[] = [];
  lines.push(`## ${data.asset} Basis Signal`);
  lines.push('');

  if (data.spot) {
    lines.push(
      `Spot: $${data.spot.price_usd.toFixed(4)} (${data.spot.sources} source${data.spot.sources === 1 ? '' : 's'}, ${data.spot.spread_pct.toFixed(2)}% spread).`,
    );
  } else {
    lines.push('Spot: unavailable.');
  }
  lines.push(`Yield threshold: ${data.min_yield_apr_pct}% APR.`);
  lines.push('');

  lines.push('### Venues');
  for (const v of data.venues) lines.push(venueLine(v));
  lines.push('');

  if (data.opportunities.length > 0) {
    lines.push(`### Opportunities (${data.opportunities.length})`);
    for (const o of data.opportunities) {
      const venueLabel = VENUE_LABEL[o.venue] ?? o.venue;
      const dir = o.trade.direction === 'short_perp_long_spot' ? 'short perp + long spot' : 'long perp + short spot';
      lines.push(`- ${venueLabel}: ${dir} → ${o.trade.net_yield_pct.toFixed(2)}% APR`);
    }
    lines.push('');
  }

  lines.push('### Summary');
  lines.push(data.summary);

  lines.push('');
  lines.push('### Notes');
  lines.push('Solana pool perps (Jupiter, Adrena) charge borrow APR on BOTH sides — no funding-income mechanism, so a basis trade pays continuously and is not viable on its own. Reference venues (Hyperliquid, dYdX v4) use sign-aware funding: positive funding means longs pay shorts. To actually capture the rate, position must be opened on the reference venue itself.');

  return lines.join('\n');
}
