import type { HyperliquidSmartMoney, CoinPositioning, SmartTrader } from '../enrichers/hyperliquid-smart-money';
import { formatUsd, shortenAddress } from '../utils/normalize';

function biasLabel(p: CoinPositioning): string {
  const dir = p.bias === 'long' ? 'NET LONG' : p.bias === 'short' ? 'NET SHORT' : 'BALANCED';
  return `${dir} (${p.conviction})`;
}

function traderLine(t: SmartTrader): string {
  const pnl = t.month_pnl_usd !== null ? `${t.month_pnl_usd >= 0 ? '+' : ''}${formatUsd(t.month_pnl_usd)}` : 'n/a';
  const pos = t.top_positions.length
    ? t.top_positions.map((p) => `${p.dir.toUpperCase()} ${p.coin} ${p.leverage}x`).join(', ')
    : 'flat';
  return `- ${shortenAddress(t.address)} — acct ${formatUsd(t.account_value_usd)}, month PnL ${pnl}, bias ${t.directional_bias}: ${pos}`;
}

export function formatHyperliquidSmartMoneyBriefing(data: HyperliquidSmartMoney): string {
  const lines: string[] = [];
  lines.push(data.market ? `## Hyperliquid Smart Money — ${data.market}` : '## Hyperliquid Smart Money');
  lines.push('');
  lines.push(data.summary);
  lines.push(
    `_Universe: ${data.trader_universe.qualified} consistent directional traders (from ${data.trader_universe.leaderboard_candidates} MM-filtered leaderboard candidates, ${data.trader_universe.inspected} inspected)._`,
  );
  lines.push('');

  if (data.positioning.length === 0) {
    lines.push(data.market ? `No consistent smart-money positioning in ${data.market}.` : 'No positioning to report.');
  } else {
    lines.push('### Positioning consensus');
    lines.push('| Coin | Long | Short | Bias | Net notional |');
    lines.push('|---|---|---|---|---|');
    for (const p of data.positioning.slice(0, 12)) {
      lines.push(
        `| ${p.coin} | ${p.long_traders} | ${p.short_traders} | ${biasLabel(p)} | ${p.net_notional_usd >= 0 ? '+' : ''}${formatUsd(p.net_notional_usd)} |`,
      );
    }
    lines.push('');
    if (data.consensus_longs.length) lines.push(`**Consensus longs:** ${data.consensus_longs.join(', ')}`);
    if (data.consensus_shorts.length) lines.push(`**Consensus shorts:** ${data.consensus_shorts.join(', ')}`);
    if (data.consensus_longs.length || data.consensus_shorts.length) lines.push('');
  }

  if (data.top_traders.length) {
    lines.push('### Top traders (ranked by month PnL)');
    for (const t of data.top_traders) lines.push(traderLine(t));
    lines.push('');
  }

  // Honest framing — this is a signal, not a system (locked positioning, see scope doc).
  lines.push(
    '_This is a positioning signal, not a trade. Smart-money consensus is often late/crowded and regime-dependent — use it as confluence and risk context (is informed flow with you or against you?), not a standalone entry. Individual trader returns are survivorship-flattered._',
  );

  return lines.join('\n');
}
