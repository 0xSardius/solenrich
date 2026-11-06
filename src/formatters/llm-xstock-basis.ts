import type { XstockBasisResult } from '../enrichers/xstock-basis';
import { formatUsd } from '../utils/normalize';

const VERDICT_LINE: Record<XstockBasisResult['verdict'], string> = {
  TRADE: '🟢 TRADE — current funding repays the round trip within 7 days',
  MARGINAL: '🟠 MARGINAL — payback takes 7–30 days at the current rate',
  NO_TRADE: '⚪ NO_TRADE — funding does not pay this trade at this size',
  TOO_THIN: '🟠 TOO_THIN — the size does not fit the route or the book',
  UNAVAILABLE: '⚪ UNAVAILABLE — an upstream read failed; try again in a minute',
};

const n = (v: number | null, unit = '') => (v == null ? 'n/a' : `${v}${unit}`);

export function formatXstockBasisBriefing(d: XstockBasisResult): string {
  const lines: string[] = [];
  lines.push(`## xStock Basis — ${d.xstock.symbol} vs Phoenix ${d.perp.symbol} perp at ${formatUsd(d.size_usd)}`);
  lines.push('');
  lines.push(`**${VERDICT_LINE[d.verdict]}**`);
  lines.push('');
  lines.push(d.reasoning);
  lines.push('');
  lines.push('| | Price | vs index |');
  lines.push('|---|---|---|');
  lines.push(`| ${d.xstock.symbol} (Jupiter) | ${d.xstock.price_usd != null ? formatUsd(d.xstock.price_usd) : 'n/a'} | ${n(d.basis.xstock_vs_index_bps, ' bps')} |`);
  lines.push(`| Phoenix ${d.perp.symbol} mark | ${d.perp.mark_price_usd != null ? formatUsd(d.perp.mark_price_usd) : 'n/a'} | ${n(d.basis.perp_vs_index_bps, ' bps')} |`);
  lines.push(`| Phoenix index (real share) | ${d.perp.index_price_usd != null ? formatUsd(d.perp.index_price_usd) : 'n/a'} | — |`);
  lines.push('');
  lines.push(
    `**Carry:** funding ${n(d.perp.funding_apr_pct, '% APR')} (${n(d.economics.funding_daily_bps, ' bps/day')}; positive = longs pay, so the short perp earns). ` +
      `Perp above xStock by ${n(d.basis.perp_vs_xstock_bps, ' bps')} at entry (not counted).`,
  );
  lines.push(
    `**Round trip at size:** ${n(d.economics.round_trip_cost_bps, ' bps')} = ${d.xstock.symbol} on Jupiter ${n(d.xstock.round_trip_cost_bps, ' bps')} + ` +
      `perp ${n(d.perp.round_trip_cost_bps, ' bps')} (book ${n(d.perp.entry_slippage_bps)}/${n(d.perp.exit_slippage_bps)} bps in/out, taker ${n(d.perp.taker_fee_pct, '%')} × 2).`,
  );
  lines.push(`**Breakeven:** ${n(d.economics.breakeven_days, ' days')} · net after 7 days: ${n(d.economics.net_7d_bps, ' bps')}`);
  if (d.perp.oi_cap_headroom_usd != null) lines.push(`OI ${formatUsd(d.perp.open_interest_usd ?? 0)}, cap headroom ${formatUsd(d.perp.oi_cap_headroom_usd)}.`);
  const s = d.session;
  const sessionParts: string[] = [];
  if (s.after_hours != null) sessionParts.push(s.after_hours ? 'after hours (index book-priced)' : 'regular session');
  if (s.next_transition_utc) sessionParts.push(`next session change ${s.next_transition_utc}`);
  if (s.next_earnings) sessionParts.push(`earnings ${s.next_earnings.date}${s.next_earnings.time ? ` ${s.next_earnings.time}` : ''} (in ${s.next_earnings.days_until} days)`);
  if (sessionParts.length) lines.push(`**Session:** ${sessionParts.join(' · ')}`);
  if (d.codes.length) lines.push(`Codes: ${d.codes.join(', ')}`);
  lines.push('');
  for (const c of d.caveats) lines.push(`_${c}_`);
  return lines.join('\n');
}
