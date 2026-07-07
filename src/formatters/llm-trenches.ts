import type { SmartMoneyTrenchesResult } from '../enrichers/trenches-smart-money';
import { formatUsd, shortenAddress } from '../utils/normalize';

export function formatTrenchesBriefing(data: SmartMoneyTrenchesResult): string {
  const lines: string[] = [];
  const f = data.filters;

  lines.push('## Smart Money in the Trenches — Proven Winners Buying Fresh Tokens');
  lines.push('');
  lines.push(
    `_Seeds: ${data.seed_set.active_traders} vetted realized-PnL winners + ${data.seed_set.conviction_holders} conviction holders (derived ${data.seed_set.derived_at}, bot-filtered). Window: buys in the last ${f.hours_back}h on tokens younger than ${f.max_token_age_hours}h._`,
  );
  lines.push('');

  if (data.seeds_skipped_bot_cadence.length > 0) {
    lines.push(
      `⚠ ${data.seeds_skipped_bot_cadence.length} seed(s) skipped this scan — live cadence at bot levels: ${data.seeds_skipped_bot_cadence.map(shortenAddress).join(', ')}.`,
    );
    lines.push('');
  }

  if (data.signals.length === 0) {
    lines.push(
      `**No fresh-token buys from the seed set in this window.** Scanned ${data.seeds_scanned} wallets, saw ${data.total_recent_buys} recent buys — ${data.buys_on_older_tokens} were on tokens older than ${f.max_token_age_hours}h${data.buys_unknown_age > 0 ? `, ${data.buys_unknown_age} on tokens with unknown launch time` : ''}.`,
    );
    lines.push('');
    lines.push(
      'A quiet scan is itself a signal: the proven wallets are not aping right now. Consider widening `hours_back` or `max_token_age_hours`, or treat the trenches as cold.',
    );
    lines.push('');
    lines.push(`Data as of: ${data.last_updated}`);
    return lines.join('\n');
  }

  lines.push(
    `**${data.signals.length} fresh token(s)** bought by proven wallets (${data.total_recent_buys} total recent buys across ${data.seeds_scanned} seeds).`,
  );
  lines.push('');
  lines.push('| Token | Age | Smart Buyers | Spent | Last Buy | Liquidity | MCap |');
  lines.push('|-------|-----|--------------|-------|----------|-----------|------|');
  for (const s of data.signals) {
    lines.push(
      `| ${s.symbol ?? shortenAddress(s.mint)} | ${s.token_age_hours}h | ${s.smart_buyers}${s.conviction_holder_buyers > 0 ? ` (${s.conviction_holder_buyers} holder)` : ''} | ${formatUsd(s.total_spent_usd)} | ${s.most_recent_buy_minutes_ago}m ago | ${s.liquidity_usd != null ? formatUsd(s.liquidity_usd) : '—'} | ${s.market_cap_usd != null ? formatUsd(s.market_cap_usd) : '—'} |`,
    );
  }
  lines.push('');

  for (const s of data.signals) {
    lines.push(`### ${s.symbol ?? shortenAddress(s.mint)} — \`${s.mint}\``);
    for (const b of s.buys) {
      const cred =
        b.wallet_type === 'conviction_holder'
          ? 'conviction holder (held prior runners)'
          : `${b.seed_win_rate != null ? `${(b.seed_win_rate * 100).toFixed(0)}% win rate, ` : ''}${b.seed_realized_1w_usd != null ? `${formatUsd(b.seed_realized_1w_usd)} realized 1W at vetting` : 'realized winner'}`;
      lines.push(
        `- ${shortenAddress(b.wallet)} (${cred}) spent ${b.spent_usd != null ? formatUsd(b.spent_usd) : 'unknown'} — ${b.minutes_ago}m ago${b.elevated_cadence ? ' ⚠ elevated cadence this scan' : ''}`,
      );
    }
    lines.push('');
  }

  lines.push('### Interpretation');
  lines.push(
    'Seeds are proven-winner wallets (realized leaderboard PnL, vetted for human cadence), re-checked for bot behavior on every scan. Multiple distinct smart buyers on the same fresh token is the strongest form of this signal; a single buyer is attention, not consensus. Fresh tokens are high-risk by construction — this is an attention signal for further research (due-diligence, token-x-ray), not a buy recommendation.',
  );
  lines.push('');
  lines.push(`Data as of: ${data.last_updated}`);
  return lines.join('\n');
}
