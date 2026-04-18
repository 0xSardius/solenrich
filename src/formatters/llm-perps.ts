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

export function formatPerpsTraderBriefing(data: EnrichedTraderProfile): string {
  const lines: string[] = [];

  lines.push(`## Jupiter Perps Trader: ${shortenAddress(data.address)}`);
  lines.push('');

  if (!data.has_positions) {
    lines.push('No open positions on Jupiter Perps.');
    return lines.join('\n');
  }

  const pnl = data.totals.total_unrealized_pnl_usd;
  const pnlPct = data.totals.net_pnl_pct;
  const pnlStr =
    pnlPct !== null
      ? `${pnl >= 0 ? '+' : ''}${formatUsd(pnl)} (${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(2)}% on collateral)`
      : `${pnl >= 0 ? '+' : ''}${formatUsd(pnl)}`;

  lines.push(
    `${data.positions.length} open position${data.positions.length === 1 ? '' : 's'}. Profile: ${data.profile.replace('_', ' ')}. Directional bias: ${data.directional_bias}.`,
  );
  lines.push(
    `Gross exposure: ${formatUsd(data.totals.gross_exposure_usd)}. Net exposure: ${data.totals.net_exposure_usd >= 0 ? '+' : ''}${formatUsd(data.totals.net_exposure_usd)}. Collateral: ${formatUsd(data.totals.total_collateral_usd)}. Unrealized PnL: ${pnlStr}. Weighted leverage: ${data.totals.weighted_leverage.toFixed(2)}x.`,
  );
  lines.push('');

  lines.push('### Open Positions');
  for (const p of data.positions) {
    const pnlPosStr =
      p.unrealized_pnl_usd !== null
        ? `${p.unrealized_pnl_usd >= 0 ? '+' : ''}${formatUsd(p.unrealized_pnl_usd)}${p.unrealized_pnl_pct !== null ? ` (${p.unrealized_pnl_pct >= 0 ? '+' : ''}${p.unrealized_pnl_pct.toFixed(1)}%)` : ''}`
        : 'n/a';
    const ageStr =
      p.age_hours < 24
        ? `${p.age_hours.toFixed(1)}h`
        : `${(p.age_hours / 24).toFixed(1)}d`;
    lines.push(
      `- ${p.market_symbol} ${p.side.toUpperCase()} ${formatUsd(p.size_usd)} @ $${p.entry_price_usd.toFixed(2)} (${p.leverage.toFixed(1)}x). uPnL: ${pnlPosStr}. Age: ${ageStr}.`,
    );
    const posFlags: string[] = [];
    if (p.flags.extreme_leverage) posFlags.push('extreme_leverage');
    else if (p.flags.high_leverage) posFlags.push('high_leverage');
    if (p.flags.approaching_liquidation) posFlags.push('approaching_liquidation');
    else if (p.flags.losing_collateral) posFlags.push('losing_collateral');
    if (p.flags.stale_position) posFlags.push('stale');
    if (posFlags.length > 0) lines.push(`  ⚠ ${posFlags.join(', ')}`);
  }
  lines.push('');

  const accFlags: string[] = [];
  if (data.flags.any_near_liquidation) accFlags.push('has position approaching liquidation');
  if (data.flags.any_high_leverage) accFlags.push('high leverage in use');
  if (data.flags.concentrated_market) accFlags.push(`>80% concentrated in ${data.flags.concentrated_market}`);
  if (accFlags.length > 0) {
    lines.push('### Risk Flags');
    for (const f of accFlags) lines.push(`- ${f}`);
  }

  return lines.join('\n');
}
