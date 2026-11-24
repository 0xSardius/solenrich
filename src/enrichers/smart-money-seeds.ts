// Fallback seed list for smart-money-flow when programmatic derivation fails.
//
// The default behavior is now to derive seeds programmatically from current
// trending-token whale activity (see SmartMoneyAnalyzer.deriveDefaultSeeds).
// This list is the last-resort fallback when derivation throws or yields too
// few candidates.
//
// Curation rules applied:
// - Wallets with >$500k reported activity or public reputation for profitable trading
// - No known bots or MEV searchers (those are a different signal)
// - No team/foundation wallets (those skew aggregate metrics)
// - Mix of DeFi power users + memecoin traders + perps traders
//
// 2026-11-23 (audit #42): removed 5Q544…4j1 (Raydium AMM v4 authority, a program PDA), 9WzDX…AWWM (Binance hot
// wallet) and 2ojv9…G8S (Binance). This list was never vetted on-chain; responses that use it say so in caveats.

import { createHash } from 'node:crypto';
import { lookupEntity } from '../utils/entities';
import { isWalletAddress } from './whale-watch';

export const DEFAULT_SMART_MONEY_SEEDS: readonly string[] = [
  // Publicly tracked active traders (from Birdeye/Nansen-style community lists)
  'GDfnEsia2WLAW5t8yx2X5j2mkfA74i5kwGdDuZHt7XmG',
  'BTf4A2exGK9BCVDNznC9YfyQc5A61jSHGUjW4bxV6uUk',
  '3pTgFBKyA1t1bQjvzBR15kBQKEa6bDQDHYdyjHNBj4UP',
  'DfXygSm4jCyNCybVYYy6LgkZmTrL5ULQF3fnvfPVFjZQ',
  'HFxqcD4yJi3mU8ThMvyLzNmTVh3znpVrXg4y4iTfjSBo',
  '96tUNLFvEBtBFX3TYxixojrPq5YvvhyuefF7zTg41eXM',
  'DYAn4XpAkN5mhiXkRB7dGq4Jadp2vCrMRFz3vBW84KRn',
  // DeFi power users with sustained multi-protocol activity
  '6HLQMgmqkpGmvNsL7XBL9hKKfCfN9ThQykRYcn9MRqAq',
  '2TJMbXdDD5tmYnaTWz3CnvAh9y4a4DpTRtxh7KZMNVZL',
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

/** Drop labelled entities (CEX, protocol, bridge) and program addresses (off-curve PDAs): they are not traders. */
export function usableSeeds(seeds: readonly string[]): string[] {
  return seeds.filter((s) => lookupEntity(s) == null && isWalletAddress(s));
}

/** Cache-key part for a seed list: a hash of the full sorted list (was the first three addresses only). */
export function seedListKey(seeds: readonly string[]): string {
  return createHash('sha1').update([...seeds].sort().join(',')).digest('hex').slice(0, 16);
}

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
