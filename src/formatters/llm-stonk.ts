import type { RewardRiskResult } from '../enrichers/stonk-reward-risk';
import type { StonkYieldResult, YieldWindow } from '../enrichers/stonk-yield';
import type { StonkPreflightResult } from '../enrichers/stonk-preflight';
import type { StonkPairsResult, StonkScreenerResult } from '../entrypoints/stonk';
import { shortenAddress, formatUsd } from '../utils/normalize';

const LEVEL_LINE: Record<RewardRiskResult['level'], string> = {
  HEALTHY: '🟢 HEALTHY — the tax reaches holders and the coin has a payout record',
  MIXED: '🟡 MIXED — mechanism works, but track record or distribution is thin',
  WEAK: '🟠 WEAK — mechanism works on paper; little evidence holders are being paid',
  BROKEN: '🔴 BROKEN — the holder tax does not reach holders',
};

export function formatStonkRewardRiskBriefing(d: Omit<RewardRiskResult, 'llm_brief'>): string {
  const lines: string[] = [];
  const name = d.symbol ? `$${d.symbol}` : shortenAddress(d.mint);
  lines.push(`## StonkFun Reward Risk — ${name} (${shortenAddress(d.mint)})`);
  lines.push('');
  lines.push(`**${LEVEL_LINE[d.level]}** | score ${d.score}/100`);
  lines.push('');
  const facts: string[] = [];
  facts.push(d.adoption.listed_on_stonkfun ? `listed (${d.adoption.mode}, ${d.adoption.launchpad})` : 'NOT listed on StonkFun');
  if (d.quote.symbol) facts.push(`quote ${d.quote.symbol}${d.quote.category_raw ? ` / ${d.quote.category_raw}` : ''}`);
  if (d.market.market_cap_usd != null) facts.push(`mcap ${formatUsd(d.market.market_cap_usd)}`);
  if (d.age_days != null) facts.push(`age ${d.age_days < 1 ? `${Math.round(d.age_days * 24)}h` : `${d.age_days.toFixed(1)}d`}`);
  if (d.status) facts.push(d.status);
  lines.push(facts.join(' | '));
  lines.push('');
  lines.push('### 🧾 Transfer tax (on-chain)');
  if (d.transfer_fee.onchain_bps != null) {
    lines.push(`${d.transfer_fee.onchain_bps} bps, max fee ${d.transfer_fee.onchain_maximum_fee_raw}${d.transfer_fee.maximum_fee_binds ? ' (cap BINDS)' : ''} — withdraw authority ${d.adoption.withdraw_authority_is_stonkfun ? 'StonkFun ✓' : `${d.transfer_fee.withdraw_withheld_authority ?? 'none'} ✗`}${d.transfer_fee.config_authority ? ` — fee MUTABLE by ${shortenAddress(d.transfer_fee.config_authority)}` : ' — fee immutable'}`);
  } else {
    lines.push(`no transfer-fee extension (${d.transfer_fee.token_program ?? 'unknown program'}) — mechanism: ${d.reward_mechanism}`);
  }
  lines.push('');
  lines.push('### 💸 Distributions');
  if (d.rewards.distributed_tokens != null) {
    lines.push(`${d.rewards.distributed_tokens.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${d.rewards.reward_asset ?? ''} over ${d.rewards.payout_count} payouts to ${d.rewards.holder_count} holders${d.rewards.hours_since_last_payout != null ? ` — last ${d.rewards.hours_since_last_payout}h ago` : ''}${d.flywheel_active ? ' — flywheel active' : ''}`);
  } else {
    lines.push('no distribution record');
  }
  if (d.holders.top10_pct != null) lines.push(`Top-10 holders: ${d.holders.top10_pct}% of supply`);
  lines.push('');
  lines.push(`**Read:** ${d.reasons.join('; ') || 'no positive signals'}`);
  if (d.warnings.length) {
    lines.push('');
    lines.push(`⚠️ ${d.warnings.join(' · ')}`);
  }
  lines.push('');
  lines.push(`Next: ${d.next_steps.join(' ')}`);
  return lines.join('\n');
}

function windowLine(label: string, w: YieldWindow): string {
  if (w.yield_pct == null) return `- ${label}: n/a — ${w.caution_reason ?? 'no data'}`;
  const parts = [`${w.yield_pct.toFixed(3)}% over ${w.actual_days}d`];
  if (w.rewards_usd != null) parts.push(`${formatUsd(w.rewards_usd)} paid`);
  if (w.avg_market_cap_usd != null) parts.push(`avg mcap ${formatUsd(w.avg_market_cap_usd)}`);
  if (w.annualized_pct != null) parts.push(`≈ ${w.annualized_pct.toFixed(1)}% annualized${w.caution ? ' ⚠️' : ''}`);
  const line = `- ${label}: ${parts.join(' | ')}`;
  return w.caution && w.caution_reason ? `${line} (${w.caution_reason})` : line;
}

export function formatStonkYieldBriefing(d: StonkYieldResult): string {
  const lines: string[] = [];
  const name = d.symbol ? `$${d.symbol}` : shortenAddress(d.mint);
  lines.push(`## StonkFun Holder Yield — ${name} (${shortenAddress(d.mint)})`);
  lines.push('');
  lines.push(`Rewards paid in **${d.reward_asset.symbol ?? '?'}**${d.reward_asset.category ? ` (${d.reward_asset.category})` : ''}${d.reward_asset.usd_price != null ? ` at ${formatUsd(d.reward_asset.usd_price)}` : ''}${d.market_cap_usd != null ? ` | mcap ${formatUsd(d.market_cap_usd)}` : ''}${d.age_days != null ? ` | age ${d.age_days.toFixed(1)}d` : ''}`);
  lines.push('');
  lines.push('### 📈 Yield (rewards USD ÷ average market cap)');
  lines.push(windowLine('7d', d.trailing_7d));
  lines.push(windowLine('30d', d.trailing_30d));
  lines.push(windowLine('lifetime', d.lifetime));
  lines.push('');
  lines.push(`### 🧭 Exposure`);
  lines.push(`Long: ${d.quote_exposure.long.join(' + ')}. ${d.quote_exposure.note}`);
  if (d.distributed_tokens_total != null) {
    lines.push('');
    lines.push(`Total distributed: ${d.distributed_tokens_total.toLocaleString(undefined, { maximumFractionDigits: 4 })} ${d.reward_asset.symbol ?? ''} over ${d.payout_count ?? 0} payouts to ${d.holder_count ?? 0} holders${d.last_payout_at ? `, last ${d.last_payout_at}` : ''}`);
  }
  lines.push(`History: ${d.history.points} daily points${d.history.oldest_at ? ` since ${d.history.oldest_at.slice(0, 10)}` : ''}`);
  if (d.caveats.length) {
    lines.push('');
    lines.push(`⚠️ ${d.caveats.join(' · ')}`);
  }
  lines.push('');
  lines.push(`Next: ${d.next_steps.join(' ')}`);
  return lines.join('\n');
}

export function formatStonkScreenerBriefing(d: StonkScreenerResult): string {
  const lines: string[] = [];
  lines.push(`## StonkFun Reward-Coin Screener — ${d.rows.length} of ${d.matched} matches (index: ${d.index.rows} coins)`);
  lines.push('');
  const f = d.filters;
  const fparts: string[] = [];
  if (f.quote_mint) fparts.push(`quote ${shortenAddress(f.quote_mint)}`);
  if (f.category) fparts.push(`category ${f.category}`);
  if (f.min_holders != null) fparts.push(`≥${f.min_holders} holders`);
  if (f.min_age_days != null) fparts.push(`≥${f.min_age_days}d old`);
  lines.push(`Sorted by ${f.sort}${fparts.length ? ` | ${fparts.join(', ')}` : ''}${d.index.last_refresh_at ? ` | refreshed ${d.index.last_refresh_at}` : ' | index warming up'}`);
  lines.push('');
  if (!d.rows.length) {
    lines.push(d.index.rows === 0 ? '_Index is still warming up — retry in a minute._' : '_No coins match these filters._');
  } else {
    lines.push('| # | Coin | Quote | Tax | Holders | Rewards USD | 7d yield | 30d yield | Vol 24h | Mcap |');
    lines.push('|---|------|-------|-----|---------|-------------|----------|-----------|---------|------|');
    d.rows.forEach((r, i) => {
      const y7 = r.yield_7d_pct != null ? `${r.yield_7d_pct.toFixed(2)}%${r.window_7d_actual_days != null && r.window_7d_actual_days < 6.5 ? '*' : ''}` : '—';
      const y30 = r.yield_30d_pct != null ? `${r.yield_30d_pct.toFixed(2)}%${r.window_30d_actual_days != null && r.window_30d_actual_days < 29.5 ? '*' : ''}` : '—';
      lines.push(`| ${i + 1} | $${r.symbol} | ${r.quote_symbol} (${r.quote_category}) | ${r.transfer_fee_bps != null ? `${r.transfer_fee_bps}bps` : 'legacy'} | ${r.holder_count} | ${r.rewards_usd != null ? formatUsd(r.rewards_usd) : '—'} | ${y7} | ${y30} | ${formatUsd(r.volume_24h_usd)} | ${formatUsd(r.market_cap_usd)} |`);
    });
    lines.push('');
    lines.push('_* partial window — fewer days of history than the window length._');
  }
  lines.push('');
  lines.push(`Next: ${d.next_steps.join(' ')}`);
  return lines.join('\n');
}

export function formatStonkPreflightBriefing(d: StonkPreflightResult): string {
  const lines: string[] = [];
  lines.push(`## StonkFun Launch Preflight — ${d.mode} mode against ${shortenAddress(d.quote_mint)}`);
  lines.push('');
  lines.push(d.ok ? '**🟢 OK — this launch matches StonkFun\'s published shape and will be adopted.**' : `**🔴 NOT OK — ${d.mismatches.length} mismatch${d.mismatches.length === 1 ? '' : 'es'}. Do not broadcast.**`);
  lines.push('');
  if (d.decoded.variant) {
    lines.push(`Decoded: ${d.decoded.variant} at instruction ${d.decoded.instruction_index}, ${d.decoded.account_count} accounts, base mint ${d.decoded.base_mint ? shortenAddress(d.decoded.base_mint) : '?'}${d.decoded.symbol ? ` ($${d.decoded.symbol})` : ''}`);
    lines.push('');
  }
  if (d.mismatches.length) {
    lines.push('### ❌ Mismatches');
    for (const m of d.mismatches) {
      lines.push(`- **${m.field}** — expected \`${m.expected}\`, got \`${m.actual}\`. ${m.fix}`);
    }
    lines.push('');
  }
  if (d.warnings.length) {
    lines.push('### ⚠️ Warnings');
    for (const w of d.warnings) lines.push(`- ${w}`);
    lines.push('');
  }
  lines.push(`Expected shape: program ${shortenAddress(d.expected.program_id)}, config ${shortenAddress(d.expected.config_id)}, platform ${shortenAddress(d.expected.platform_id)}, curve rule ${shortenAddress(d.expected.curve_rule)}, ${d.expected.base_decimals} decimals, supply ${d.expected.supply}, totalSellA ${d.expected.total_sell_a}, raise ${d.expected.total_fund_raising_b}${d.expected.transfer_fee_bps ? `, tax ${d.expected.transfer_fee_bps.join('/')} bps` : ''} (pricing observed ${d.expected.pricing_observed_at})`);
  lines.push('');
  lines.push(`Next: ${d.next_steps.join(' ')}`);
  return lines.join('\n');
}

export function formatStonkPairsBriefing(d: StonkPairsResult): string {
  const lines: string[] = [];
  lines.push(`## StonkFun Launchable Pairs — ${d.pairs.length} of ${d.total} quote assets`);
  lines.push('');
  lines.push(`Categories: ${Object.entries(d.by_category).map(([k, v]) => `${k} ${v}`).join(', ')}. Agent-launchable: ${d.agent_launchable_count} (launchable + LaunchLab-ready + category in ${d.allowed_categories.join('/')}).`);
  lines.push('');
  const shown = d.pairs.slice(0, 40);
  lines.push('| Symbol | Name | Category | Decimals | Program | Launchable | LaunchLab ready | Agent-launchable |');
  lines.push('|--------|------|----------|----------|---------|------------|-----------------|------------------|');
  for (const p of shown) {
    lines.push(`| ${p.symbol} | ${p.name} | ${p.category}${p.category_raw !== p.category ? ` (${p.category_raw})` : ''} | ${p.decimals} | ${p.token_program === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' ? 'Token-2022' : 'SPL'} | ${p.launchable ? '✓' : '✗'} | ${p.launch_lab_ready == null ? '?' : p.launch_lab_ready ? '✓' : '✗'} | ${p.is_agent_launchable ? '✓' : '✗'} |`);
  }
  if (d.pairs.length > shown.length) lines.push(`_…${d.pairs.length - shown.length} more in the JSON._`);
  lines.push('');
  lines.push(`Next: ${d.next_steps.join(' ')}`);
  return lines.join('\n');
}
