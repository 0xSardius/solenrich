// Vetted smart-money seed set for smart-money-trenches.
//
// Bootstrap: manual-seed-now / auto-derive-later (decision locked 2026-07-06).
// Derivation: Birdeye gainers-losers 1W leaderboard filtered to realized-PnL
// winners, intersected with known-runner miners (ANSEM/JOTCHUA/TRIPLET/NEET/
// BUTTCOIN), then vetted through our own stack (Helius cadence + bot-detection
// + copy-trade). 15 bots were filtered out. Frozen derivation preserved in
// test/trenches-seed-candidates.json — the leaderboard is a rolling 1W window,
// so re-running the bootstrap scripts yields different candidates.
//
// vsTw91 + H8MQeg promoted from FLAG per the 2026-07-06 pending decision
// (strong realized PnL + win rates; cadence within human range).
//
// The vetting is point-in-time — wallets get sold, repurposed, or turn into
// bots. The enricher re-checks live cadence (tx_per_h) on every run and skips
// seeds that now look automated. See TX_PER_H_FILTER below.

/** An active-trader seed: a realized-PnL winner with human-mirrorable cadence. */
export interface TrenchesSeed {
  address: string;
  /** Realized PnL (USD) over the leaderboard's 1W window at derivation time. */
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

export const TRENCHES_SEEDS_DERIVED_AT = '2026-07-06';

export const TRENCHES_SMART_MONEY_SEEDS: readonly TrenchesSeed[] = [
  // Promoted from FLAG 2026-07-06 (top realized PnL in the whole candidate
  // set; flagged only on leaderboard trade volume). tx_per_h re-measured live
  // 2026-07-07 — both human-cadence.
  { address: 'vsTw91AUb4N91zdACyhuz31ctkQZCfY89iTF5pvCWDr', realized_1w_usd: 292_000, win_rate: 0.62, tx_per_h: 4.2, note: '62% win over 156 trades — strongest vetted wallet' },
  { address: 'H8MQegokeJxeWfNiD3MNk8Bykso99s7qWGdtTKu3hmZY', realized_1w_usd: 269_000, win_rate: 0.41, tx_per_h: 1.5 },
  // Original KEEP set (realized winners, human cadence)
  { address: 'C8HH76sDWvTPHeVnndSxAgj2VrMSpxEpwgc5rFUwD55Y', realized_1w_usd: 246_000, win_rate: 0.43, tx_per_h: 2.2 },
  { address: 'GkdYWRjFzZW3oxbRaPJ43C5385E4GtfgW3vwfK2ZAtac', realized_1w_usd: 214_000, win_rate: 0.20, tx_per_h: 1.3, runner: 'ANSEM' },
  { address: '6PeU2nLzwWv9V5BKqJBsoq88tAfULjQq9VcUYWK2KW5w', realized_1w_usd: 162_000, win_rate: 0.33, tx_per_h: 1.0 },
  { address: 'FdhpxuCPYWM98q5q1rHLAYRfXFsHUCzaos5ogz4prR7r', realized_1w_usd: 159_000, win_rate: 0.47, tx_per_h: 1.0 },
  { address: '2S8E25nAcqvvMYEWZHBQk22GzevwvmsVNAs6Gw5tRX7d', realized_1w_usd: 63_000, win_rate: null, tx_per_h: 1.0 },
  { address: 'HeGgXZexkC2qKmgjfsyB6cbLU7QR8cjcq6bChJGUKjWr', realized_1w_usd: 55_000, win_rate: null, tx_per_h: 0.3, note: 'ultra-selective, 70 tx / 235h' },
  { address: '9Z6B2crrMeMPU4EM4fpSRWgFbSMmjzamekeumMwzkXEh', realized_1w_usd: 33_000, win_rate: 0.27, tx_per_h: 1.0 },
  { address: '3SdVtYPdnQw2b8WSE2T1VeexAqkDjbTyeSZ8Pzs6bgou', realized_1w_usd: 14_000, win_rate: null, tx_per_h: 2.4, runner: 'ANSEM' },
  { address: '8MHU3NwzuwpkcrF8S2nzNXbkCWn3TdE9UVtB3bQWJP7b', realized_1w_usd: 4_000, win_rate: null, tx_per_h: 1.0, runner: 'ANSEM' },
];

// Tracked separately from active traders: their signal is holding through
// runners, not trade cadence — a buy from one of these carries different
// weight than a buy from a scalper. Included in scans but tagged.
export const TRENCHES_CONVICTION_HOLDERS: readonly ConvictionHolder[] = [
  { address: '5fkAwNVpT8A1UHEnY62VEFpqgagdoP8FYrv5ideiQp5c', runners: ['TRIPLET', 'NEET'] },
  { address: '22by6osx7q9XX6na4SxuKozd4KMQeJhaoVLeUnBqRXoz', runners: ['TRIPLET', 'NEET'] },
  { address: '9SBvvPiuXHekiJ8XyPxhWVSa23YHhonD2ATBZTveUbcE', runners: ['NEET', 'BUTTCOIN'] },
];

// Live-cadence bot guard thresholds (from test/trenches-vet-seeds.ts):
// the labeler's detectHighFrequency/detect247Active have min-window guards
// (>=1h / >=48h) that ultra-fast bots evade when their 100-sig sample spans
// under an hour — raw tx/hour is the discriminator that caught them.
/** At or above this rate a seed is skipped for the current scan (burst bot). */
export const TX_PER_H_FILTER = 60;
/** At or above this rate a seed's buys are kept but tagged elevated_cadence. */
export const TX_PER_H_FLAG = 15;
