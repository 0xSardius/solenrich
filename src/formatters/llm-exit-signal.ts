import type { ExitSignalResult } from '../enrichers/exit-analyzer';
import { shortenAddress, formatUsd } from '../utils/normalize';

const VERDICT_LINE: Record<ExitSignalResult['verdict'], string> = {
  EXIT: '🔴 EXIT — the tape says get out',
  DERISK: '🟠 DERISK — reduce the position, momentum is deteriorating',
  HOLD: '🟢 HOLD — no exit case in the current tape',
  INSUFFICIENT_DATA: '⚪ INSUFFICIENT DATA — no basis for a call either way',
};

export function formatExitSignalBriefing(data: ExitSignalResult): string {
  const lines: string[] = [];
  const name = data.symbol ? `$${data.symbol}` : shortenAddress(data.mint);

  lines.push(`## Exit Signal — ${name} (${shortenAddress(data.mint)})`);
  lines.push('');
  lines.push(`**${VERDICT_LINE[data.verdict]}** | exit score ${data.exit_score}`);
  lines.push('');

  const facts: string[] = [];
  if (data.price_usd != null) facts.push(`price ${formatUsd(data.price_usd)}`);
  if (data.price_change_h1_pct != null) facts.push(`1h ${data.price_change_h1_pct > 0 ? '+' : ''}${data.price_change_h1_pct}%`);
  if (data.price_change_h24_pct != null) facts.push(`24h ${data.price_change_h24_pct > 0 ? '+' : ''}${data.price_change_h24_pct}%`);
  if (data.liquidity_usd != null) facts.push(`liquidity ${formatUsd(data.liquidity_usd)}`);
  if (facts.length > 0) lines.push(facts.join(' | '));

  if (data.position) {
    const pnl = data.position.unrealized_pnl_pct;
    lines.push(
      `Position: entry ${formatUsd(data.position.entry_price_usd)}` +
        (pnl != null ? ` → unrealized ${pnl > 0 ? '+' : ''}${pnl}%` : ' (current price unavailable, PnL unknown)'),
    );
    if (pnl != null && pnl > 0 && (data.verdict === 'DERISK' || data.verdict === 'EXIT')) {
      lines.push(`_Exiting here locks in ${pnl > 0 ? '+' : ''}${pnl}%._`);
    }
  }

  lines.push('');
  lines.push(`**Read:** ${data.reasoning}`);

  if (data.buys_h1 != null && data.sells_h1 != null) {
    lines.push('');
    lines.push(`### 📉 Tape (1h)`);
    lines.push(`${data.buys_h1} buys / ${data.sells_h1} sells`);
    const m = data.metrics;
    const tape: string[] = [];
    if (m.sell_pressure_h1 != null) tape.push(`sell share ${(m.sell_pressure_h1 * 100).toFixed(0)}%`);
    if (m.buy_rate_decel_m5_h1 != null) tape.push(`5m buy pace ${m.buy_rate_decel_m5_h1}× hourly`);
    if (m.volume_decel != null) tape.push(`volume ${m.volume_decel}× 6h pace`);
    if (tape.length > 0) lines.push(tape.join(' | '));
  }

  if (data.whales) {
    const w = data.whales;
    lines.push('');
    lines.push(`### 🐋 Top-holder flow (${w.lookback_hours}h) — ${w.net_flow_direction}`);
    lines.push(
      `${w.distributing_count} distributing / ${w.accumulating_count} accumulating of ${w.whale_count} whales — ` +
        `sells ${formatUsd(w.total_sell_volume_usd)} vs buys ${formatUsd(w.total_buy_volume_usd)}`,
    );
  }

  if (data.metrics.liquidity_change_pct != null || data.metrics.holder_growth_pct != null) {
    lines.push('');
    lines.push('### 🏗 Structure');
    const s: string[] = [];
    if (data.metrics.liquidity_change_pct != null) {
      s.push(`liquidity ${data.metrics.liquidity_change_pct >= 0 ? '+' : ''}${data.metrics.liquidity_change_pct}%`);
    }
    if (data.metrics.holder_growth_pct != null) {
      s.push(`holders ${data.metrics.holder_growth_pct >= 0 ? '+' : ''}${data.metrics.holder_growth_pct}%`);
    }
    if (data.delta_window_minutes != null) s.push(`measured over the last ${data.delta_window_minutes}m`);
    lines.push(s.join(' | '));
  }

  if (data.flags.length > 0) {
    lines.push('');
    lines.push(`Flags: ${data.flags.join(', ')}`);
  }

  lines.push('');
  for (const c of data.caveats) lines.push(`_${c}_`);

  return lines.join('\n');
}
