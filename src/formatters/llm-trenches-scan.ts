import type { TrenchesScanResult, TrenchesScanPick } from '../enrichers/trenches-scan';
import { shortenAddress, formatUsd } from '../utils/normalize';

function pickName(p: TrenchesScanPick): string {
  return p.symbol ? `$${p.symbol} (${shortenAddress(p.mint)})` : shortenAddress(p.mint);
}

function legCell(p: TrenchesScanPick): string {
  const legs: string[] = [];
  if (p.smart_money) legs.push(`👛 ${p.smart_money.smart_buyers} smart`);
  if (p.runner) legs.push(`⚡ ${p.runner.stage}`);
  if (p.attention) legs.push(`👁 ${p.attention.attention}`);
  return legs.join(' + ');
}

export function formatTrenchesScanBriefing(data: TrenchesScanResult): string {
  const lines: string[] = [];

  lines.push('## Trenches Scan — three-signal memecoin confluence');
  lines.push('');
  lines.push(
    `Universe: ${data.legs.runner.candidates_scanned} runner candidates scanned (${data.legs.runner.passed_filters} passed filters), ` +
      `${data.legs.smart_money.seeds_scanned} proven-winner seeds checked (${data.legs.smart_money.total_recent_buys} recent buys), ` +
      `agent-attention sample: ${data.legs.attention.sample_quality ?? 'unavailable'}. ` +
      `Confluence: ${data.confluence_counts.triple} triple / ${data.confluence_counts.double} double / ${data.confluence_counts.single} single.`,
  );

  const failed = [
    !data.legs.runner.ok ? 'runner' : null,
    !data.legs.smart_money.ok ? 'smart-money' : null,
    !data.legs.attention.ok ? 'attention' : null,
  ].filter(Boolean);
  if (failed.length > 0) {
    lines.push('');
    lines.push(`⚠ **Leg failure this scan:** ${failed.join(', ')} — composite scores are partial.`);
  }

  if (data.picks.length === 0) {
    lines.push('');
    lines.push(
      '_Nothing cleared the filters this scan. A quiet trenches is itself information — ' +
        'try widening max_token_age_hours or lowering min_liquidity_usd._',
    );
  } else {
    const high = data.picks.filter((p) => p.verdict === 'HIGH_CONFLUENCE');
    if (high.length > 0) {
      lines.push('');
      lines.push(`**High confluence:** ${high.map(pickName).join(', ')}`);
    }

    lines.push('');
    lines.push('| # | Token | Age | Score | Signals | Liquidity | Verdict |');
    lines.push('|---|-------|-----|-------|---------|-----------|---------|');
    data.picks.forEach((p, i) => {
      const age = p.age_hours != null ? `${p.age_hours}h` : '?';
      const liq = p.liquidity_usd != null ? formatUsd(p.liquidity_usd) : 'n/a';
      lines.push(
        `| ${i + 1} | ${pickName(p)} | ${age} | ${p.composite_score} | ${legCell(p)} | ${liq} | ${p.verdict} |`,
      );
    });

    lines.push('');
    lines.push('### Reasoning');
    data.picks.slice(0, 5).forEach((p) => {
      lines.push(`- **${pickName(p)}**: ${p.reasoning}`);
    });
  }

  lines.push('');
  for (const c of data.caveats) lines.push(`_${c}_`);

  return lines.join('\n');
}
