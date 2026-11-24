// Whale-watch fidelity (audit 2026-11-17, step 5): pool vaults are not whales, missing price is 'unknown', and
// check-alerts whale alerts can fire.
import { describe, expect, test } from 'bun:test';
import { WhaleWatcher, isWalletAddress } from '../src/enrichers/whale-watch';
import { detectTokenAlerts, pickBaseline } from '../src/enrichers/alert-checker';

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

function watcher(o: { price: number; txs: any[]; mintThrows?: boolean }) {
  const noCache = { get: async () => null, set: async () => {} } as any;
  const rpc = {
    getTokenLargestAccounts: async () => [
      { address: 'poolVault', uiAmount: 400_000_000, decimals: 6 },
      { address: 'whaleAcct', uiAmount: 50_000_000, decimals: 6 },
    ],
    getMintInfo: async () => {
      if (o.mintThrows) throw new Error('rpc timeout');
      return { decimals: 6, supply: 1_000_000_000 * 1e6, mintAuthority: null, freezeAuthority: null };
    },
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
  test('no token price → balance_usd null, not $0 (audit #47)', async () => {
    const r = await watcher({ price: 0, txs: [] }).enrich(MINT, 1000, 24);
    expect(r.whales[0].balance_usd).toBeNull();
    expect(r.program_accounts[0].balance_usd).toBeNull();
    expect(r.whales[0].pct_supply).toBe(5);
  });
  test('mint account unread → pct_supply null and data_quality names mint_info (was 0%, not degraded)', async () => {
    const r = await watcher({ price: 0.001, txs: [], mintThrows: true }).enrich(MINT, 1000, 24);
    expect(r.whales[0].pct_supply).toBeNull();
    expect(r.whales[0].balance_usd).toBeCloseTo(50_000, 6);
    expect(r.data_quality.degraded).toBe(true);
    expect(r.data_quality.unavailable).toContain('mint_info');
    expect(r.net_flow_direction).toBe('neutral'); // flows were still read
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
  test('price change is measured from the last snapshot at or before since, not the oldest (audit #51)', () => {
    const day = 86_400_000;
    const now = Date.parse('2026-11-23T12:00:00Z');
    const snap = (daysAgo: number, price: number) => ({ date: new Date(now - daysAgo * day).toISOString().slice(0, 10), price_usd: price, risk_flags: [], holder_count: null }) as any;
    // 5 days ago the price was 1.0 (a +100% move since then); yesterday it was already 2.0.
    const snaps = [snap(5, 1.0), snap(1, 2.0)];
    const since = now - 6 * 3_600_000; // 6h ago: the last snapshot at or before it is yesterday's
    const alerts = detectTokenAlerts(MINT, { mint: MINT, risk_flags: [], price_usd: 2.02 } as any, snaps, null, { min_price_change_pct: 20 } as any, since);
    expect(alerts.some((a: any) => a.type === 'price_spike')).toBe(false);
    expect(pickBaseline(snaps, since)?.price_usd).toBe(2.0);
    expect(pickBaseline(snaps, now - 10 * day)?.price_usd).toBe(1.0); // none before since → earliest after it
  });
  test('unknown flow never fires', () => {
    const whale = { total_whale_volume_usd: 50_000, net_flow_direction: 'unknown', whale_count: 10, whales: [] } as any;
    expect(detectTokenAlerts(MINT, { mint: MINT, risk_flags: [], price_usd: 1 } as any, [], whale, { min_whale_volume_usd: 10_000 } as any, 0)
      .some((a: any) => a.type.startsWith('whale_'))).toBe(false);
  });
});
