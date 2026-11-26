// Wallet + transaction fidelity (audit 2026-11-14 low #80, #81): large wallets are paged and flagged when cut;
// a base program or wallet app is not reported as the transaction's protocol.
import { afterEach, describe, expect, test } from 'bun:test';
import { HeliusClient, MAX_ASSET_PAGES } from '../src/sources/helius';
import { TxParser } from '../src/enrichers/tx-parser';

const noCache = { get: async () => null, set: async () => {} } as any;

describe('#80 getAssetsByOwner pages large wallets', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  const page = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `a${i}`, interface: 'FungibleToken' }));
  const mockPages = (sizes: number[]) => {
    let calls = 0;
    globalThis.fetch = (async (_u: any, init: any) => {
      const p = JSON.parse(init.body).params.page;
      calls++;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { total: sizes[p - 1] ?? 0, limit: 1000, page: p, items: page(sizes[p - 1] ?? 0) } }), { status: 200 });
    }) as any;
    return () => calls;
  };
  test('a 1,500-asset wallet: two pages read, all items kept, not truncated', async () => {
    const calls = mockPages([1000, 500]);
    const r = await new HeliusClient(noCache).getAssetsByOwner('W');
    expect(r.items.length).toBe(1500);
    expect(r.truncated).toBe(false);
    expect(calls()).toBe(2);
  });
  test(`a wallet filling ${MAX_ASSET_PAGES} pages is flagged truncated`, async () => {
    mockPages([1000, 1000, 1000, 1000]);
    const r = await new HeliusClient(noCache).getAssetsByOwner('W');
    expect(r.items.length).toBe(1000 * MAX_ASSET_PAGES);
    expect(r.truncated).toBe(true);
  });
  test('a small wallet costs one call', async () => {
    const calls = mockPages([12]);
    const r = await new HeliusClient(noCache).getAssetsByOwner('W');
    expect(r.truncated).toBe(false);
    expect(calls()).toBe(1);
  });
});

describe('#81 parse-transaction protocol label', () => {
  const tx = (source: string, accounts: string[] = []) => ({
    signature: 's', type: 'TRANSFER', description: '', source, fee: 5000, feePayer: 'F', timestamp: 1,
    transactionError: null, nativeTransfers: [], tokenTransfers: [], accountData: accounts.map((account) => ({ account })),
  });
  const parse = (t: any) => new TxParser({ getEnhancedTransaction: async () => t } as any, noCache).enrich('s');
  test('a plain SPL transfer has no protocol (was "SOLANA_PROGRAM_LIBRARY")', async () => {
    expect((await parse(tx('SOLANA_PROGRAM_LIBRARY')))!.protocol).toBeNull();
  });
  test('a Jupiter swap made in Phantom reads Jupiter (was "PHANTOM")', async () => {
    expect((await parse(tx('PHANTOM', ['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'])))!.protocol).toBe('Jupiter');
  });
  test('a real protocol source is kept', async () => {
    expect((await parse(tx('RAYDIUM')))!.protocol).toBe('RAYDIUM');
  });
});
