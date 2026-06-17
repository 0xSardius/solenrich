import type { HyperliquidTraderProfile, HlAnalyzedPosition } from '../enrichers/hyperliquid-analyzer';
import { formatUsd, shortenAddress } from '../utils/normalize';

function positionLine(p: HlAnalyzedPosition): string {
  const pnlStr = `${p.unrealized_pnl_usd >= 0 ? '+' : ''}${formatUsd(p.unrealized_pnl_usd)} (${p.pnl_pct >= 0 ? '+' : ''}${p.pnl_pct.toFixed(1)}%)`;
  const liq = p.distance_to_liq_pct !== null ? `, liq ${p.distance_to_liq_pct.toFixed(1)}% away` : '';
  const tags: string[] = [];
  if (p.flags.extreme_leverage) tags.push('EXTREME LEV');
  else if (p.flags.high_leverage) tags.push('high lev');
  if (p.flags.approaching_liquidation) tags.push('NEAR LIQ');
  else if (p.flags.losing) tags.push('losing');
  const tagStr = tags.length ? `  [${tags.join(', ')}]` : '';
  return `- ${p.dir.toUpperCase()} ${p.coin} ${p.leverage}x — notional ${formatUsd(p.notional_usd)}, entry $${p.entry_px}, uPnL ${pnlStr}${liq}${tagStr}`;
}

export function formatHyperliquidTraderBriefing(data: HyperliquidTraderProfile): string {
  const lines: string[] = [];
  lines.push(`## Hyperliquid Trader: ${shortenAddress(data.address)}`);
  lines.push('');

  if (data.pnl) {
    const fmt = (v: number | null) => (v === null ? 'n/a' : `${v >= 0 ? '+' : ''}${formatUsd(v)}`);
    lines.push(
      `PnL — week ${fmt(data.pnl.week_usd)} · month ${fmt(data.pnl.month_usd)} · all-time ${fmt(data.pnl.all_time_usd)}.`,
    );
  }
  lines.push(
    `Account value: ${formatUsd(data.account.value_usd)} · withdrawable ${formatUsd(data.account.withdrawable_usd)}.`,
  );
  lines.push('');

  if (!data.has_positions) {
    lines.push('No open Hyperliquid positions.');
    return lines.join('\n');
  }

  const t = data.totals;
  lines.push(
    `${t.position_count} open position${t.position_count === 1 ? '' : 's'}. Profile: ${data.profile.replace(/_/g, ' ')}. Directional bias: ${data.directional_bias}.`,
  );
  lines.push(
    `Gross notional ${formatUsd(t.gross_notional_usd)} · net ${t.net_notional_usd >= 0 ? '+' : ''}${formatUsd(t.net_notional_usd)} · uPnL ${t.total_unrealized_pnl_usd >= 0 ? '+' : ''}${formatUsd(t.total_unrealized_pnl_usd)} · weighted leverage ${t.weighted_leverage.toFixed(1)}x.`,
  );
  lines.push('');
  lines.push('### Positions');
  for (const p of data.positions) lines.push(positionLine(p));

  const flags: string[] = [];
  if (data.flags.any_near_liquidation) flags.push('has position approaching liquidation');
  if (data.flags.any_high_leverage) flags.push('high leverage in use');
  if (data.flags.concentrated_coin) flags.push(`>80% concentrated in ${data.flags.concentrated_coin}`);
  if (flags.length) {
    lines.push('');
    lines.push('### Risk Flags');
    for (const f of flags) lines.push(`- ${f}`);
  }

  return lines.join('\n');
}
