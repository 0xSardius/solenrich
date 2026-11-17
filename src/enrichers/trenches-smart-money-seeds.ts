// Vetted smart-money seed set for smart-money-trenches.
//
// Two derivations, same pipeline (discover on Birdeye -> vet through our own
// cadence/bot/copy-trade stack):
//   2026-07-06 — original 14 (test/trenches-{build,vet}-seeds.ts, top-of-board only).
//   2026-08-27 — widened via DEEP leaderboard sweep (test/trenches-widen-seeds.ts).
//     Finding: Birdeye's gainers board sorts by TOTAL PnL, so realized-PnL
//     winners sit thousands of rows deep ($110K+ realized still at offset 400).
//     One deep sweep yielded 844 candidates -> 302 passed the cadence vet.
//
//   2026-11-17 — REBUILT on-chain (test/trenches-onchain-seeds.ts → trenches-onchain-merge.ts). Birdeye is
//     unavailable, and every earlier seed had been vetted with copy-trade PnL that was wrong (one price for both
//     legs). Honest re-vet of the 100 live traders: 73 inactive (no tx in 7 d), 5 bot cadence, the rest mostly no
//     closed trades or large losers (worst −$20,759) — 1 passed. Plus 9 of 200 on-chain candidates (traders of the
//     28 busiest trending tokens). Re-run daily for a week to grow the pool: each run re-vets the current seeds too,
//     so wallets that go quiet or start losing drop out. Gates and numbers per wallet: test/trenches-onchain-result.json.
//
// LIVE set = passing wallets, top 100 by measured 14-day PnL — capped because the endpoint scans every seed per
// call and Helius throttles parallel reads. The old Birdeye-era pool stays in test/trenches-widen-result.json.
//
// The vetting is point-in-time — wallets get sold, repurposed, or turn into
// bots. The enricher re-checks live cadence (tx_per_h) on every run and skips
// seeds that now look automated. See TX_PER_H_FILTER below.

/** An active-trader seed: a realized-PnL winner with human-mirrorable cadence. */
export interface TrenchesSeed {
  address: string;
  /** Birdeye realized PnL (USD) over the leaderboard window at derivation time. Null for on-chain-derived seeds
   *  (2026-11-17 rebuild: Birdeye unavailable) — see pnl_14d_usd. */
  realized_1w_usd: number | null;
  /** Our copy-trade win rate at vetting time; null when pricing gaps yielded 0 trades. */
  win_rate: number | null;
  /** Our measured copy-trade PnL (quote-leg) over 14 days at vetting time. */
  pnl_14d_usd?: number;
  closed_trades_14d?: number;
  vetted_at?: string;
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

export const TRENCHES_SEEDS_DERIVED_AT = '2026-11-17';

export const TRENCHES_SMART_MONEY_SEEDS: readonly TrenchesSeed[] = [
  // --- 2026-11-17 on-chain rebuild (test/trenches-onchain-seeds.ts): 8 wallets passed 10+ closed trades, ≥ 50% win, PnL > 0 over 14 d (quote-leg PnL),
  //     human cadence (< 15 tx/h, no bot flags), active in the last 7 d. Sorted by 14-day PnL.
  { address: '7CW5UAwob1uSKXfgqjm8GyjuB5GZnN3XeXFtGvk1n6aq', realized_1w_usd: null, win_rate: 0.879, tx_per_h: 9.8, pnl_14d_usd: 2455.55, closed_trades_14d: 165, vetted_at: '2026-11-17' },
  { address: '2QKECLPQWM4CRHaY55WKPFYD9YU9XzgXgK5cJYi5T51d', realized_1w_usd: null, win_rate: 0.65, tx_per_h: 0.6, pnl_14d_usd: 1436.39, closed_trades_14d: 123, vetted_at: '2026-11-17', note: 're-vetted current seed' },
  { address: 'EibS7GnCDvo3mJYWEZdGsGUX9cDZiMi9ubFas4FSfM8X', realized_1w_usd: null, win_rate: 0.792, tx_per_h: 0.9, pnl_14d_usd: 272.06, closed_trades_14d: 48, vetted_at: '2026-11-17' },
  { address: '77qkxnstrFZY62hh2puqSNcnUwVFun8pMWqVAqcVBMYW', realized_1w_usd: null, win_rate: 0.667, tx_per_h: 1.9, pnl_14d_usd: 126.02, closed_trades_14d: 69, vetted_at: '2026-11-17' },
  { address: 'H2oTjpoEeuUHGdSc9n9SBMBjZvGZFafbLGjiytTi6X3q', realized_1w_usd: null, win_rate: 0.535, tx_per_h: 4.7, pnl_14d_usd: 33.7, closed_trades_14d: 129, vetted_at: '2026-11-17', note: 're-vetted current seed' },
  { address: 'CQFZyWn4QQiEjz4bXs6gUAGndJ6Hj6PaSTwezaHJnfyh', realized_1w_usd: null, win_rate: 0.5, tx_per_h: 1.1, pnl_14d_usd: 10.12, closed_trades_14d: 20, vetted_at: '2026-11-17' },
  { address: '3oqaJrdUPkxHq62yuBVh4xmD9WAPMSSxdsbyVcXaMmJr', realized_1w_usd: null, win_rate: 0.864, tx_per_h: 5.7, pnl_14d_usd: 8.69, closed_trades_14d: 22, vetted_at: '2026-11-17', note: 're-vetted current seed' },
  { address: '5p7asYyBQMSLB4HLDBnJ239VjSD9RXiCrVkLgdDKD1FG', realized_1w_usd: null, win_rate: 0.513, tx_per_h: 4.4, pnl_14d_usd: 7.23, closed_trades_14d: 80, vetted_at: '2026-11-17', note: 're-vetted current seed' },
];

// Tracked separately from active traders: their signal is holding through
// runners, not trade cadence — a buy from one of these carries different
// weight than a buy from a scalper. Included in scans but tagged.
export const TRENCHES_CONVICTION_HOLDERS: readonly ConvictionHolder[] = [
  { address: '5fkAwNVpT8A1UHEnY62VEFpqgagdoP8FYrv5ideiQp5c', runners: ['TRIPLET', 'NEET'] },
  { address: '22by6osx7q9XX6na4SxuKozd4KMQeJhaoVLeUnBqRXoz', runners: ['TRIPLET', 'NEET'] },
  { address: '9SBvvPiuXHekiJ8XyPxhWVSa23YHhonD2ATBZTveUbcE', runners: ['NEET', 'BUTTCOIN'] },
  { address: 'AH39BneW9UeWxQysUcwogQrYFdPvJuRVZ5w4ccq9SKfL', runners: ['TRIPLET', 'NEET'] }, // widened 2026-08-27
  { address: 'H48YLNt9UmQwhoED4utw8uqKKqi5h7u4a6WTuxeZpDtN', runners: ['ANTSEM', 'cat'] }, // widened 2026-08-27
  { address: '6bQSN4d6anoTwnE6XDPGLA9RV8cqZPeNJro4iQUsWmso', runners: ['BUTTCOIN', 'Grokstreet'] }, // widened 2026-08-27
];

// Live-cadence bot guard thresholds (from test/trenches-vet-seeds.ts):
// the labeler's detectHighFrequency/detect247Active have min-window guards
// (>=1h / >=48h) that ultra-fast bots evade when their 100-sig sample spans
// under an hour — raw tx/hour is the discriminator that caught them.
/** At or above this rate a seed is skipped for the current scan (burst bot). */
export const TX_PER_H_FILTER = 60;
/** At or above this rate a seed's buys are kept but tagged elevated_cadence. */
export const TX_PER_H_FLAG = 15;
