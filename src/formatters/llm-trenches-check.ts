import type { TrenchesCheckResult } from '../enrichers/trenches-check';
import { shortenAddress, formatUsd } from '../utils/normalize';

const VERDICT_LINE: Record<TrenchesCheckResult['verdict'], string> = {
  HIGH_CONFLUENCE: '🟢 HIGH CONFLUENCE — multiple independent signals agree',
  MODERATE: '🟡 MODERATE — some signal, incomplete confluence',
  SINGLE_SIGNAL: '⚪ SINGLE SIGNAL — one leg only, treat as unconfirmed',
  NO_SIGNAL: '🔴 NO SIGNAL — nothing here says look closer',
};

export function formatTrenchesCheckBriefing(data: TrenchesCheckResult): string {
  const lines: string[] = [];
  const name = data.symbol ? `$${data.symbol}` : shortenAddress(data.mint);

  lines.push(`## Trenches Check — ${name} (${shortenAddress(data.mint)})`);
  lines.push('');
  lines.push(`**${VERDICT_LINE[data.verdict]}** | composite ${data.composite_score} | ${data.confluence}/3 legs`);
  lines.push('');

  const facts: string[] = [];
  if (data.age_hours != null) facts.push(`age ${data.age_hours}h`);
  if (data.price_usd != null) facts.push(`price ${formatUsd(data.price_usd)}`);
  if (data.liquidity_usd != null) facts.push(`liquidity ${formatUsd(data.liquidity_usd)}`);
  if (data.market_cap_usd != null) facts.push(`mcap ${formatUsd(data.market_cap_usd)}`);
  if (facts.length > 0) lines.push(facts.join(' | '));

  lines.push('');
  lines.push(`**Read:** ${data.reasoning}`);

  if (data.runner) {
    const r = data.runner;
    lines.push('');
    lines.push(`### ⚡ On-chain velocity — ${r.stage} (score ${r.runner_score})`);
    lines.push(
      `1h: ${r.buys_h1} buys / ${r.sells_h1} sells, ${formatUsd(r.volume_h1_usd)} volume, price ${r.price_change_h1_pct > 0 ? '+' : ''}${r.price_change_h1_pct}% (24h ${r.price_change_h24_pct > 0 ? '+' : ''}${r.price_change_h24_pct}%)`,
    );
    lines.push(r.reasoning);
    if (r.delta_window_minutes != null) {
      lines.push(`Liquidity/holder deltas measured over the last ${r.delta_window_minutes}m.`);
    }
  }

  if (data.smart_money) {
    const s = data.smart_money;
    lines.push('');
    lines.push(`### 👛 Smart money — ${s.smart_buyers} proven winner${s.smart_buyers > 1 ? 's' : ''} in`);
    lines.push(
      `${formatUsd(s.total_spent_usd)} total spent, latest buy ${s.most_recent_buy_minutes_ago}m ago` +
        (s.conviction_holder_buyers > 0 ? `, ${s.conviction_holder_buyers} conviction holder(s)` : ''),
    );
    for (const b of s.buys.slice(0, 3)) {
      lines.push(
        `- ${shortenAddress(b.wallet)} (${b.wallet_type}${b.seed_win_rate != null ? `, ${Math.round(b.seed_win_rate * 100)}% win rate` : ''}): ${b.spent_usd != null ? formatUsd(b.spent_usd) : '?'} ${b.minutes_ago}m ago`,
      );
    }
  }

  if (data.attention) {
    const a = data.attention;
    lines.push('');
    lines.push(`### 👁 Agent attention — ${a.rising ? 'rising' : 'present, not rising'}`);
    lines.push(
      `${a.queries_6h} queries in 6h (prior window ${a.prior_window_queries}) — rank #${a.rank}, ${a.percentile}th percentile of queried tokens.`,
    );
  }

  lines.push('');
  for (const c of data.caveats) lines.push(`_${c}_`);

  return lines.join('\n');
}
