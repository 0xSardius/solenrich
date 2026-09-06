import type { RewardRiskResult } from '../enrichers/stonk-reward-risk';
import type { StonkYieldResult, YieldWindow } from '../enrichers/stonk-yield';
import type { StonkPreflightResult } from '../enrichers/stonk-preflight';
import type { StonkPairsResult, StonkScreenerResult, StonkGemsResult, StonkLaunchIntelResult } from '../entrypoints/stonk';
import { shortenAddress, formatUsd } from '../utils/normalize';

const PAYOUT_LINE: Record<RewardRiskResult['payout_status'], string> = {
  PAYING: '🟢 PAYING — holders received a payout in the last 24h',
  STALE: '🟡 STALE — has paid before, nothing in the last 24h',
  NEVER: '🟠 NEVER PAID — adopted, but no payout has happened yet',
  NOT_REWARD: '🔴 NOT PAYING — nothing on this mint pays holders',
};

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
  lines.push(`**${PAYOUT_LINE[d.payout_status]}**${d.rewards.hours_since_last_payout != null ? ` — last payout ${d.rewards.hours_since_last_payout}h ago` : ''}`);
  if (d.trading_cost.round_trip_pct != null) lines.push(`Trading cost: ${d.trading_cost.bps} bps per transfer — a round trip costs ${d.trading_cost.round_trip_pct}% before slippage.`);
  lines.push(`${LEVEL_LINE[d.level]} | health score ${d.score}/100`);
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
    lines.push('| # | Coin | Quote | Payout | RT cost | Holders | Rewards USD | 7d yield | Vol 24h | Mcap | 24h |');
    lines.push('|---|------|-------|--------|---------|---------|-------------|----------|---------|------|-----|');
    d.rows.forEach((r, i) => {
      const y7 = r.yield_7d_pct != null ? `${r.yield_7d_pct.toFixed(2)}%${r.window_7d_actual_days != null && r.window_7d_actual_days < 6.5 ? '*' : ''}` : '—';
      const pay = r.payout_status === 'PAYING' ? `paying (${r.hours_since_last_payout}h)` : r.payout_status.toLowerCase();
      const chg = r.price_change_24h_pct != null ? `${r.price_change_24h_pct > 0 ? '+' : ''}${r.price_change_24h_pct.toFixed(0)}%` : '—';
      lines.push(`| ${i + 1} | $${r.symbol} | ${r.quote_symbol} (${r.quote_category}) | ${pay} | ${r.round_trip_pct != null ? `${r.round_trip_pct}%` : 'none'} | ${r.holder_count} | ${r.rewards_usd != null ? formatUsd(r.rewards_usd) : '—'} | ${y7} | ${formatUsd(r.volume_24h_usd)} | ${formatUsd(r.market_cap_usd)} | ${chg} |`);
    });
    lines.push('');
    lines.push('_* partial window — fewer days of history than the window length. RT cost = transfer tax on a buy + a sell, before slippage._');
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

const GEM_LINE: Record<StonkGemsResult['gems'][number]['stage'], string> = {
  GEM: '💎 GEM',
  WATCH: '👀 WATCH',
  NOISE: '· noise',
  DEAD: '✖ dead',
};

export function formatStonkGemsBriefing(d: StonkGemsResult): string {
  const lines: string[] = [];
  lines.push(`## StonkFun Gems — ${d.gems.length} of ${d.passed_filters} candidates (${d.scanned} reward coins scanned)`);
  lines.push('');
  lines.push(`Stages: ${d.stage_counts.GEM} GEM · ${d.stage_counts.WATCH} WATCH · ${d.stage_counts.NOISE} noise${d.filters.quote_mint ? ` | quote ${shortenAddress(d.filters.quote_mint)}` : ''}${d.filters.category ? ` | ${d.filters.category}` : ''} | ≤${d.filters.max_age_days}d old, ≥${d.filters.min_holders} holders, mcap ≤ ${formatUsd(d.filters.max_market_cap_usd)}${d.index.last_refresh_at ? ` | refreshed ${d.index.last_refresh_at}` : ' | index warming up'}`);
  lines.push('');
  if (!d.gems.length) {
    lines.push(d.index.rows === 0 ? '_Index is still warming up — retry in a minute._' : '_Nothing passes these filters right now. Loosen max_market_cap_usd or min_holders, or widen max_age_days._');
  } else {
    lines.push('| # | Coin | Quote | Score | Payout | Holders | Mcap | Turnover | 24h | RT cost |');
    lines.push('|---|------|-------|-------|--------|---------|------|----------|-----|---------|');
    for (const g of d.gems) {
      const pay = g.payout_status === 'PAYING' ? `${g.hours_since_last_payout}h ago` : g.payout_status.toLowerCase();
      const chg = g.price_change_24h_pct != null ? `${g.price_change_24h_pct > 0 ? '+' : ''}${g.price_change_24h_pct.toFixed(0)}%` : '—';
      lines.push(`| ${g.rank} | $${g.symbol} | ${g.quote_symbol} | ${GEM_LINE[g.stage]} ${g.gem_score} | ${pay} | ${g.holder_count} | ${formatUsd(g.market_cap_usd)} | ${g.turnover_24h_pct != null ? `${g.turnover_24h_pct}%` : '—'} | ${chg} | ${g.round_trip_pct != null ? `${g.round_trip_pct}%` : 'none'} |`);
    }
    lines.push('');
    for (const g of d.gems.filter((x) => x.stage === 'GEM' || x.stage === 'WATCH').slice(0, 6)) {
      lines.push(`### $${g.symbol} — ${GEM_LINE[g.stage]} ${g.gem_score}/100`);
      lines.push(`\`${g.mint}\``);
      if (g.reasons.length) lines.push(`+ ${g.reasons.join(' · ')}`);
      if (g.warnings.length) lines.push(`⚠️ ${g.warnings.join(' · ')}`);
      lines.push('');
    }
  }
  lines.push('### How to read this');
  lines.push('Score = recent holder payout (25) + holders (12) + size (15) + 24h turnover vs mcap (15) + age (10) + 24h momentum (10, negative once a coin has already run) + quote strength (10) + flywheel (3). GEM ≥ 80, WATCH ≥ 62. A coin with no 24h volume is DEAD regardless. RT cost is the transfer tax on a buy plus a sell — the move must clear it before slippage.');
  lines.push('');
  for (const c of d.caveats) lines.push(`_${c}_`);
  lines.push('');
  lines.push(`Next: ${d.next_steps.join(' ')}`);
  return lines.join('\n');
}

export function formatStonkLaunchIntelBriefing(d: StonkLaunchIntelResult): string {
  const lines: string[] = [];
  const pct = (x: number | null) => (x == null ? '—' : `${(x * 100).toFixed(0)}%`);
  const o = d.overall;
  lines.push(`## StonkFun Launch Intel — ${d.quotes.length} of ${o.quotes} quote assets, sorted by ${d.filters.sort}`);
  lines.push('');
  lines.push(`Across ${o.coins} reward coins: ${o.launches_24h} launched in 24h, ${o.launches_7d} in 7d. ${pct(o.traded_share_24h)} traded today, ${pct(o.paying_share_24h)} paid holders today, ${pct(o.survival_3d)} of coins older than 3 days still trade.`);
  lines.push(`Tax: 100 bps → ${o.tax.bps_100.coins} coins, ${pct(o.tax.bps_100.traded_share)} trading, ${pct(o.tax.bps_100.paying_share)} paying · 300 bps → ${o.tax.bps_300.coins} coins, ${pct(o.tax.bps_300.traded_share)} trading, ${pct(o.tax.bps_300.paying_share)} paying.`);
  lines.push('');
  if (d.recommendations.length) {
    lines.push('### Recommendations');
    for (const r of d.recommendations) lines.push(`- ${r}`);
    lines.push('');
  }
  if (d.quotes.length) {
    lines.push('| # | Quote | Cat | Coins | 7d launches | Traded 24h | Paying 24h | Survival 3d | Crowding | Med holders | Vol 24h | Demand |');
    lines.push('|---|-------|-----|-------|-------------|------------|------------|-------------|----------|-------------|---------|--------|');
    for (const q of d.quotes) {
      lines.push(`| ${q.rank} | ${q.quote_symbol}${q.is_new ? ' (new)' : ''} | ${q.quote_category} | ${q.coins} | ${q.launches_7d} | ${pct(q.traded_share_24h)} | ${pct(q.paying_share_24h)} | ${q.is_new ? 'new' : pct(q.survival_3d)} | ${q.crowding ?? '—'} | ${q.holders_median} | ${formatUsd(q.volume_24h_usd)} | ${q.demand_score} |`);
    }
    lines.push('');
  } else {
    lines.push(d.index.rows === 0 ? '_Index is still warming up — retry in a minute._' : '_No quote asset matches these filters._');
    lines.push('');
  }
  lines.push('### How to read this');
  lines.push('Demand = traded share (40) + survival past day 3 (40) + paying share (20), minus a crowding penalty when 7d launches exceed twice the coins trading today. Survival is the share of coins older than 3 days that still traded in the last 24h. A quote marked (new) has no coin past day 3 yet: survival is unknown and demand is capped at 80.');
  lines.push('');
  for (const c of d.caveats) lines.push(`_${c}_`);
  lines.push('');
  lines.push(`Next: ${d.next_steps.join(' ')}`);
  return lines.join('\n');
}
