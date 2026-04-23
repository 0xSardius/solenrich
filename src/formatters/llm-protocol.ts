import type { ProtocolProfileEnrichment } from '../enrichers/protocol-analyzer';
import { formatUsd, formatNumber } from '../utils/normalize';

export function formatProtocolBriefing(data: ProtocolProfileEnrichment): string {
  const lines: string[] = [];
  const p = data.protocol;

  lines.push(`## Protocol Profile: ${p.name}`);
  lines.push('');
  lines.push(`**Category:** ${p.category} | **TVL Tier:** ${data.health_signals.tvl_tier}`);
  if (p.program_id) lines.push(`**Program ID:** \`${p.program_id}\``);
  lines.push('');

  // TVL breakdown
  lines.push('### TVL');
  lines.push(`Total: ${formatUsd(data.tvl.total_usd)} | Solana: ${formatUsd(data.tvl.solana_usd)} (${data.tvl.solana_dominance_pct}%)`);

  const otherChains = Object.entries(data.tvl.chains)
    .filter(([chain]) => chain !== 'Solana' && chain !== 'borrowed' && chain !== 'staking')
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5);
  if (otherChains.length > 0) {
    lines.push('Other chains: ' + otherChains.map(([c, v]) => `${c} ${formatUsd(v)}`).join(', '));
  }
  lines.push('');

  // Yields
  if (data.yields) {
    const y = data.yields;
    lines.push(`### Yield Pools (${y.pool_count} total)`);
    lines.push(`Avg APY: ${y.avg_apy}% | Median APY: ${y.median_apy}% | Total TVL: ${formatUsd(y.total_yield_tvl_usd)}`);
    if (y.top_pools.length > 0) {
      lines.push('');
      lines.push('| Pool | APY | TVL |');
      lines.push('|------|-----|-----|');
      for (const pool of y.top_pools.slice(0, 8)) {
        const apyDetail = pool.apy_base != null && pool.apy_reward != null
          ? `${pool.apy}% (${pool.apy_base}% base + ${pool.apy_reward}% reward)`
          : `${pool.apy}%`;
        lines.push(`| ${pool.symbol} | ${apyDetail} | ${formatUsd(pool.tvl_usd)} |`);
      }
    }
    lines.push('');
  }

  // Activity
  if (data.activity) {
    const a = data.activity;
    lines.push('### Recent On-Chain Activity');
    lines.push(`${formatNumber(a.recent_tx_count)} transactions from ${formatNumber(a.unique_signers)} unique signers (last ${a.sample_window_minutes} min)`);
    lines.push(`Rate: ~${formatNumber(a.avg_tx_per_hour)} tx/hour | Activity level: **${data.health_signals.activity_level}**`);

    const topTypes = Object.entries(a.tx_types)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5);
    if (topTypes.length > 0) {
      const total = Object.values(a.tx_types).reduce((s, v) => s + v, 0);
      const breakdown = topTypes.map(([t, c]) => `${t} ${Math.round((c / total) * 100)}%`).join(', ');
      lines.push(`Types: ${breakdown}`);
    }

    // Automated-activity share of top signers (behavioral signal, not bot classification)
    if (typeof a.automated_activity_pct === 'number') {
      lines.push(
        `Automated activity: ~${a.automated_activity_pct}% of top signers show regular-interval or high-frequency tx patterns.`,
      );
    }
    lines.push('');
  }

  // Health signals
  lines.push('### Health Signals');
  const signals: string[] = [];
  signals.push(`TVL: ${data.health_signals.tvl_tier}-tier`);
  if (data.health_signals.yield_attractiveness) {
    signals.push(`Yield attractiveness: ${data.health_signals.yield_attractiveness}`);
  }
  if (data.health_signals.activity_level) {
    signals.push(`Activity: ${data.health_signals.activity_level}`);
  }
  lines.push(signals.join(' | '));
  lines.push('');

  lines.push(`Data as of: ${data.last_updated}`);
  return lines.join('\n');
}
