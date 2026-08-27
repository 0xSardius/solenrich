// Measure the Eris trigger rate against the CURRENT seed set.
// Baseline (2026-07-24, 14 seeds, 72h window): 26 total buys, 10 buys on <48h
// tokens, 2 distinct fresh tokens, 0 consensus events, 5/14 seeds silent.
// Trigger = a vetted seed buys a token younger than 48h. Consensus = 2+ seeds.
// Run: bun run test/trenches-measure-triggers.ts

import { Cache } from '../src/cache';
import { HeliusClient } from '../src/sources/helius';
import { DexScreenerClient } from '../src/sources/dexscreener';
import { CopyTradeAnalyzer } from '../src/enrichers/copy-trade-analyzer';
import { TrenchesSmartMoneyAnalyzer } from '../src/enrichers/trenches-smart-money';
import {
  TRENCHES_SMART_MONEY_SEEDS,
  TRENCHES_CONVICTION_HOLDERS,
} from '../src/enrichers/trenches-smart-money-seeds';

const cache = new Cache();
const helius = new HeliusClient(cache);
const dexscreener = new DexScreenerClient(cache);
const copyTrade = new CopyTradeAnalyzer(helius, dexscreener, cache);
const analyzer = new TrenchesSmartMoneyAnalyzer(helius, dexscreener, copyTrade, cache);

const HOURS_BACK = 24;
const seedCount = TRENCHES_SMART_MONEY_SEEDS.length + TRENCHES_CONVICTION_HOLDERS.length;

console.log(`Seed set: ${TRENCHES_SMART_MONEY_SEEDS.length} active traders + ${TRENCHES_CONVICTION_HOLDERS.length} conviction holders = ${seedCount}`);
console.log(`Window: ${HOURS_BACK}h (min_buyers=1, max_token_age=48h)\n`);

const t0 = Date.now();
const r = await analyzer.enrich(HOURS_BACK, 48, 1, 50);
const elapsed = (Date.now() - t0) / 1000;

const consensus = r.signals.filter((s) => s.smart_buyers >= 2);
const perDay = (n: number) => ((n * 24) / HOURS_BACK).toFixed(1);

console.log(`elapsed: ${elapsed.toFixed(1)}s (paid-endpoint latency proxy at this seed count)`);
console.log(`seeds scanned: ${r.seeds_scanned} | skipped (live bot cadence): ${r.seeds_skipped_bot_cadence.length} | flagged elevated: ${r.seeds_flagged_elevated_cadence.length}`);
console.log(`total buys in window: ${r.total_recent_buys} (${perDay(r.total_recent_buys)}/day)`);
console.log(`buys on older tokens: ${r.buys_on_older_tokens} | unknown age: ${r.buys_unknown_age}`);
console.log(`\nDISTINCT FRESH TOKENS (= raw trigger rate): ${r.signals.length} (${perDay(r.signals.length)}/day)`);
console.log(`CONSENSUS (2+ seeds on same token): ${consensus.length}`);
console.log(`\nBaseline 2026-07-24 (14 seeds): 0.7 fresh tokens/day, 0 consensus.`);
console.log(`Channel-viability target: ~5-7 candidates/day pre-gate.\n`);

for (const s of r.signals.slice(0, 15)) {
  console.log(
    `  ${s.symbol ?? '?'} (${s.mint.slice(0, 6)}…) age=${s.token_age_hours}h buyers=${s.smart_buyers}` +
      `${s.conviction_holder_buyers > 0 ? ` (+${s.conviction_holder_buyers} holders)` : ''} spent=$${Math.round(s.total_spent_usd)} latest=${s.most_recent_buy_minutes_ago}m ago`,
  );
}
