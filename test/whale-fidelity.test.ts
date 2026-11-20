// Whale-watch fidelity (audit 2026-11-17, step 5): pool vaults are not whales, missing price is 'unknown', and
// check-alerts whale alerts can fire.
import { describe, expect, test } from 'bun:test';
import { WhaleWatcher, isWalletAddress } from '../src/enrichers/whale-watch';
import { detectTokenAlerts } from '../src/enrichers/alert-checker';

const MINT = 'Meme111111111111111111111111111111111111pump';
const WHALE = 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg';        // a wallet (on curve)
const POOL = '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1';         // Raydium AMM v4 authority (PDA)
const RETAIL = '66Qvhr1xnwqbCT36KfHfZF1JpoWdmCQ3uFYTN335CGXe';       // a wallet not in the top holders

describe('isWalletAddress', () => {
  test('a wallet is on the curve; the Raydium authority PDA is not', () => {
    expect(isWalletAddress(WHALE)).toBe(true);
    expect(isWalletAddress(POOL)).toBe(false);
  });
});

function watcher(o: { price: number; txs: any[] }) {
  const noCache = { get: async () => null, set: async () => {} } as any;
  const rpc = {
    getTokenLargestAccounts: async () => [
      { address: 'poolVault', uiAmount: 400_000_000, decimals: 6 },
      { address: 'whaleAcct', uiAmount: 50_000_000, decimals: 6 },
    ],
    getMintInfo: async () => ({ decimals: 6, supply: 1_000_000_000 * 1e6, mintAuthority: null, freezeAuthority: null }),
    resolveTokenAccountOwners: async () => [{ tokenAccount: 'poolVault', owner: POOL }, { tokenAccount: 'whaleAcct', owner: WHALE }],
  };
  const helius = {
    getSignaturesForAddress: async () => [{ signature: 's1', blockTime: Math.floor(Date.now() / 1000) - 60 }],
    getEnhancedTransactions: async () => o.txs,
  };
  const dex = { getTokenPrice: async () => o.price };
  return new WhaleWatcher(helius as any, dex as any, rpc as any, noCache);
}
const transfer = (from: string, to: string, amt: number) => ({ fromUserAccount: from, toUserAccount: to, tokenAmount: amt, mint: MINT });

describe('WhaleWatcher', () => {
  test('the pool vault is listed as a program account, not a whale; retail trading against it is not whale flow', async () => {
    // Retail buys 10M tokens from the pool ($10K at $0.001): before, the pool read as a whale "distributing".
    const r = await watcher({ price: 0.001, txs: [{ timestamp: 1, tokenTransfers: [transfer(POOL, RETAIL, 10_000_000)] }] }).enrich(MINT, 1000, 24);
    expect(r.whales.map((w) => w.address)).toEqual([WHALE]);
    expect(r.program_accounts.map((p) => p.owner)).toEqual([POOL]);
    expect(r.program_accounts[0].pct_supply).toBe(40);
    expect(r.total_whale_volume_usd).toBe(0);
    expect(r.net_flow_direction).toBe('neutral');
  });
  test('a real whale buying from the pool reads as accumulating', async () => {
    const r = await watcher({ price: 0.001, txs: [{ timestamp: 1, tokenTransfers: [transfer(POOL, WHALE, 20_000_000)] }] }).enrich(MINT, 1000, 24);
    expect(r.net_flow_direction).toBe('accumulating');
    expect(r.total_whale_volume_usd).toBeCloseTo(20_000, 6);
  });
  test('no token price → flow unknown and data_quality says why (was: $0 volume, "neutral")', async () => {
    const r = await watcher({ price: 0, txs: [{ timestamp: 1, tokenTransfers: [transfer(POOL, WHALE, 20_000_000)] }] }).enrich(MINT, 1000, 24);
    expect(r.net_flow_direction).toBe('unknown');
    expect(r.whales[0].flow_direction).toBe('unknown');
    expect(r.data_quality).toEqual({ degraded: true, unavailable: ['price'] });
  });
});

describe('check-alerts whale alerts', () => {
  test('whale_inflow fires from the real whale-watch fields (could never fire before)', () => {
    const whale = { total_whale_volume_usd: 50_000, net_flow_direction: 'accumulating', whale_count: 10,
      whales: [{ transaction_count: 3 }, { transaction_count: 0 }] } as any;
    const alerts = detectTokenAlerts(MINT, { mint: MINT, risk_flags: [], price_usd: 1 } as any, [], whale, { min_whale_volume_usd: 10_000 } as any, 0);
    const w = alerts.find((a: any) => a.type === 'whale_inflow');
    expect(w).toBeDefined();
    expect((w as any).data.active_whales).toBe(1);
  });
  test('unknown flow never fires', () => {
    const whale = { total_whale_volume_usd: 50_000, net_flow_direction: 'unknown', whale_count: 10, whales: [] } as any;
    expect(detectTokenAlerts(MINT, { mint: MINT, risk_flags: [], price_usd: 1 } as any, [], whale, { min_whale_volume_usd: 10_000 } as any, 0)
      .some((a: any) => a.type.startsWith('whale_'))).toBe(false);
  });
});
