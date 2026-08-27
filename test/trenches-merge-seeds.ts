// Merge widened KEEPs (test/trenches-widen-result.json) into the live seed file.
//
// The live endpoint scans every seed per call, and Helius throttles well below
// 8 parallel requests, so the LIVE set is capped at 100 active traders — the
// quality-gated top of the widened pool. The full accumulated pool stays in
// trenches-widen-result.json as the extended universe for Eris's offline loop.
//
// Quality gates on new entries (beyond the cadence vet):
//   - measured win rate under 20% over 10+ analyzed trades → out
//   - measured win rate of 0% over 3+ analyzed trades → out
// Run: bun run test/trenches-merge-seeds.ts

import { readFileSync, writeFileSync } from 'fs';
import {
  TRENCHES_SMART_MONEY_SEEDS,
  TRENCHES_CONVICTION_HOLDERS,
  type TrenchesSeed,
} from '../src/enrichers/trenches-smart-money-seeds';

const LIVE_CAP = 100;
const result = JSON.parse(readFileSync('test/trenches-widen-result.json', 'utf8'));
const keeps: any[] = result.keeps ?? [];

const existing = new Set(TRENCHES_SMART_MONEY_SEEDS.map((s) => s.address));
const holders = new Set(TRENCHES_CONVICTION_HOLDERS.map((h) => h.address));

const gated = keeps.filter((k) => {
  if (existing.has(k.addr) || holders.has(k.addr)) return false;
  if (k.win_rate != null && k.ct_trades >= 10 && k.win_rate < 0.2) return false;
  if (k.win_rate === 0 && (k.ct_trades ?? 0) >= 3) return false;
  return true;
});

// Active-trader candidates: anything with leaderboard-verified realized PnL,
// or runner-linked wallets whose measured win rate clears 25%.
const traders = gated
  .filter((k) => (k.realized ?? 0) > 0 || (k.win_rate ?? 0) >= 0.25)
  .sort((a, b) => (a.tier - b.tier) || ((b.realized ?? 0) - (a.realized ?? 0)))
  .slice(0, LIVE_CAP - TRENCHES_SMART_MONEY_SEEDS.length);

// Conviction-holder candidates: runner-linked, very low cadence, 2+ runners.
const newHolders = gated.filter(
  (k) =>
    !traders.includes(k) &&
    (k.runners?.length ?? 0) >= 2 &&
    k.tx_per_h <= 2 &&
    (k.realized ?? 0) === 0,
);

const esc = (s: string) => s.replace(/'/g, "\\'");
const fmtSeed = (s: TrenchesSeed) =>
  `  { address: '${s.address}', realized_1w_usd: ${s.realized_1w_usd}, win_rate: ${s.win_rate ?? 'null'}, tx_per_h: ${s.tx_per_h}${s.runner ? `, runner: '${esc(s.runner)}'` : ''}${s.note ? `, note: '${esc(s.note)}'` : ''} },`;
const fmtNew = (k: any) => {
  const note = [k.window ? `board:${k.window}` : null, 'widened 2026-08-27'].filter(Boolean).join(', ');
  const runner = k.runners?.length ? k.runners[0].replace('LIVE:', '') : undefined;
  return fmtSeed({
    address: k.addr,
    realized_1w_usd: Math.round(k.realized ?? 0),
    win_rate: k.win_rate ?? null,
    tx_per_h: k.tx_per_h,
    ...(runner ? { runner } : {}),
    note,
  });
};

const file = `// Vetted smart-money seed set for smart-money-trenches.
//
// Two derivations, same pipeline (discover on Birdeye -> vet through our own
// cadence/bot/copy-trade stack):
//   2026-07-06 — original 14 (test/trenches-{build,vet}-seeds.ts, top-of-board only).
//   2026-08-27 — widened via DEEP leaderboard sweep (test/trenches-widen-seeds.ts).
//     Finding: Birdeye's gainers board sorts by TOTAL PnL, so realized-PnL
//     winners sit thousands of rows deep ($110K+ realized still at offset 400).
//     One deep sweep yielded 844 candidates -> 302 passed the cadence vet.
//
// LIVE set = top ${LIVE_CAP} by tier/realized with win-rate gates — capped because the
// endpoint scans every seed per call and Helius throttles parallel reads. The
// full accumulated pool (${keeps.length} vetted wallets) lives in
// test/trenches-widen-result.json as the extended universe for offline loops.
//
// The vetting is point-in-time — wallets get sold, repurposed, or turn into
// bots. The enricher re-checks live cadence (tx_per_h) on every run and skips
// seeds that now look automated. See TX_PER_H_FILTER below.

/** An active-trader seed: a realized-PnL winner with human-mirrorable cadence. */
export interface TrenchesSeed {
  address: string;
  /** Realized PnL (USD) over the leaderboard window at derivation time. */
  realized_1w_usd: number;
  /** Our copy-trade win rate at vetting time; null when pricing gaps yielded 0 trades. */
  win_rate: number | null;
  /** tx/hour over the 100-sig vetting sample. All well under bot thresholds. */
  tx_per_h: number;
  /** Known runner this wallet traded (provenance tag), if any. */
  runner?: string;
  note?: string;
}

/** A conviction holder: bought 2+ known runners and held — not an active trader. */
export interface ConvictionHolder {
  address: string;
  runners: string[];
}

export const TRENCHES_SEEDS_DERIVED_AT = '2026-08-27';

export const TRENCHES_SMART_MONEY_SEEDS: readonly TrenchesSeed[] = [
  // --- Original 2026-07-06 vetted set (kept verbatim) ---
${TRENCHES_SMART_MONEY_SEEDS.map(fmtSeed).join('\n')}
  // --- Widened 2026-08-27 (deep-sweep derivation, quality-gated) ---
${traders.map(fmtNew).join('\n')}
];

// Tracked separately from active traders: their signal is holding through
// runners, not trade cadence — a buy from one of these carries different
// weight than a buy from a scalper. Included in scans but tagged.
export const TRENCHES_CONVICTION_HOLDERS: readonly ConvictionHolder[] = [
${TRENCHES_CONVICTION_HOLDERS.map((h) => `  { address: '${h.address}', runners: [${h.runners.map((r) => `'${esc(r)}'`).join(', ')}] },`).join('\n')}
${newHolders.map((k) => `  { address: '${k.addr}', runners: [${k.runners.map((r: string) => `'${esc(r.replace('LIVE:', ''))}'`).join(', ')}] }, // widened 2026-08-27`).join('\n')}
];

// Live-cadence bot guard thresholds (from test/trenches-vet-seeds.ts):
// the labeler's detectHighFrequency/detect247Active have min-window guards
// (>=1h / >=48h) that ultra-fast bots evade when their 100-sig sample spans
// under an hour — raw tx/hour is the discriminator that caught them.
/** At or above this rate a seed is skipped for the current scan (burst bot). */
export const TX_PER_H_FILTER = 60;
/** At or above this rate a seed's buys are kept but tagged elevated_cadence. */
export const TX_PER_H_FLAG = 15;
`;

writeFileSync('src/enrichers/trenches-smart-money-seeds.ts', file);
console.log(`existing traders: ${TRENCHES_SMART_MONEY_SEEDS.length}`);
console.log(`gated pool: ${gated.length} of ${keeps.length} accumulated keeps`);
console.log(`new traders written: ${traders.length} (live set: ${TRENCHES_SMART_MONEY_SEEDS.length + traders.length})`);
console.log(`new conviction holders: ${newHolders.length} (total: ${TRENCHES_CONVICTION_HOLDERS.length + newHolders.length})`);
