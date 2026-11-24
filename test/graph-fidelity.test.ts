// wallet-graph fidelity (audit 2026-11-14 #53): an AMM pool authority / vault (a program PDA, off-curve) is a
// program counterparty, not a 'bot' peer, and swaps against pools are not "coordinated activity".
import { describe, expect, test } from 'bun:test';
import { GraphMapper } from '../src/enrichers/graph-mapper';

const ME = 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg';            // on-curve wallet
const POOL_A = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';        // Raydium AMM v4 authority (PDA)
const POOL_B = '5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq';        // Jupiter perps pool (PDA)
const POOL_C = '7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz';        // Jupiter perps SOL custody (PDA)
const FRIEND = 'H3UyiWm1YTzSKxXTpyssxxEreq6HzWTwNW5BVYewmmfC';        // on-curve wallet

const noCache = { get: async () => null, set: async () => {} } as any;
const swap = (pool: string) => ({
  signature: 's', type: 'SWAP', source: 'RAYDIUM', timestamp: 1,
  nativeTransfers: [],
  tokenTransfers: [
    { fromUserAccount: ME, toUserAccount: pool, mint: 'USDC', tokenAmount: 10 },
    { fromUserAccount: pool, toUserAccount: ME, mint: 'TOK', tokenAmount: 1000 },
  ],
});
const send = (to: string, from = ME) => ({ signature: 's', type: 'TRANSFER', timestamp: 1, tokenTransfers: [], nativeTransfers: [{ fromUserAccount: from, toUserAccount: to, amount: 1e9 }] });

function mapper(txs: any[]) {
  const helius = { getSignaturesForAddress: async () => txs.map((_, i) => ({ signature: `sig${i}` })), getEnhancedTransactions: async () => txs } as any;
  return new GraphMapper(helius, noCache);
}

describe('#53 pool authorities are programs, not bots or coordinated peers', () => {
  test('a trader swapping on three pools: pools tagged program, no "coordinated activity" cluster', async () => {
    const txs = [...Array(30).fill(0).map(() => swap(POOL_A)), ...Array(5).fill(0).map(() => swap(POOL_B)), ...Array(5).fill(0).map(() => swap(POOL_C))];
    const g = await mapper(txs).enrich(ME, 1, 1);
    const pool = g.nodes.find((n) => n.address === POOL_A)!;
    expect(pool.category).toBe('program');
    expect(g.clusters.every((c) => c.suspicious_pattern == null)).toBe(true);
    expect(g.clusters.flatMap((c) => c.members)).not.toContain(POOL_A);
  });
  test('wallet-to-wallet transfers both ways still form a cluster with the friend', async () => {
    const txs = [send(FRIEND), send(FRIEND), send(ME, FRIEND), send(ME, FRIEND), swap(POOL_A), swap(POOL_A)];
    const g = await mapper(txs).enrich(ME, 1, 1);
    expect(g.nodes.find((n) => n.address === FRIEND)!.category).not.toBe('program');
    expect(g.nodes.find((n) => n.address === POOL_A)!.category).toBe('program');
  });
});
