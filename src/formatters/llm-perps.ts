import type {
  EnrichedMarketStructure,
  EnrichedMarketSnapshot,
  EnrichedTraderProfile,
} from '../enrichers/perps-analyzer';
import { formatUsd, formatPercent, shortenAddress } from '../utils/normalize';

function skewLabel(longPct: number): string {
  if (longPct >= 75) return `long-heavy (${longPct.toFixed(0)}% long)`;
  if (longPct <= 25) return `short-heavy (${(100 - longPct).toFixed(0)}% short)`;
  if (longPct >= 60) return `long-tilted (${longPct.toFixed(0)}% long)`;
  if (longPct <= 40) return `short-tilted (${(100 - longPct).toFixed(0)}% short)`;
  return `balanced (${longPct.toFixed(0)}% long / ${(100 - longPct).toFixed(0)}% short)`;
}

function marketLine(m: EnrichedMarketSnapshot): string {
  const mark = m.mark_price_usd !== null ? `$${m.mark_price_usd.toFixed(2)}` : 'unknown';
  return `${m.symbol} @ ${mark} — ${skewLabel(m.open_interest.long_pct)}. OI: ${formatUsd(m.open_interest.total_usd)}. Util: ${m.utilization_pct.toFixed(1)}%. Borrow: ${m.borrow_rate.annualized_pct.toFixed(1)}% APR (${m.borrow_rate.hourly_pct.toFixed(4)}%/hr). Health: ${m.health}.`;
}

export function formatPerpsMarketBriefing(data: EnrichedMarketStructure): string {
  const lines: string[] = [];

  lines.push(`## Jupiter Perps Market Structure`);
  lines.push('');
  lines.push(
    `Pool: JLP. Total OI: ${formatUsd(data.totals.total_oi_usd)} (${formatUsd(data.totals.long_oi_usd)} long / ${formatUsd(data.totals.short_oi_usd)} short). Net skew: ${data.totals.net_skew}. Overall health: ${data.overall_health}.`,
  );
  lines.push('');

  lines.push('### Markets');
  for (const m of data.markets) {
    lines.push(`- ${marketLine(m)}`);
    if (m.long_headroom_usd > 0 || m.short_headroom_usd > 0) {
      lines.push(
        `  Headroom: ${formatUsd(m.long_headroom_usd)} long / ${formatUsd(m.short_headroom_usd)} short.`,
      );
    }
  }
  lines.push('');

  if (data.summary_notes.length > 0) {
    lines.push('### Signals');
    for (const note of data.summary_notes) lines.push(`- ${note}`);
    lines.push('');
  }

  lines.push('### Context');
  lines.push(
    'Jupiter Perps uses borrow fees (no funding rate). Rates compound hourly off utilization via jump-rate curve. High utilization + extreme skew signal crowded positioning.',
  );

  return lines.join('\n');
}

function renderPositionLine(p: EnrichedTraderProfile['positions'][number]): string[] {
  const out: string[] = [];
  const pnlPosStr =
    p.unrealized_pnl_usd !== null
      ? `${p.unrealized_pnl_usd >= 0 ? '+' : ''}${formatUsd(p.unrealized_pnl_usd)}${p.unrealized_pnl_pct !== null ? ` (${p.unrealized_pnl_pct >= 0 ? '+' : ''}${p.unrealized_pnl_pct.toFixed(1)}%)` : ''}`
      : 'n/a';
  const ageStr =
    p.age_hours < 24 ? `${p.age_hours.toFixed(1)}h` : `${(p.age_hours / 24).toFixed(1)}d`;
  out.push(
    `- ${p.market_symbol} ${p.side.toUpperCase()} ${formatUsd(p.size_usd)} @ $${p.entry_price_usd.toFixed(2)} (${p.leverage.toFixed(1)}x). uPnL: ${pnlPosStr}. Age: ${ageStr}.`,
  );
  const posFlags: string[] = [];
  if (p.flags.extreme_leverage) posFlags.push('extreme_leverage');
  else if (p.flags.high_leverage) posFlags.push('high_leverage');
  if (p.flags.approaching_liquidation) posFlags.push('approaching_liquidation');
  else if (p.flags.losing_collateral) posFlags.push('losing_collateral');
  if (p.flags.stale_position) posFlags.push('stale');
  if (posFlags.length > 0) out.push(`  ⚠ ${posFlags.join(', ')}`);
  return out;
}

export function formatPerpsTraderBriefing(data: EnrichedTraderProfile): string {
  const lines: string[] = [];

  lines.push(`## Perps Trader: ${shortenAddress(data.address)}`);
  lines.push('');

  if (!data.has_positions) {
    lines.push('No open positions on Jupiter Perps or Adrena.');
    return lines.join('\n');
  }

  const pnl = data.totals.total_unrealized_pnl_usd;
  const pnlPct = data.totals.net_pnl_pct;
  const pnlStr =
    pnlPct !== null
      ? `${pnl >= 0 ? '+' : ''}${formatUsd(pnl)} (${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% on collateral)`
      : `${pnl >= 0 ? '+' : ''}${formatUsd(pnl)}`;

  const venueList: string[] = [];
  if (data.by_venue.jupiter.has_positions) venueList.push(`Jupiter (${data.by_venue.jupiter.positions.length})`);
  if (data.by_venue.adrena.has_positions) venueList.push(`Adrena (${data.by_venue.adrena.positions.length})`);

  lines.push(
    `${data.positions.length} open position${data.positions.length === 1 ? '' : 's'} across ${venueList.join(' + ')}. Profile: ${data.profile.replace('_', ' ')}. Directional bias: ${data.directional_bias}.`,
  );
  lines.push(
    `Combined gross exposure: ${formatUsd(data.totals.gross_exposure_usd)}. Net exposure: ${data.totals.net_exposure_usd >= 0 ? '+' : ''}${formatUsd(data.totals.net_exposure_usd)}. Collateral: ${formatUsd(data.totals.total_collateral_usd)}. Unrealized PnL: ${pnlStr}. Weighted leverage: ${data.totals.weighted_leverage.toFixed(2)}x.`,
  );
  lines.push('');

  // Per-venue sections (only show venues with positions)
  for (const venue of ['jupiter', 'adrena'] as const) {
    const v = data.by_venue[venue];
    if (!v.has_positions) continue;
    const venueLabel = venue === 'jupiter' ? 'Jupiter Perps' : 'Adrena';
    lines.push(`### ${venueLabel} positions (${v.positions.length})`);
    const venuePnl = v.totals.total_unrealized_pnl_usd;
    const venuePnlPct = v.totals.net_pnl_pct;
    const venuePnlStr =
      venuePnlPct !== null
        ? `${venuePnl >= 0 ? '+' : ''}${formatUsd(venuePnl)} (${venuePnl >= 0 ? '+' : ''}${venuePnlPct.toFixed(2)}%)`
        : `${venuePnl >= 0 ? '+' : ''}${formatUsd(venuePnl)}`;
    lines.push(
      `Gross ${formatUsd(v.totals.gross_exposure_usd)} · Collateral ${formatUsd(v.totals.total_collateral_usd)} · uPnL ${venuePnlStr} · Weighted leverage ${v.totals.weighted_leverage.toFixed(2)}x`,
    );
    for (const p of v.positions) {
      for (const line of renderPositionLine(p)) lines.push(line);
    }
    for (const note of v.notes) lines.push(`  _Note: ${note}_`);
    if (venue === 'adrena' && v.positions.some(p => p.unrealized_pnl_pct !== null && p.unrealized_pnl_pct <= -100)) {
      lines.push('  _Note: Adrena PnL is a price-delta estimate. Positions showing < -100% likely accrued borrow fees or had collateral added/removed — true PnL requires Adrena\'s position-accounting math (not yet modeled here)._');
    }
    lines.push('');
  }

  const accFlags: string[] = [];
  if (data.flags.any_near_liquidation) accFlags.push('has position approaching liquidation');
  if (data.flags.any_high_leverage) accFlags.push('high leverage in use');
  if (data.flags.concentrated_market) accFlags.push(`>80% concentrated in ${data.flags.concentrated_market}`);
  if (data.flags.multi_venue) accFlags.push('multi-venue exposure (Jupiter + Adrena)');
  if (accFlags.length > 0) {
    lines.push('### Risk Flags');
    for (const f of accFlags) lines.push(`- ${f}`);
  }

  return lines.join('\n');
}
