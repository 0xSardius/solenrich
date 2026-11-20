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

export const TRENCHES_SEEDS_DERIVED_AT = '2026-11-20';

export const TRENCHES_SMART_MONEY_SEEDS: readonly TrenchesSeed[] = [
  // --- 2026-11-20 on-chain rebuild (test/trenches-onchain-seeds.ts): 21 wallets passed 10+ closed trades, ≥ 50% win, PnL > 0 over 14 d (quote-leg PnL),
  //     human cadence (< 15 tx/h, no bot flags), active in the last 7 d. Sorted by 14-day PnL.
  { address: '2QKECLPQWM4CRHaY55WKPFYD9YU9XzgXgK5cJYi5T51d', realized_1w_usd: null, win_rate: 0.649, tx_per_h: 0.4, pnl_14d_usd: 1356.59, closed_trades_14d: 111, vetted_at: '2026-11-20', note: 're-vetted current seed' },
  { address: 'BHEdepwWgQjcFbW25moXbSEvW14PNzLVaT4oD77xKgkD', realized_1w_usd: null, win_rate: 0.923, tx_per_h: 2.2, pnl_14d_usd: 1273.92, closed_trades_14d: 39, vetted_at: '2026-11-20' },
  { address: 'B41RZUtDerYNCivP3Yddyxj2Qa9rtDoj9PE64RJFCSbi', realized_1w_usd: null, win_rate: 0.588, tx_per_h: 4.7, pnl_14d_usd: 593.7, closed_trades_14d: 17, vetted_at: '2026-11-20' },
  { address: 'EibS7GnCDvo3mJYWEZdGsGUX9cDZiMi9ubFas4FSfM8X', realized_1w_usd: null, win_rate: 0.757, tx_per_h: 5.7, pnl_14d_usd: 307.68, closed_trades_14d: 37, vetted_at: '2026-11-20', note: 're-vetted current seed' },
  { address: 'CrVYou9maQdsJ8w1aweJ55r28ahPTJhUZQ8DaCFdFX1W', realized_1w_usd: null, win_rate: 0.632, tx_per_h: 6.1, pnl_14d_usd: 253.02, closed_trades_14d: 57, vetted_at: '2026-11-20' },
  { address: '58j7NgrbdgmXH99JZtN2R1D3HsaW2nPnhDwMHcy533Q9', realized_1w_usd: null, win_rate: 0.818, tx_per_h: 0.2, pnl_14d_usd: 233.83, closed_trades_14d: 11, vetted_at: '2026-11-20' },
  { address: '8PBvJGA6bBw3tNVu79mB2nujV16yhZHpTmh8Fx1waxQM', realized_1w_usd: null, win_rate: 0.933, tx_per_h: 2.2, pnl_14d_usd: 178.77, closed_trades_14d: 15, vetted_at: '2026-11-20' },
  { address: 'FKCszxXJtrqWdG2jfQuq7Z2cEA4BxxHSZpGUYgUh7WWv', realized_1w_usd: null, win_rate: 0.857, tx_per_h: 0.2, pnl_14d_usd: 126.59, closed_trades_14d: 14, vetted_at: '2026-11-20' },
  { address: '5To3WPivEc8qVRMZB83ghVLAGZY8gFPMiCqrD2bae21L', realized_1w_usd: null, win_rate: 0.929, tx_per_h: 9.7, pnl_14d_usd: 42.55, closed_trades_14d: 28, vetted_at: '2026-11-20' },
  { address: '6VzAGvdhP2ycigEs9xDuhahhKqZrfgMa17ebb2hMa9r9', realized_1w_usd: null, win_rate: 1, tx_per_h: 3.5, pnl_14d_usd: 33.37, closed_trades_14d: 15, vetted_at: '2026-11-20' },
  { address: '9DbNS1FGeotzxfAH8HmbV6JPWjoNThusy74CPgJVL8AC', realized_1w_usd: null, win_rate: 0.737, tx_per_h: 10.1, pnl_14d_usd: 17.32, closed_trades_14d: 19, vetted_at: '2026-11-20' },
  { address: '4SnZt81C7FxAg8Z4NCV1srGf9BW4Tgeyy5row69iDSvo', realized_1w_usd: null, win_rate: 0.643, tx_per_h: 6.3, pnl_14d_usd: 10.65, closed_trades_14d: 14, vetted_at: '2026-11-20' },
  { address: '27tVYARg4tLR3Cw5mHVW2d15ebvSm92pCa5ZGEDkpjQG', realized_1w_usd: null, win_rate: 0.706, tx_per_h: 8.8, pnl_14d_usd: 8.48, closed_trades_14d: 17, vetted_at: '2026-11-20' },
  { address: '3oqaJrdUPkxHq62yuBVh4xmD9WAPMSSxdsbyVcXaMmJr', realized_1w_usd: null, win_rate: 0.864, tx_per_h: 5.7, pnl_14d_usd: 8.46, closed_trades_14d: 22, vetted_at: '2026-11-20', note: 're-vetted current seed' },
  { address: 'G3yc6fe3i7YBZjghWZdPUqBi973jVyvKbM5sBjtFe8JP', realized_1w_usd: null, win_rate: 0.7, tx_per_h: 0.6, pnl_14d_usd: 8.25, closed_trades_14d: 20, vetted_at: '2026-11-20' },
  { address: 'GDFfadJuwkQ1LkjyP4KFNd4N1PHvQi55CHCvQ9NoWnVP', realized_1w_usd: null, win_rate: 0.692, tx_per_h: 9.4, pnl_14d_usd: 5.12, closed_trades_14d: 13, vetted_at: '2026-11-20' },
  { address: 'G3PLPWfufXio2VY2ydb7wNYerU89TPH9oTkLtBiQg52F', realized_1w_usd: null, win_rate: 0.75, tx_per_h: 8.6, pnl_14d_usd: 5.04, closed_trades_14d: 36, vetted_at: '2026-11-20' },
  { address: '7pbnXYFZoXbfojtHD3bVpv9vbTbAcBn21bmAQ3qG3y53', realized_1w_usd: null, win_rate: 0.625, tx_per_h: 4.1, pnl_14d_usd: 3.84, closed_trades_14d: 24, vetted_at: '2026-11-20' },
  { address: '45VtDLDDWEyAU7imesaPv11mW89vE62fnVExrfdmnQA7', realized_1w_usd: null, win_rate: 0.667, tx_per_h: 0.1, pnl_14d_usd: 3.1, closed_trades_14d: 12, vetted_at: '2026-11-20' },
  { address: '3Nz5nYsNskZSDQQzCbhob8fPgks2kwXdvWK9fsdu7cG1', realized_1w_usd: null, win_rate: 0.595, tx_per_h: 6.9, pnl_14d_usd: 3.08, closed_trades_14d: 37, vetted_at: '2026-11-20' },
  { address: '425srLLJnQzMgW8q79Yun9Ukb8YdV6XtJwNYg45AvrjP', realized_1w_usd: null, win_rate: 0.778, tx_per_h: 4.1, pnl_14d_usd: 1.92, closed_trades_14d: 18, vetted_at: '2026-11-20' },
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
