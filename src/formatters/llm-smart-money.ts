import type { SmartMoneyFlowResult } from '../enrichers/smart-money-flow';
import { formatUsd, shortenAddress } from '../utils/normalize';

export function formatSmartMoneyBriefing(data: SmartMoneyFlowResult): string {
  const lines: string[] = [];

  lines.push('## Smart Money Flow — Where High-Performing Wallets Are Moving');
  lines.push('');

  // Seed-source provenance line — agents can audit where the candidate set came from
  const seedNote =
    data.seed_source === 'user'
      ? `_Seeds: your provided list (${data.seed_wallets_considered} wallets)._`
      : data.seed_source === 'derived'
        ? `_Seeds: programmatically derived from current trending-token whale activity (${data.seed_wallets_considered} candidates, refreshed weekly)._`
        : `_Seeds: curated fallback list (${data.seed_wallets_considered} wallets) — programmatic derivation unavailable this cycle._`;
  lines.push(seedNote);
  lines.push('');

  if (data.qualifying_smart_wallets.length === 0) {
    lines.push(
      `Scanned ${data.seed_wallets_considered} seed wallets over the last ${data.filters.lookback_days} days. **None qualified** at the current filter (win rate ≥ ${(data.filters.min_win_rate * 100).toFixed(0)}%, ≥ 5 trades).`,
    );
    lines.push('');
    lines.push(
      data.filters.user_provided_wallets
        ? 'Your wallet list didn\'t contain active traders meeting the filter. Try lowering `min_win_rate` or providing a different list.'
        : 'The curated default seed list didn\'t turn up qualifying traders this cycle. Try lowering `min_win_rate` or passing your own `wallets` array.',
    );
    lines.push('');
    lines.push(`Data as of: ${data.last_updated}`);
    return lines.join('\n');
  }

  lines.push(
    `Scanned ${data.seed_wallets_considered} seed wallets over ${data.filters.lookback_days} days. **${data.qualifying_smart_wallets.length} qualifying smart wallets** (win rate ≥ ${(data.filters.min_win_rate * 100).toFixed(0)}%, ≥ 5 trades).`,
  );
  lines.push('');

  // Top wallets
  lines.push('### Top Smart Wallets');
  lines.push('| Wallet | Win Rate | Trades | Total PnL | Sharpe | Labels |');
  lines.push('|--------|----------|--------|-----------|--------|--------|');
  for (const w of data.qualifying_smart_wallets.slice(0, 8)) {
    const sharpe = w.sharpe_ratio !== null ? w.sharpe_ratio.toFixed(2) : '—';
    const labels = w.labels.slice(0, 3).join(', ') || '—';
    lines.push(
      `| ${shortenAddress(w.address)} | ${(w.win_rate * 100).toFixed(0)}% | ${w.trades_analyzed} | ${formatUsd(w.total_pnl_usd)} | ${sharpe} | ${labels} |`,
    );
  }
  lines.push('');

  // Accumulated tokens
  if (data.accumulated_tokens.length > 0) {
    lines.push('### What Smart Money Is Accumulating');
    lines.push(
      'Tokens appearing as top-performing buys across multiple qualifying wallets (2+ smart buyers required).',
    );
    lines.push('');
    lines.push('| Token | Smart Buyers | Est. Volume | Avg Hold (days) |');
    lines.push('|-------|--------------|-------------|-----------------|');
    for (const t of data.accumulated_tokens) {
      lines.push(
        `| ${t.symbol} | ${t.smart_money_buyers} | ${formatUsd(t.total_buy_volume_usd)} | ${t.avg_avg_hold_time_days?.toFixed(1) ?? '—'} |`,
      );
    }
    lines.push('');
  } else {
    lines.push('_No single token had 2+ smart wallets accumulating — no consensus signal this cycle._');
    lines.push('');
  }

  // Clusters
  if (data.clusters.length > 0) {
    lines.push('### Wallet Clusters');
    lines.push(
      'Graph analysis surfaced groups of qualifying wallets with unusually dense inter-wallet activity.',
    );
    lines.push('');
    for (const c of data.clusters) {
      const flag = c.suspicious_pattern ? ` ⚠ _${c.suspicious_pattern}_` : '';
      lines.push(`- **Cluster of ${c.size}**: ${c.members.slice(0, 3).map(shortenAddress).join(', ')}${c.members.length > 3 ? '…' : ''}${flag}`);
    }
    lines.push('');
  }

  lines.push('### Interpretation');
  lines.push(
    'Smart wallets are identified purely by trading performance — no insider labels. Consensus accumulation (2+ smart wallets buying the same token) is a stronger signal than any single wallet. Clusters can indicate coordinated trading, shared strategy providers, or multi-wallet setups — treat the `suspicious_pattern` flag as the distinguishing marker.',
  );
  lines.push('');
  lines.push(`Data as of: ${data.last_updated}`);
  return lines.join('\n');
}
