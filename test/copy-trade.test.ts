// Copy-trade PnL (audit 2026-11-17): each swap priced from its own quote leg; no current-price PnL, no units-as-USD.
import { describe, expect, test } from 'bun:test';
import { extractSwapLeg, matchTrades, consistencyScore, type SwapLeg } from '../src/enrichers/copy-trade-analyzer';

describe('consistencyScore', () => {
  test('a losing wallet scores 0 (old formula gave 0.84 to −$104 at an 8% win rate)', () => {
    expect(consistencyScore([-5, -3, -4, 1, -6, -2])).toBe(0);
  });
  test('steady small wins score high; noisy wins score lower', () => {
    const steady = consistencyScore([1, 1.2, 0.9, 1.1, 1]);
    const noisy = consistencyScore([10, -8, 12, -9, 1]);
    expect(steady).toBeGreaterThan(0.8);
    expect(noisy).toBeLessThan(0.3);
  });
  test('per-trade Sharpe of 1 maps to 0.5', () => {
    expect(consistencyScore([0, 2])).toBeCloseTo(0.5, 6); // mean 1, std 1
  });
});

const W = 'Wallet1111111111111111111111111111111111111';
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MEME = 'Meme111111111111111111111111111111111111pump';
const tt = (from: string, to: string, mint: string, amt: number, fromAcct = 'fa', toAcct = 'ta', std = 'Fungible') =>
  ({ fromUserAccount: from, toUserAccount: to, fromTokenAccount: fromAcct, toTokenAccount: toAcct, tokenAmount: amt, decimals: 6, tokenStandard: std, mint });
const tx = (o: Record<string, unknown>) => ({ type: 'SWAP', source: 'PUMP_AMM', timestamp: 1000, transactionError: null, tokenTransfers: [], nativeTransfers: [], accountData: [], ...o }) as any;

// accountData in Helius's real shape: the wallet's native change on its own entry; token balance changes on the
// token-account entries, with userAccount = owner.
const bc = (owner: string, mint: string, ui: number, decimals = 6) =>
  ({ userAccount: owner, tokenAccount: `${owner.slice(0, 4)}-${mint.slice(0, 4)}`, mint, rawTokenAmount: { tokenAmount: String(Math.round(ui * 10 ** decimals)), decimals } });
const acct = (walletLamports: number, changes: ReturnType<typeof bc>[]) =>
  [{ account: W, nativeBalanceChange: walletLamports, tokenBalanceChanges: [] }, { account: 'tokenAccts', nativeBalanceChange: 0, tokenBalanceChanges: changes }];

describe('extractSwapLeg', () => {
  test('pump.fun curve buy with native SOL: SOL spent = native balance change (incl. fee)', () => {
    const leg = extractSwapLeg(tx({ accountData: acct(-0.5 * 1e9 - 5000, [bc(W, MEME, 1_000_000)]) }), W);
    expect(leg).toMatchObject({ kind: 'buy', mint: MEME, units: 1_000_000 });
    expect(leg.quote_sol).toBeCloseTo(0.500005, 6);
  });
  test('wrap-and-swap in one tx: the WSOL account nets to 0, the SOL is counted once', () => {
    const leg = extractSwapLeg(tx({ accountData: acct(-2 * 1e9 - 5000, [bc(W, WSOL, 0, 9), bc(W, MEME, 500)]) }), W);
    expect(leg.kind).toBe('buy');
    expect(leg.quote_sol).toBeCloseTo(2.000005, 6);
  });
  test('sell into an unwrap (seen live, OKX router): native change only, not native + WSOL leg', () => {
    // tokenTransfers show WSOL arriving AND the close returns it as native; balance changes count it once.
    const leg = extractSwapLeg(tx({
      tokenTransfers: [tt(W, 'router', MEME, 35855), tt('router', W, WSOL, 0.0287)],
      accountData: acct(0.0287 * 1e9 - 5000, [bc(W, MEME, -35855)]),
    }), W);
    expect(leg).toMatchObject({ kind: 'sell', mint: MEME, units: 35855 });
    expect(leg.quote_sol).toBeCloseTo(0.028695, 6);
  });
  test('router leg missing from tokenTransfers (seen live): balance changes still show the buy', () => {
    const leg = extractSwapLeg(tx({
      tokenTransfers: [tt(W, 'router', WSOL, 0.05)],             // the token received is NOT listed
      accountData: acct(-0.0516 * 1e9, [bc(W, MEME, 369928.798426)]),
    }), W);
    expect(leg).toMatchObject({ kind: 'buy', mint: MEME });
  });
  test('sell for USDC: quote_usd', () => {
    const leg = extractSwapLeg(tx({ accountData: acct(-5000, [bc(W, MEME, -500), bc(W, USDC, 120)]) }), W);
    expect(leg).toMatchObject({ kind: 'sell', mint: MEME, units: 500, quote_usd: 120 });
  });
  test('other owners\' balance changes (pools, vaults) are ignored', () => {
    const leg = extractSwapLeg(tx({ accountData: acct(-5000, [bc('vault', MEME, -9999), bc(W, USDC, -50), bc(W, MEME, 10)]) }), W);
    expect(leg).toMatchObject({ kind: 'buy', units: 10, quote_usd: 50 });
  });
  test('fallback without balance changes uses the wallet\'s tokenTransfers only', () => {
    const leg = extractSwapLeg(tx({ tokenTransfers: [tt('vaultA', 'vaultB', MEME, 9_999), tt(W, 'pool', USDC, 50), tt('pool', W, MEME, 10)] }), W);
    expect(leg).toMatchObject({ kind: 'buy', units: 10, quote_usd: 50 });
  });
  test('failed transaction → none', () => {
    expect(extractSwapLeg(tx({ transactionError: { err: 1 }, accountData: acct(-5000, [bc(W, MEME, 10)]) }), W).kind).toBe('none');
  });
  test('token-to-token swap → token_to_token (unpriced)', () => {
    expect(extractSwapLeg(tx({ accountData: acct(-5000, [bc(W, MEME, -10), bc(W, 'Other11111111111111111111111111111111111111', 5)]) }), W).kind).toBe('token_to_token');
  });
  test('an airdrop outside a swap is not a trade (not counted as unpriced)', () => {
    expect(extractSwapLeg(tx({ type: 'TRANSFER', accountData: acct(0, [bc(W, MEME, 1000)]) }), W).kind).toBe('none');
  });
  test('NFT (0 decimals) is not a token trade', () => {
    expect(extractSwapLeg(tx({ accountData: acct(-1e9, [bc(W, 'Nft1111111111111111111111111111111111111111', 1, 0)]) }), W).kind).toBe('none');
  });
  test('SOL to USDC (quote to quote) is not a token trade', () => {
    expect(extractSwapLeg(tx({ accountData: acct(-1e9, [bc(W, USDC, 140)]) }), W).kind).toBe('none');
  });
});

const leg = (kind: SwapLeg['kind'], units: number, quote: { usd?: number; sol?: number }, ts: number, mint = MEME): SwapLeg =>
  ({ kind, mint, units, quote_usd: quote.usd ?? null, quote_sol: quote.sol ?? null, timestamp: ts });

describe('matchTrades', () => {
  test('a losing round trip is a loss (was ≈ 0 with one current price for both legs)', () => {
    const m = matchTrades([leg('buy', 1000, { sol: 1 }, 1), leg('sell', 1000, { sol: 0.4 }, 2)], 150);
    expect(m.closed.length).toBe(1);
    expect(m.closed[0].pnl_usd).toBeCloseTo(-90, 6); // 0.4×150 − 1×150
  });
  test('a winning round trip in USDC', () => {
    const m = matchTrades([leg('buy', 100, { usd: 50 }, 1), leg('sell', 100, { usd: 80 }, 86_401)], null);
    expect(m.closed[0].pnl_usd).toBeCloseTo(30, 6);
    expect(m.closed[0].hold_time_days).toBeCloseTo(1, 3);
  });
  test('a sell of a token bought before the window is unmatched, never profit', () => {
    const m = matchTrades([leg('sell', 5_000_000, { sol: 2 }, 1)], 150);
    expect(m.closed.length).toBe(0);
    expect(m.unmatched_sells).toBe(1);
  });
  test('overselling: only the matched share of proceeds counts', () => {
    const m = matchTrades([leg('buy', 100, { usd: 100 }, 1), leg('sell', 200, { usd: 400 }, 2)], null);
    expect(m.closed[0].exit_usd).toBeCloseTo(200, 6);
    expect(m.closed[0].pnl_usd).toBeCloseTo(100, 6);
  });
  test('SOL legs without a SOL price are unpriced, not valued at 0 or at units', () => {
    const m = matchTrades([leg('buy', 100, { sol: 1 }, 1), leg('sell', 100, { sol: 2 }, 2)], null);
    expect(m.closed.length).toBe(0);
    expect(m.unpriced_swaps).toBe(2);
  });
  test('average cost across two buys', () => {
    const m = matchTrades([leg('buy', 100, { usd: 100 }, 1), leg('buy', 100, { usd: 300 }, 2), leg('sell', 100, { usd: 250 }, 3)], null);
    expect(m.closed[0].entry_usd).toBeCloseTo(200, 6);
    expect(m.closed[0].pnl_usd).toBeCloseTo(50, 6);
  });
});
