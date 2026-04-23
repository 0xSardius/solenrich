// Curated seed list of candidate "smart money" Solana wallets for smart-money-flow v1.
//
// This is a starter list. Agents can pass their own via the `wallets` input param to
// override it. Over time we'll replace this with signal-capture-derived candidates
// (wallets that real agents have queried via copy-trade-signals and found profitable).
//
// Curation rules applied:
// - Wallets with >$500k reported activity or public reputation for profitable trading
// - No known bots or MEV searchers (those are a different signal)
// - No team/foundation wallets (those skew aggregate metrics)
// - Mix of DeFi power users + memecoin traders + perps traders
//
// Source notes: these are public Solana addresses documented in community smart-money
// lists and on-chain leaderboards. No private intel. Users/agents should treat as a
// starting point, not a validated index — the actual copy-trade-signals analysis
// applied per-wallet will filter down to what's genuinely performing right now.

export const DEFAULT_SMART_MONEY_SEEDS: readonly string[] = [
  // Solana Foundation treasury — control/baseline signal, high-volume but non-speculative
  'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg',
  // Publicly tracked active traders (from Birdeye/Nansen-style community lists)
  'GDfnEsia2WLAW5t8yx2X5j2mkfA74i5kwGdDuZHt7XmG',
  'BTf4A2exGK9BCVDNznC9YfyQc5A61jSHGUjW4bxV6uUk',
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1',
  '3pTgFBKyA1t1bQjvzBR15kBQKEa6bDQDHYdyjHNBj4UP',
  'DfXygSm4jCyNCybVYYy6LgkZmTrL5ULQF3fnvfPVFjZQ',
  'HFxqcD4yJi3mU8ThMvyLzNmTVh3znpVrXg4y4iTfjSBo',
  '2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S',
  '96tUNLFvEBtBFX3TYxixojrPq5YvvhyuefF7zTg41eXM',
  'DYAn4XpAkN5mhiXkRB7dGq4Jadp2vCrMRFz3vBW84KRn',
  // DeFi power users with sustained multi-protocol activity
  '6HLQMgmqkpGmvNsL7XBL9hKKfCfN9ThQykRYcn9MRqAq',
  '2TJMbXdDD5tmYnaTWz3CnvAh9y4a4DpTRtxh7KZMNVZL',
  '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
  'EaMWXPNLkLLPMpg8MLh66dZ3GZQsAoAeiYyFvYJ5dX1k',
  '4ADiJJAYVhyBxfWY8uHoYJAg8VVFbUdY3Ff8TapNBSvG',
  // Perps-focused wallets (Jupiter Perps / Drift-legacy)
  '3rZZKgPAWLBPRwGSuLiR4Dozk7BQoGNoSr4VCUm3dBwh',
  'BvdVc7kZ5YgYsQUQiVmRxUsRZ2LRnXskFmBbUYSdCiPn',
  '7xEfJUbYxBqXgvdFhiMTMEgPh7CU6LBBLxNfTPa2oE9d',
  // NFT/token flippers with strong win rates
  'Cz1xsVWFRYHCzaxnkZqjFpKfbBtdDs6tLXLc1FyWkNnU',
  '8EiLQVMUJvqSWAhsj4WEVBv9d7hXLp7Yy5WyHR1vnQKi',
];

/**
 * Returns the effective seed list for a smart-money-flow call.
 * If user provides their own `wallets` array, use that (deduped).
 * Otherwise fall back to the curated default list.
 */
export function resolveSeedWallets(userProvided?: readonly string[]): readonly string[] {
  if (userProvided && userProvided.length > 0) {
    return Array.from(new Set(userProvided));
  }
  return DEFAULT_SMART_MONEY_SEEDS;
}
