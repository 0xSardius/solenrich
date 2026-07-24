import type { RunnerScanResult, RunnerCandidate } from '../enrichers/runner-detector';
import type { RunnerStage } from '../enrichers/runner-score';
import { formatUsd, shortenAddress } from '../utils/normalize';

const STAGE_LABEL: Record<RunnerStage, string> = {
  RUNNING: '🟢 RUNNING',
  IGNITING: '🟡 IGNITING',
  PARABOLIC_LATE: '🟠 LATE',
  FADING: '🔴 FADING',
  QUIET: '⚪ QUIET',
};

export function formatRunnerBriefing(data: RunnerScanResult): string {
  const lines: string[] = [];
  const f = data.filters;

  lines.push('## Runner Scan — On-Chain Velocity of Fresh Solana Tokens');
  lines.push('');
  lines.push(
    `_Scanned ${data.candidates_scanned} candidates; ${data.passed_filters} cleared the filters (younger than ${f.max_token_age_hours}h, liquidity ≥ ${formatUsd(f.min_liquidity_usd)}, 1h volume ≥ ${formatUsd(f.min_volume_h1_usd)})._`,
  );
  lines.push('');

  if (data.runners.length === 0) {
    lines.push(
      '**Nothing is running right now.** No token in the candidate pool cleared the liquidity/volume/age filters.',
    );
    lines.push('');
    lines.push(
      'A quiet scan is a real answer — it means there is no fresh token with meaningful tradeable activity at these thresholds. Widen `max_token_age_hours` or lower `min_liquidity_usd` to cast a broader net.',
    );
    lines.push('');
    lines.push(`Data as of: ${data.last_updated}`);
    return lines.join('\n');
  }

  const running = data.runners.filter((r) => r.stage === 'RUNNING');
  const igniting = data.runners.filter((r) => r.stage === 'IGNITING');
  const late = data.runners.filter((r) => r.stage === 'PARABOLIC_LATE');

  lines.push(
    `**${running.length} running, ${igniting.length} igniting, ${late.length} already ran.** Ranked by composite velocity score.`,
  );
  lines.push('');

  lines.push('| Token | Stage | Score | Age | 1h Buys/Sells | Buy Pressure | 5m Accel | 1h Vol | Liquidity |');
  lines.push('|-------|-------|-------|-----|---------------|--------------|----------|--------|-----------|');
  for (const r of data.runners) {
    const m = r.metrics;
    lines.push(
      `| ${r.symbol ?? shortenAddress(r.mint)} | ${STAGE_LABEL[r.stage]} | ${r.runner_score.toFixed(2)} | ${r.age_hours}h | ${r.buys_h1}/${r.sells_h1} | ${m.buy_pressure_h1 != null ? `${(m.buy_pressure_h1 * 100).toFixed(0)}%` : '—'} | ${m.buy_rate_accel_m5_h1 != null ? `${m.buy_rate_accel_m5_h1.toFixed(1)}×` : '—'} | ${formatUsd(r.volume_h1_usd)} | ${formatUsd(r.liquidity_usd)} |`,
    );
  }
  lines.push('');

  // Detail only for the ones worth acting on or explicitly avoiding.
  const detailed = data.runners.filter((r) => r.stage !== 'QUIET').slice(0, 8);
  for (const r of detailed) {
    lines.push(`### ${r.symbol ?? shortenAddress(r.mint)} — ${STAGE_LABEL[r.stage]} (score ${r.runner_score.toFixed(2)})`);
    lines.push(`\`${r.mint}\``);
    lines.push('');
    lines.push(r.reasoning);
    lines.push('');
    lines.push(
      `- Market cap ${formatUsd(r.market_cap_usd)} · liquidity ${formatUsd(r.liquidity_usd)} · ${r.age_hours}h old`,
    );
    lines.push(
      `- Price ${r.price_change_h1_pct >= 0 ? '+' : ''}${r.price_change_h1_pct.toFixed(1)}% (1h), ${r.price_change_h24_pct >= 0 ? '+' : ''}${r.price_change_h24_pct.toFixed(1)}% (24h)`,
    );
    lines.push(`- ${describeDeltas(r)}`);
    if (r.flags.length > 0) lines.push(`- Flags: ${r.flags.join(', ')}`);
    lines.push('');
  }

  lines.push('### How to read this');
  lines.push(
    '**RUNNING** = buying is accelerating across at least two independent windows AND buys are clearly dominating flow — the strongest live signal. **IGNITING** = acceleration is present but either unconfirmed (one window) or flow is only balanced; early, and where most false positives live. **LATE** = the move already happened and buying is decelerating, which is distribution risk, not an entry. **FADING** = sellers in control or liquidity being pulled — the anti-signal. **QUIET** = no meaningful acceleration, or acceleration happening while sellers dominate (churn, not accumulation).',
  );
  lines.push('');
  lines.push(
    'Score is a weighted composite of buy-rate acceleration, buy pressure, volume acceleration, price velocity, and holder growth, then penalised for dumping, liquidity pulls, wash-trade smell, and late entry.',
  );
  lines.push('');
  lines.push('### Caveats');
  for (const c of data.caveats) lines.push(`- ${c}`);
  lines.push('');
  lines.push(`_Candidate pool: ${data.candidate_source}_`);
  lines.push('');
  lines.push(`Data as of: ${data.last_updated}`);
  return lines.join('\n');
}

function describeDeltas(r: RunnerCandidate): string {
  const m = r.metrics;
  if (r.delta_window_minutes == null) {
    return 'Holder growth and liquidity trend: no prior snapshot yet (fills in on the next scan of this token)';
  }
  const parts: string[] = [];
  parts.push(
    m.liquidity_change_pct != null
      ? `liquidity ${m.liquidity_change_pct >= 0 ? '+' : ''}${m.liquidity_change_pct.toFixed(1)}%`
      : 'liquidity trend unavailable',
  );
  parts.push(
    m.holder_growth_pct != null
      ? `holders ${m.holder_growth_pct >= 0 ? '+' : ''}${m.holder_growth_pct.toFixed(1)}%`
      : 'holder growth unavailable',
  );
  return `Since ${r.delta_window_minutes}m ago: ${parts.join(', ')}`;
}
