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
// LIVE set = top 100 by tier/realized with win-rate gates — capped because the
// endpoint scans every seed per call and Helius throttles parallel reads. The
// full accumulated pool (315 vetted wallets) lives in
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
  { address: 'vsTw91AUb4N91zdACyhuz31ctkQZCfY89iTF5pvCWDr', realized_1w_usd: 292000, win_rate: 0.62, tx_per_h: 4.2, note: '62% win over 156 trades — strongest vetted wallet' },
  { address: 'H8MQegokeJxeWfNiD3MNk8Bykso99s7qWGdtTKu3hmZY', realized_1w_usd: 269000, win_rate: 0.41, tx_per_h: 1.5 },
  { address: 'C8HH76sDWvTPHeVnndSxAgj2VrMSpxEpwgc5rFUwD55Y', realized_1w_usd: 246000, win_rate: 0.43, tx_per_h: 2.2 },
  { address: 'GkdYWRjFzZW3oxbRaPJ43C5385E4GtfgW3vwfK2ZAtac', realized_1w_usd: 214000, win_rate: 0.2, tx_per_h: 1.3, runner: 'ANSEM' },
  { address: '6PeU2nLzwWv9V5BKqJBsoq88tAfULjQq9VcUYWK2KW5w', realized_1w_usd: 162000, win_rate: 0.33, tx_per_h: 1 },
  { address: 'FdhpxuCPYWM98q5q1rHLAYRfXFsHUCzaos5ogz4prR7r', realized_1w_usd: 159000, win_rate: 0.47, tx_per_h: 1 },
  { address: '2S8E25nAcqvvMYEWZHBQk22GzevwvmsVNAs6Gw5tRX7d', realized_1w_usd: 63000, win_rate: null, tx_per_h: 1 },
  { address: 'HeGgXZexkC2qKmgjfsyB6cbLU7QR8cjcq6bChJGUKjWr', realized_1w_usd: 55000, win_rate: null, tx_per_h: 0.3, note: 'ultra-selective, 70 tx / 235h' },
  { address: '9Z6B2crrMeMPU4EM4fpSRWgFbSMmjzamekeumMwzkXEh', realized_1w_usd: 33000, win_rate: 0.27, tx_per_h: 1 },
  { address: '3SdVtYPdnQw2b8WSE2T1VeexAqkDjbTyeSZ8Pzs6bgou', realized_1w_usd: 14000, win_rate: null, tx_per_h: 2.4, runner: 'ANSEM' },
  { address: '8MHU3NwzuwpkcrF8S2nzNXbkCWn3TdE9UVtB3bQWJP7b', realized_1w_usd: 4000, win_rate: null, tx_per_h: 1, runner: 'ANSEM' },
  // --- Widened 2026-08-27 (deep-sweep derivation, quality-gated) ---
  { address: '3AWDTDGZiW8joyfA52LKL7GUWLoKBCBUBLUE5JoWgBCu', realized_1w_usd: 100507, win_rate: 0, tx_per_h: 0.2, runner: 'ANSEM', note: 'board:1W, widened 2026-08-27' },
  { address: '5mwr4djV5esaJgkajoVZBJ28rjomZLUDSYmvbGnEAu4t', realized_1w_usd: 41172, win_rate: 0, tx_per_h: 0.5, runner: 'ANSEM', note: 'board:1W, widened 2026-08-27' },
  { address: 'FLnMeVLh5RPhSRnhLsaNWiGxJxmULViqEzrQtheAzhts', realized_1w_usd: 37844, win_rate: 0, tx_per_h: 1.6, runner: 'TRIPLET', note: 'board:1W, widened 2026-08-27' },
  { address: '74mtfgTFwmaGsAUPVjvBcjHaKHLg89GDdbwcMjGgsAyT', realized_1w_usd: 1242859, win_rate: 0, tx_per_h: 4.8, note: 'board:1W, widened 2026-08-27' },
  { address: '3xxFnWrrNt9HGgVzyWv2PAhCEpxLHNBVD77Y3AqaZCuK', realized_1w_usd: 886224, win_rate: 0.212, tx_per_h: 4.1, note: 'board:1W, widened 2026-08-27' },
  { address: 'BWDm85wNcNXr32tcQjEimmAVbfFy5jfvpQ2Lwfpsx37N', realized_1w_usd: 321701, win_rate: 0.694, tx_per_h: 1.2, note: 'board:1W, widened 2026-08-27' },
  { address: '25beW6FBkPQxz9pn3adiCxsSHB6fhbjRoBAKy5xMTPWq', realized_1w_usd: 312157, win_rate: 0.281, tx_per_h: 1.1, note: 'board:1W, widened 2026-08-27' },
  { address: '2ZRko6sZABRc4DCxs91cLNKXi9NyUnFRq7G9n6m6mwqX', realized_1w_usd: 275047, win_rate: 0.504, tx_per_h: 8.1, note: 'board:1W, widened 2026-08-27' },
  { address: 'BvrcJ7vksBRBDn6WKiYSe2XuTc2mXt4TQmqvRgazAuqN', realized_1w_usd: 266573, win_rate: 0, tx_per_h: 11.4, note: 'board:1W, widened 2026-08-27' },
  { address: 'Cg3GP8ZGDCqydaKxKVMYnBVfaHWXNKgvZAUyNiXEFCqc', realized_1w_usd: 252103, win_rate: 0.528, tx_per_h: 1.4, note: 'board:1W, widened 2026-08-27' },
  { address: 'XhWSKapcao1cWok4WTSihpKw4bUX9VSJY56Z36jtKGR', realized_1w_usd: 234358, win_rate: 0, tx_per_h: 9.5, note: 'board:1W, widened 2026-08-27' },
  { address: '4vEZCyrekM3EZA2Aho4SUSiyCFXejb5BgLP68mwsa3Lt', realized_1w_usd: 233490, win_rate: 0, tx_per_h: 0.4, note: 'board:1W, widened 2026-08-27' },
  { address: '9mSr5yheHviKqnB7s8BnJ8TLHWJt8fyY8EmzqgQKv15a', realized_1w_usd: 216397, win_rate: 0.429, tx_per_h: 2, note: 'board:1W, widened 2026-08-27' },
  { address: '5caEAjyfdhzEYrAULKxY7hoW1bPTW4EH7HVqmdmpcq4R', realized_1w_usd: 204386, win_rate: 0, tx_per_h: 4.2, note: 'board:1W, widened 2026-08-27' },
  { address: '9qMAu9usi3sJpthoosprN1ydD9rmFbZVnqvM6RbgwDr8', realized_1w_usd: 190077, win_rate: 0.22, tx_per_h: 4.3, note: 'board:1W, widened 2026-08-27' },
  { address: 'wae8YMC7PWjcPbM3mdx3CUDZEkkjaFAE4VxS5mF2YuN', realized_1w_usd: 189172, win_rate: 0, tx_per_h: 2, note: 'board:1W, widened 2026-08-27' },
  { address: '7zRedD8Py7eDEfxd3afQHQGFcqyHtFhbKAzajafTe8fP', realized_1w_usd: 186209, win_rate: 0, tx_per_h: 1.1, note: 'board:1W, widened 2026-08-27' },
  { address: '47qDSjHW4192fpqywXFUC35WAeWvGH1SZyJbkv8TD9Pj', realized_1w_usd: 186072, win_rate: 0.32, tx_per_h: 4.2, note: 'board:1W, widened 2026-08-27' },
  { address: 'J1gQiJfnAjjhkkwXzE7R11mpWre78d1uzsEcMWKb9WFe', realized_1w_usd: 183616, win_rate: 0, tx_per_h: 10.7, note: 'board:1W, widened 2026-08-27' },
  { address: '7KvEcvjtRhAiMwUVi8W76DyMrXJYTRu3FqTRHBEErYLx', realized_1w_usd: 179013, win_rate: 0, tx_per_h: 1.9, note: 'board:1W, widened 2026-08-27' },
  { address: 'BMwSFBmMED9S44Y7DeTef3eEkfJnxL4X7pvfikzn9Nbi', realized_1w_usd: 178176, win_rate: 0, tx_per_h: 2, note: 'board:1W, widened 2026-08-27' },
  { address: '56pmfwXUDCcWaSECm97q3YaBjKvqPG9hApihxQZK6fLM', realized_1w_usd: 162445, win_rate: 0, tx_per_h: 2.7, note: 'board:1W, widened 2026-08-27' },
  { address: '4PvQLVNK9WzQu73xM1LNHRdQiGFGpzfHxiPzpq3PesaN', realized_1w_usd: 142669, win_rate: 0, tx_per_h: 4.3, note: 'board:1W, widened 2026-08-27' },
  { address: 'FJYLsK64oywhzcvJHNYokmU1KYdVDee3NJUNUPaav1ga', realized_1w_usd: 137327, win_rate: 0, tx_per_h: 0.6, note: 'board:1W, widened 2026-08-27' },
  { address: '14HEgX8zumL5DoxrWe6QcT93QVYdC5pkHAiGnKmppc4R', realized_1w_usd: 135499, win_rate: 0, tx_per_h: 8.8, note: 'board:1W, widened 2026-08-27' },
  { address: 'CN3NfnEoNwfpUayo2JW1TLNfWteCtnUZGKoa7WqcSCUG', realized_1w_usd: 134407, win_rate: 0, tx_per_h: 2, note: 'board:1W, widened 2026-08-27' },
  { address: 'Hi3mwxJGZ6Ff1T7iqtuQapyPq17HQZdvcTDNEZ5J1fvv', realized_1w_usd: 119256, win_rate: 0, tx_per_h: 9.5, note: 'board:1W, widened 2026-08-27' },
  { address: 'HhcN5HtKvLwVwjtEZRLqJFCh4ewhz58Qe6EGBHnxM6Gn', realized_1w_usd: 117062, win_rate: 0, tx_per_h: 0, note: 'board:1W, widened 2026-08-27' },
  { address: '3KbfwpfhGNcv8Rph2jbDvo4eK1WHyuUs7s7zLNd15PfR', realized_1w_usd: 111961, win_rate: 0, tx_per_h: 1.2, note: 'board:1W, widened 2026-08-27' },
  { address: '6RZee6yKNqnnnRUPbvkHf8kWnMENFAgQPCfBgdJPpz7K', realized_1w_usd: 110886, win_rate: 0, tx_per_h: 2, note: 'board:1W, widened 2026-08-27' },
  { address: 'HWYpE693cw8AWxHSynrHhUsKDbfzubAFYWpTcMZdNWKR', realized_1w_usd: 108443, win_rate: 0, tx_per_h: 0.8, note: 'board:1W, widened 2026-08-27' },
  { address: 'Ds8x2aTfR7nR38nH61b1mZKrAFRQL1s74Q4GKeuFkpkB', realized_1w_usd: 107216, win_rate: 0.288, tx_per_h: 0.9, note: 'board:1W, widened 2026-08-27' },
  { address: '8ZXnRVHWzcqgy54q6WUQKfAqfk6fZTYfK9BV37XjNcAf', realized_1w_usd: 104810, win_rate: 0, tx_per_h: 2.6, note: 'board:1W, widened 2026-08-27' },
  { address: '2e1JiNPW2zorHUqrtGk8AgyJXjMvkk9k96wyUkT6EWHS', realized_1w_usd: 104435, win_rate: 0, tx_per_h: 8.2, note: 'board:1W, widened 2026-08-27' },
  { address: 'HmxM7bvq39R6UixdmYsStpQh2qUqEMJtEH8TSQpMKiGV', realized_1w_usd: 104290, win_rate: 0, tx_per_h: 1, note: 'board:1W, widened 2026-08-27' },
  { address: 's2CPfZfBngo3XxyTzHBBCdVk14enroy5SdTpvaEkXnQ', realized_1w_usd: 96409, win_rate: 0, tx_per_h: 1.1, note: 'board:1W, widened 2026-08-27' },
  { address: 'FBGVRUaDFtyZSnpVcoruu4wHaH4SrRRStjRqM9S7pyM9', realized_1w_usd: 95105, win_rate: 0, tx_per_h: 0, note: 'board:1W, widened 2026-08-27' },
  { address: 'BtPsLNWW8bA4cYxgmhSZBSXyGaYvjBp6RyEe1GvbA9E2', realized_1w_usd: 94726, win_rate: 0, tx_per_h: 1.7, note: 'board:1W, widened 2026-08-27' },
  { address: 'HCb19svsvcCTAwDsy2x6a89Gs6fwq4PDaPFsq11SDPgQ', realized_1w_usd: 91463, win_rate: 0, tx_per_h: 2, note: 'board:1W, widened 2026-08-27' },
  { address: '2iGoLHvhgUAoLTedCCfMZiVB9yhJWVVgbvfe4T76TwQW', realized_1w_usd: 89965, win_rate: 0, tx_per_h: 4.3, note: 'board:1W, widened 2026-08-27' },
  { address: 'CHVa4RfCFoeNDWMu252LJdDNJWWenvNkYQnfmA8Jn2aW', realized_1w_usd: 89577, win_rate: 0, tx_per_h: 0.3, note: 'board:1W, widened 2026-08-27' },
  { address: 'AiTHdnGQxpZAmE6H45v7pdsxHqVvUcZsLQZntpFa2g62', realized_1w_usd: 89566, win_rate: 0, tx_per_h: 1.8, note: 'board:1W, widened 2026-08-27' },
  { address: 'GJ3AAHBtyNPKkU3aH8qCz6DGHNmYU3V7yrQoTWVt25nH', realized_1w_usd: 88125, win_rate: 0, tx_per_h: 8.2, note: 'board:1W, widened 2026-08-27' },
  { address: '9M8ethFYvn1bQHQ5nNPFc3gbiXez9vTxngZkbzt5HcXu', realized_1w_usd: 87665, win_rate: 0, tx_per_h: 0.2, note: 'board:1W, widened 2026-08-27' },
  { address: 'AkfgURqj8ZmFsKHsFYBsL7uRDmK8wXrpyRRCWo4C1vdh', realized_1w_usd: 86725, win_rate: 0, tx_per_h: 4.6, note: 'board:1W, widened 2026-08-27' },
  { address: '6DQAGJT7VZPVBsuG4kn3AvpyHCEi7B2RFFvMZdbqQqqP', realized_1w_usd: 86582, win_rate: 0, tx_per_h: 2.8, note: 'board:1W, widened 2026-08-27' },
  { address: 'DBp3oC6VbGhocc67Kxh6UwHc4bhYx5MF3vLDYLHAE8A3', realized_1w_usd: 84506, win_rate: 0, tx_per_h: 1.8, note: 'board:1W, widened 2026-08-27' },
  { address: 'DU6QQcnwT8h4L9kuzgLLm6aECTbYEPUbxE2x8jjQMv2G', realized_1w_usd: 80688, win_rate: 0, tx_per_h: 4.4, note: 'board:1W, widened 2026-08-27' },
  { address: 'DZsJg34TvSTQ9eU91RvnEqk88BG186Q71x8g6ucioFxv', realized_1w_usd: 80390, win_rate: 0, tx_per_h: 1.4, note: 'board:1W, widened 2026-08-27' },
  { address: '3koVG7usthvo6fadMp2o4v7gTTFQFeeooZ64wZ5wAX6k', realized_1w_usd: 76372, win_rate: 0, tx_per_h: 2, note: 'board:1W, widened 2026-08-27' },
  { address: 'FgXwmae1VHAFP2Qtq7cUevAtUNaHzGzGLC316fMHKknV', realized_1w_usd: 75162, win_rate: 0, tx_per_h: 4.3, note: 'board:1W, widened 2026-08-27' },
  { address: '4VU9FjSzuRLGPpFdKBBPuHRkxoNyvJXRFrKq7HEDWAA7', realized_1w_usd: 74651, win_rate: 0, tx_per_h: 1, note: 'board:1W, widened 2026-08-27' },
  { address: 'DdvAwhPFBAcFuEuMdFgBbek1Spme5ztKQ67f4gA9NHvp', realized_1w_usd: 74105, win_rate: 0, tx_per_h: 0.1, note: 'board:1W, widened 2026-08-27' },
  { address: 'eewc1ubWuH3VWpJVsHcAQ9StrTPJ2dN6Voc7L53MGCx', realized_1w_usd: 73789, win_rate: 0, tx_per_h: 0, note: 'board:1W, widened 2026-08-27' },
  { address: 'HrDu4rZhkqD47CKwoaJbZGNaoAyFDHVjmgodP8ddDTYi', realized_1w_usd: 73197, win_rate: 0, tx_per_h: 7.8, note: 'board:1W, widened 2026-08-27' },
  { address: '5Rnsy86dbu1Vfy6gtayCFifqHP5G4x5EMcTyDWaZ2Bbu', realized_1w_usd: 73189, win_rate: 0, tx_per_h: 8.2, note: 'board:1W, widened 2026-08-27' },
  { address: '2QKECLPQWM4CRHaY55WKPFYD9YU9XzgXgK5cJYi5T51d', realized_1w_usd: 73146, win_rate: 0, tx_per_h: 1.9, note: 'board:1W, widened 2026-08-27' },
  { address: 'woQZigHfLGHje85cjhXr5Y6uUiau2Q8p65N58EQj328', realized_1w_usd: 73087, win_rate: 0, tx_per_h: 0.2, note: 'board:1W, widened 2026-08-27' },
  { address: 'BTfWs2WCUyp7Ug4iJUYwCFeLZQqtjWKpdZRUjn2pBgAr', realized_1w_usd: 72901, win_rate: 0, tx_per_h: 1.7, note: 'board:1W, widened 2026-08-27' },
  { address: 'GdnqEaHTzoX9HUPwprHerCbSxar1GW9Nw21pVgVkdb9G', realized_1w_usd: 71866, win_rate: 0, tx_per_h: 0, note: 'board:1W, widened 2026-08-27' },
  { address: 'AMDzmZdyQCmUKbNMVMYqWN7srE1S3tDwRAaU7WRmF2Tx', realized_1w_usd: 71227, win_rate: 0, tx_per_h: 9.5, note: 'board:1W, widened 2026-08-27' },
  { address: 'BZco8vnncoYUVtadKrUo3XQLRHztMgVZ5GbFjhRnEGE1', realized_1w_usd: 70442, win_rate: 0, tx_per_h: 3.7, note: 'board:1W, widened 2026-08-27' },
  { address: 'uAPrgy4W4ojh8SyhT5vo6EjEJLQTFLxBnqVBjqGuosk', realized_1w_usd: 69208, win_rate: 0, tx_per_h: 5.4, note: 'board:1W, widened 2026-08-27' },
  { address: 'GSJ1JVRZuZVwQSw7BViWdK96hXScDoD3u4BtZ2pjo6m1', realized_1w_usd: 68839, win_rate: 0, tx_per_h: 0.8, note: 'board:1W, widened 2026-08-27' },
  { address: '4oHuo33aapEUuyGqyXrqUNsKSLj6UmuJtxbqKzZNx3gn', realized_1w_usd: 68403, win_rate: 0, tx_per_h: 4.4, note: 'board:1W, widened 2026-08-27' },
  { address: 'AcoNeFQsTPYs7ZrH8RMWaxxGJTTQJJ4H5aTXmptaz5UK', realized_1w_usd: 68400, win_rate: 0.3, tx_per_h: 1.9, note: 'board:1W, widened 2026-08-27' },
  { address: '6BdKF45jtxSTj2PFCTmrF2aHNkf9F2eLoQY52MVupvVK', realized_1w_usd: 67953, win_rate: 0, tx_per_h: 2.4, note: 'board:1W, widened 2026-08-27' },
  { address: '89wNFeB7NNJ4n6CXYViPsweNnn6VXUH9srtDECFSKB9u', realized_1w_usd: 65669, win_rate: 0, tx_per_h: 3.2, note: 'board:1W, widened 2026-08-27' },
  { address: 'BpqV4SmopMwywa2AxiHmdJPSMUNx7zDZCGCCNgZ6noTc', realized_1w_usd: 65109, win_rate: 0, tx_per_h: 1.1, note: 'board:1W, widened 2026-08-27' },
  { address: 'Cy6BuK7dztMTrBcphYGsgTdMjamDiBMa4Ucf3JNdNQp5', realized_1w_usd: 65073, win_rate: 0, tx_per_h: 12.5, note: 'board:1W, widened 2026-08-27' },
  { address: '5AEDReNSbLMiKuKbDDk8qHgbY2GgKHK7aFV7Yb8g5Fd6', realized_1w_usd: 64358, win_rate: 0.256, tx_per_h: 1, note: 'board:1W, widened 2026-08-27' },
  { address: '9bphD8C7WAWzsotGFZLRKWHxJpixcJZMz9AJDe1TwyC5', realized_1w_usd: 63620, win_rate: 0, tx_per_h: 4.2, note: 'board:1W, widened 2026-08-27' },
  { address: 'AosepN8EQoch2n3tv3UJ8n2ENy1sFqAikHWXKK4Mcjwr', realized_1w_usd: 62611, win_rate: 0, tx_per_h: 3.9, note: 'board:1W, widened 2026-08-27' },
  { address: '46X4YaTfbrG1nqbnDeJMYMqrXNeipVhWXYQjQZ1pGx2j', realized_1w_usd: 62446, win_rate: 0, tx_per_h: 0.9, note: 'board:1W, widened 2026-08-27' },
  { address: 'D5DbMmeQRW9f211NWjSFb4x3Ht5iyc2pBqxvcb3ievZ7', realized_1w_usd: 60624, win_rate: 0, tx_per_h: 1.4, note: 'board:1W, widened 2026-08-27' },
  { address: 'DoSRCUXKbWRkwdk9PFSUp1GfcwxEJA2M8XENK4bLG1ms', realized_1w_usd: 59643, win_rate: 0, tx_per_h: 0.6, note: 'board:1W, widened 2026-08-27' },
  { address: 'GyuF3PMvbYTphC5fAHFyZ3G1V11EUiKnmp44Wi5N4WM2', realized_1w_usd: 59198, win_rate: 0, tx_per_h: 4.3, note: 'board:1W, widened 2026-08-27' },
  { address: 'EzvW4qajibRzQahM4gajNe1er1hXiA6asiaX4hGMiWSp', realized_1w_usd: 58827, win_rate: 0, tx_per_h: 1.9, note: 'board:1W, widened 2026-08-27' },
  { address: 'Bc3ryY3BPSPcdDHcmxrLYPmU1WrzgtPmByrDuxjYFSyw', realized_1w_usd: 58777, win_rate: 0.636, tx_per_h: 2.3, note: 'board:1W, widened 2026-08-27' },
  { address: 'CohC1Ej7fcWKKw7Gcw4hDP6su5jr48hmSoLdCaqgQ1Gf', realized_1w_usd: 58565, win_rate: 0, tx_per_h: 1.2, note: 'board:1W, widened 2026-08-27' },
  { address: '4c138uTUssYXHb7onHKZDGpAKC3hhjCLY1q5aqDroir6', realized_1w_usd: 58423, win_rate: 0, tx_per_h: 2.1, note: 'board:1W, widened 2026-08-27' },
  { address: 'Ezhb4sX5fp6EdhjmKuzm9a5GZZopea6QzSuZoq6oZ6Go', realized_1w_usd: 57667, win_rate: 0, tx_per_h: 7.4, note: 'board:1W, widened 2026-08-27' },
  { address: 'DWjd65nVaCv16CF2VHdoZmZWGS6XSVq5R3nKeUMnnPRM', realized_1w_usd: 57574, win_rate: 0, tx_per_h: 0, note: 'board:1W, widened 2026-08-27' },
  { address: 'BZXfMvCgrCQ5XYtPyWDmdjAistFmmTNah6Pzu9wydZRy', realized_1w_usd: 56158, win_rate: 0, tx_per_h: 2.8, note: 'board:1W, widened 2026-08-27' },
  { address: 'GsVfkZAoTLCCHtWN54kjaWw9dDXyTLY1MzJeEck9KpCo', realized_1w_usd: 55115, win_rate: 0.387, tx_per_h: 2.2, note: 'board:1W, widened 2026-08-27' },
  { address: 'AF9PT7ytBjzrQ4KmHcXmDP2WNfkCV6Z42SF1PVdGJ4sn', realized_1w_usd: 54975, win_rate: 0, tx_per_h: 9.4, note: 'board:1W, widened 2026-08-27' },
  { address: '7zE73ThjeVkWfxtRP7TEiEcdtx9CYhfZMNmKGjBK8HYY', realized_1w_usd: 54827, win_rate: 0, tx_per_h: 0, note: 'board:1W, widened 2026-08-27' },
  { address: 'GswmFR3YRCdtFA2dvRSGjMt2HEHRQA2UYHewZRHnpHf6', realized_1w_usd: 54546, win_rate: 0, tx_per_h: 0.2, note: 'board:1W, widened 2026-08-27' },
  { address: 'HLLpyiXnDydC8H1d1i6S5QysSUWuT2UCfFGMzGUwEM3i', realized_1w_usd: 53500, win_rate: 0, tx_per_h: 9.3, note: 'board:1W, widened 2026-08-27' },
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
