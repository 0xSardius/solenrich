import type { AudaceIntentCheckResult } from '../enrichers/audace-intent-check';
import { shortenAddress, formatUsd } from '../utils/normalize';

const VERDICT_LINE: Record<AudaceIntentCheckResult['verdict'], string> = {
  PROCEED: '🟢 PROCEED — send the intent as-is',
  REDUCE: '🟠 REDUCE — send only part of it',
  HOLD: '⚪ HOLD — do not send it now',
};

export function formatAudaceIntentBriefing(data: AudaceIntentCheckResult): string {
  const lines: string[] = [];
  const i = data.intent;
  const name = (mint: string, symbol?: string | null) => (symbol ? `$${symbol}` : shortenAddress(mint));
  const sold = name(i.token_in, data.sell_check?.symbol);
  const bought = name(i.token_out, data.buy_check?.symbol);

  lines.push(`## AudaceFi Intent Check — ${i.direction} ${i.direction === 'buy' ? bought : i.direction === 'sell' ? sold : `${sold} → ${bought}`}`);
  lines.push('');
  lines.push(`**${VERDICT_LINE[data.verdict]}**${data.verdict === 'REDUCE' ? ` (${data.suggested_fraction * 100}% of amountIn)` : ''}`);
  lines.push('');
  lines.push(
    `${i.category} · ${i.network} · amount ${i.amount_in}${i.size_usd != null ? ` (~${formatUsd(i.size_usd)})` : ''} · ` +
      `${data.season.minutes_to_snapshot} min to the season-end snapshot`,
  );
  if (data.codes.length) lines.push(`Codes: ${data.codes.join(', ')}`);
  lines.push('');

  const b = data.buy_check;
  if (b) {
    const parts: string[] = [];
    if (b.risk_flags) parts.push(`risk flags: ${b.risk_flags.length ? b.risk_flags.join(', ') : 'none'}`);
    if (b.degen_signal) parts.push(`trenches signal ${b.degen_signal}`);
    if (b.exit_verdict) parts.push(`momentum ${b.exit_verdict}`);
    if (b.price_impact_pct != null) parts.push(`price impact ${b.price_impact_pct}%`);
    lines.push(`**Buy side (${bought}):** ${parts.join(' · ') || 'no data'}`);
  }
  const s = data.sell_check;
  if (s) {
    lines.push(`**Sell side (${sold}):** exit verdict ${s.exit_verdict ?? 'unavailable'}${s.exit_score != null ? ` (score ${s.exit_score})` : ''}`);
  }
  if (b || s) lines.push('');

  lines.push(data.reasoning);
  lines.push('');
  for (const c of data.caveats) lines.push(`_${c}_`);
  return lines.join('\n');
}
