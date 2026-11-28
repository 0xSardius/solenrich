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

export const TRENCHES_SEEDS_DERIVED_AT = '2026-11-28';

/**
 * Wallets that passed the automatic gates but are not worth following. test/trenches-onchain-merge.ts skips them,
 * so a daily re-run cannot add them back. Add the reason and the date checked.
 */
export const TRENCHES_SEED_EXCLUDED: Readonly<Record<string, string>> = {
  // 2026-11-26: 7 of 7 recent buys were exactly 0.0015 SOL, and 47 of its last 100 txs close token accounts.
  // A dust buyer, not a trader: $29.77 PnL over 117 trades. It was 8 of the 10 signals in one smart-money run.
  EKfGSeHeyhCpZjDHWykbKJPCgfjEiLGFPJo9KKtsoHu6: 'fixed dust-size buys, account-closing pattern',
};

export const TRENCHES_SMART_MONEY_SEEDS: readonly TrenchesSeed[] = [
  // --- 2026-11-28 on-chain rebuild (test/trenches-onchain-seeds.ts): 13 wallets passed 10+ closed trades, ≥ 50% win, PnL > 0 over 14 d (quote-leg PnL),
  //     human cadence (< 15 tx/h, no bot flags), active in the last 7 d. Sorted by 14-day PnL.
  { address: 'HRZhHFizBrEUhaTqhbuocaUxj9yubM7x6MER28X8JYYs', realized_1w_usd: null, win_rate: 0.99, tx_per_h: 1, pnl_14d_usd: 83560.89, closed_trades_14d: 98, vetted_at: '2026-11-28', note: 're-vetted current seed' },
  { address: '76bMt4a4k3ZauLAwRurvPcLZFBGjF77ZxA1BL6mYWMuW', realized_1w_usd: null, win_rate: 0.967, tx_per_h: 1.2, pnl_14d_usd: 2322.17, closed_trades_14d: 30, vetted_at: '2026-11-28' },
  { address: 'BHEdepwWgQjcFbW25moXbSEvW14PNzLVaT4oD77xKgkD', realized_1w_usd: null, win_rate: 0.769, tx_per_h: 0.6, pnl_14d_usd: 1076.89, closed_trades_14d: 65, vetted_at: '2026-11-28', note: 're-vetted current seed' },
  { address: 'EBJPmrt3GwNwoV2wVpiRYavuiuMwvXkoaLHat1XJMB8', realized_1w_usd: null, win_rate: 0.839, tx_per_h: 0.7, pnl_14d_usd: 489.46, closed_trades_14d: 31, vetted_at: '2026-11-28' },
  { address: '8PBvJGA6bBw3tNVu79mB2nujV16yhZHpTmh8Fx1waxQM', realized_1w_usd: null, win_rate: 0.78, tx_per_h: 0.5, pnl_14d_usd: 224.87, closed_trades_14d: 59, vetted_at: '2026-11-28', note: 're-vetted current seed' },
  { address: '58j7NgrbdgmXH99JZtN2R1D3HsaW2nPnhDwMHcy533Q9', realized_1w_usd: null, win_rate: 0.6, tx_per_h: 0.1, pnl_14d_usd: 175.5, closed_trades_14d: 25, vetted_at: '2026-11-28', note: 're-vetted current seed' },
  { address: '6a5rvJU7EoEP5xCYoaifafSmH3FJEtm6ESxaAjjKx2HB', realized_1w_usd: null, win_rate: 0.542, tx_per_h: 2, pnl_14d_usd: 143.28, closed_trades_14d: 24, vetted_at: '2026-11-28', note: 're-vetted current seed' },
  { address: 'jnCCQpdxHB768TDrHBU1Rxpeme8qR3e2HrpcW1DJUgu', realized_1w_usd: null, win_rate: 0.667, tx_per_h: 2.5, pnl_14d_usd: 77.29, closed_trades_14d: 18, vetted_at: '2026-11-28' },
  { address: 'FKCszxXJtrqWdG2jfQuq7Z2cEA4BxxHSZpGUYgUh7WWv', realized_1w_usd: null, win_rate: 0.857, tx_per_h: 0.2, pnl_14d_usd: 37.47, closed_trades_14d: 14, vetted_at: '2026-11-28', note: 're-vetted current seed' },
  { address: 'G3yc6fe3i7YBZjghWZdPUqBi973jVyvKbM5sBjtFe8JP', realized_1w_usd: null, win_rate: 0.651, tx_per_h: 0.9, pnl_14d_usd: 22.43, closed_trades_14d: 43, vetted_at: '2026-11-28', note: 're-vetted current seed' },
  { address: '8bCYrot9G6sL9vLP3AaJ6A48uQt2e8zZbaKyiy9nbxxK', realized_1w_usd: null, win_rate: 0.542, tx_per_h: 0.3, pnl_14d_usd: 10.7, closed_trades_14d: 24, vetted_at: '2026-11-28' },
  { address: 'EJNF99Q1qwez1HNJe2Y6uNbEBPfwHFmkJXNYvSJ9kd5P', realized_1w_usd: null, win_rate: 0.5, tx_per_h: 5, pnl_14d_usd: 5.96, closed_trades_14d: 46, vetted_at: '2026-11-28' },
  { address: 'G3PLPWfufXio2VY2ydb7wNYerU89TPH9oTkLtBiQg52F', realized_1w_usd: null, win_rate: 0.667, tx_per_h: 0.8, pnl_14d_usd: 2.13, closed_trades_14d: 45, vetted_at: '2026-11-28', note: 're-vetted current seed' },
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
