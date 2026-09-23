/**
 * StonkFun product line — unit tests on recorded fixtures (test/fixtures/stonk)
 * plus live smoke tests behind STONK_LIVE=1.
 *
 *   bun test test/stonk.test.ts               # fixtures only, no network
 *   STONK_LIVE=1 bun test test/stonk.test.ts  # + live StonkFun API + Helius RPC
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseMintAccount, type ParsedMintAccount } from '../src/sources/token-2022';
import {
  buildExampleLaunchTransaction,
  decodeLaunchTransaction,
  encodeInitializeInstruction,
  encodeUnsignedTransaction,
  launchLabEventAuthority,
  EXAMPLE_LAUNCH,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '../src/sources/launchlab';
import { StonkFunClient, type StonkLaunchLabPricing, type StonkToken, type StonkLaunch, type StonkRewardTotals, type StonkPair } from '../src/sources/stonkfun';
import { scoreRewardRisk, STONKFUN_WITHDRAW_AUTHORITY } from '../src/enrichers/stonk-reward-risk';
import { computeYield } from '../src/enrichers/stonk-yield';
import { diffLaunchAgainstPricing, lintLaunchParamNames } from '../src/enrichers/stonk-preflight';
import { StonkIndex, trailingYield, normalizeCategory, STONK_VOLUME_SORT, type DayPoint } from '../src/enrichers/stonk-index';
import { buildPairsResult } from '../src/entrypoints/stonk';
import { formatStonkRewardRiskBriefing, formatStonkYieldBriefing, formatStonkPreflightBriefing, formatStonkPairsBriefing } from '../src/formatters/llm-stonk';
import { Cache } from '../src/cache';

const FIX = join(import.meta.dir, 'fixtures', 'stonk');
const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(FIX, name), 'utf8')) as T;

const NOW = Date.parse('2026-09-06T12:00:00Z');
const pricing = fixture<{ data: StonkLaunchLabPricing }>('launchlab-pricing-spyx.json').data;
const zcat = fixture<{ data: { token: StonkToken; launch: StonkLaunch } }>('token-zcat.json').data;
const zcatRewards = fixture<{ data: { rewards: StonkRewardTotals; quote: { symbol: string; decimals: number } } }>('token-zcat-rewards.json').data;
const mintZcat = fixture<ParsedMintAccount>('mint-zcat-parsed.json');
const mintNcat = fixture<ParsedMintAccount>('mint-ncat-parsed.json');
const mintBonk = fixture<ParsedMintAccount>('mint-bonk-parsed.json');
const pairs = fixture<{ data: { pairs: StonkPair[] } }>('pairs.json').data.pairs;

// ---------------------------------------------------------------------------
describe('token-2022: parseMintAccount', () => {
  test('reads the transfer-fee extension from a reward mint', () => {
    const m = parseMintAccount(mintZcat);
    expect(m.exists).toBe(true);
    expect(m.program).toBe('token-2022');
    expect(m.decimals).toBe(9);
    expect(m.transferFee?.bps).toBe(300);
    expect(m.transferFee?.withdrawWithheldAuthority).toBe(STONKFUN_WITHDRAW_AUTHORITY);
    expect(m.transferFee?.configAuthority).toBeNull();
    expect(m.transferFee?.maximumFeeRaw).toBe('1000000000000000000');
    expect(m.extensions).toContain('metadataPointer');
  });
  test('self-built launchlab mint: mutable fee authority, cap = supply', () => {
    const m = parseMintAccount(mintNcat);
    expect(m.transferFee?.bps).toBe(100);
    expect(m.transferFee?.configAuthority).toBe('WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh');
    expect(m.transferFee?.maximumFeeRaw).toBe(m.supplyRaw);
  });
  test('classic SPL mint has no fee', () => {
    const m = parseMintAccount(mintBonk);
    expect(m.program).toBe('spl-token');
    expect(m.transferFee).toBeNull();
  });
  test('missing account', () => {
    expect(parseMintAccount(null).exists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('launchlab codec', () => {
  test('example launch round-trips through encode → decode', async () => {
    const d = await decodeLaunchTransaction(buildExampleLaunchTransaction());
    expect(d.version).toBe('legacy');
    expect(d.initialize?.variant).toBe('initialize_with_token_2022');
    expect(d.initialize?.params.supply).toBe(EXAMPLE_LAUNCH.supply);
    expect(d.initialize?.params.totalSellA).toBe(EXAMPLE_LAUNCH.totalSellA);
    expect(d.initialize?.params.transferFee).toEqual({ present: true, transferFeeBasePoints: 300, maxinumFee: EXAMPLE_LAUNCH.supply });
    expect(d.initialize?.named.mintA.isSigner).toBe(true);
    expect(d.initialize?.named.trailing.map((t) => t.pubkey)).toEqual([EXAMPLE_LAUNCH.curveRuleReward]);
  });
  test('initialize_v2 (legacy SPL base) decodes with metadata account', async () => {
    const ix = encodeInitializeInstruction({
      variant: 'initialize_v2',
      accounts: {
        payer: EXAMPLE_LAUNCH.payer, creator: EXAMPLE_LAUNCH.payer, configId: EXAMPLE_LAUNCH.configId, platformId: EXAMPLE_LAUNCH.platformReward,
        auth: 'WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh', poolId: 'DFVooc8ekdz4xznApLxEbTNSDMDB9P4czeqH6ZMXn78C',
        mintA: EXAMPLE_LAUNCH.mintA, mintB: EXAMPLE_LAUNCH.quoteMint,
        vaultA: 'BBYVxswtLq8VTxQvzmVYkJsjMv8Jsw3csBK7jLmBQpjK', vaultB: 'Ad7pbBvVRNofo96WR6eHwmU2o4naZ6Lao1J98hW8a1TQ',
        metadataId: 'HcRLc9VDgjLeK154xDawfb1dmVJ98DoSqcwTHGqiDeJR',
        tokenProgramA: TOKEN_PROGRAM_ID, tokenProgramB: TOKEN_2022_PROGRAM_ID, eventAuthority: launchLabEventAuthority(),
      },
      params: {
        decimals: 9, name: 'V2', symbol: 'V2', uri: 'u', curveType: 'FixedCurve', supply: '10', totalSellA: null, totalFundRaisingB: '5',
        migrateType: 'amm', totalLockedAmount: '1', cliffPeriod: '2', unlockPeriod: '3', cpmmCreatorFeeOn: 1,
      },
    });
    const d = await decodeLaunchTransaction(encodeUnsignedTransaction([ix], EXAMPLE_LAUNCH.payer));
    expect(d.initialize?.variant).toBe('initialize_v2');
    expect(d.initialize?.params.curveType).toBe('FixedCurve');
    expect(d.initialize?.params.totalSellA).toBeNull();
    expect(d.initialize?.params.migrateType).toBe('amm');
    expect(d.initialize?.params.transferFee).toBeNull();
    expect(d.initialize?.named.metadataId?.pubkey).toBe('HcRLc9VDgjLeK154xDawfb1dmVJ98DoSqcwTHGqiDeJR');
    expect(d.initialize?.named.tokenProgramA.pubkey).toBe(TOKEN_PROGRAM_ID);
  });
  test('garbage input throws; an empty message decodes with no initialize', async () => {
    await expect(decodeLaunchTransaction('not base64 at all!!')).rejects.toThrow();
    const empty = await decodeLaunchTransaction(Buffer.alloc(200).toString('base64'));
    expect(empty.initialize).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('preflight: diffLaunchAgainstPricing', () => {
  const decodeOk = () => decodeLaunchTransaction(buildExampleLaunchTransaction());

  test('reference launch passes with at most a raise-drift warning', async () => {
    const r = diffLaunchAgainstPricing(await decodeOk(), pricing, 'reward', EXAMPLE_LAUNCH.quoteMint);
    expect(r.mismatches).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.decoded.variant).toBe('initialize_with_token_2022');
    expect(r.expected.platform_id).toBe(pricing.platform.reward);
  });

  test('misspelled maxinumFee → zero cap mismatch naming the field', async () => {
    // What the SDK serializes when a builder passes { maximumFee } instead of { maxinumFee }: the u64 stays 0.
    const tx = buildExampleLaunchTransaction({ transferFee: { present: true, transferFeeBasePoints: 300, maxinumFee: '0' } });
    const r = diffLaunchAgainstPricing(await decodeLaunchTransaction(tx), pricing, 'reward', EXAMPLE_LAUNCH.quoteMint);
    expect(r.ok).toBe(false);
    const m = r.mismatches.find((x) => x.field === 'transferFeeExtensionParams.maxinumFee');
    expect(m).toBeDefined();
    expect(m!.fix).toContain('maxinumFee');
  });

  test('misspelled transferFeeBasisPoints → zero-rate mismatch', async () => {
    const tx = buildExampleLaunchTransaction({ transferFee: { present: true, transferFeeBasePoints: 0, maxinumFee: EXAMPLE_LAUNCH.supply } });
    const r = diffLaunchAgainstPricing(await decodeLaunchTransaction(tx), pricing, 'reward', EXAMPLE_LAUNCH.quoteMint);
    expect(r.ok).toBe(false);
    const m = r.mismatches.find((x) => x.field === 'transferFeeExtensionParams.transferFeeBasePoints');
    expect(m?.actual).toBe('0');
    expect(m?.fix).toContain('transferFeeBasePoints');
  });

  test('launch_params lint catches the literal misspelling', () => {
    const lint = lintLaunchParamNames({ transferFeeExtensionParams: { transferFeeBasisPoints: 300, maximumFee: '1' } });
    expect(lint.map((l) => [l.actual, l.expected])).toEqual([
      ['transferFeeBasisPoints', 'transferFeeBasePoints'],
      ['maximumFee', 'maxinumFee'],
    ]);
    expect(lintLaunchParamNames({ transferFeeExtensionParams: { transferFeeBasePoints: 300, maxinumFee: '1' } })).toEqual([]);
  });

  test('missing curve-rule account is rejected', async () => {
    const tx = buildExampleLaunchTransaction({}, []);
    const r = diffLaunchAgainstPricing(await decodeLaunchTransaction(tx), pricing, 'reward', EXAMPLE_LAUNCH.quoteMint);
    expect(r.ok).toBe(false);
    const m = r.mismatches.find((x) => x.field.startsWith('curve rule'));
    expect(m?.actual).toBe('missing');
    expect(m?.expected).toBe(pricing.curveRule.reward);
  });

  test('standard curve rule on a reward launch is named as the wrong mode', async () => {
    const tx = buildExampleLaunchTransaction({}, [pricing.curveRule.standard]);
    const r = diffLaunchAgainstPricing(await decodeLaunchTransaction(tx), pricing, 'reward', EXAMPLE_LAUNCH.quoteMint);
    expect(r.mismatches.find((x) => x.field.startsWith('curve rule'))?.fix).toContain('STANDARD');
  });

  test('wrong decimals, supply, totalSellA, and lamport raise are all caught', async () => {
    const tx = buildExampleLaunchTransaction({ decimals: 9, supply: '999', totalSellA: '1', totalFundRaisingB: '85000000000' });
    const r = diffLaunchAgainstPricing(await decodeLaunchTransaction(tx), pricing, 'reward', EXAMPLE_LAUNCH.quoteMint);
    const fields = r.mismatches.map((m) => m.field);
    expect(fields).toContain('decimals');
    expect(fields).toContain('supply');
    expect(fields).toContain('totalSellA');
    expect(fields).toContain('totalFundRaisingB (raise)');
  });

  test('small raise drift is a warning, not a mismatch', async () => {
    const drifted = String(Math.round(Number(EXAMPLE_LAUNCH.totalFundRaisingB) * 1.04));
    const tx = buildExampleLaunchTransaction({ totalFundRaisingB: drifted });
    const r = diffLaunchAgainstPricing(await decodeLaunchTransaction(tx), pricing, 'reward', EXAMPLE_LAUNCH.quoteMint);
    expect(r.mismatches).toEqual([]);
    expect(r.warnings.some((w) => w.includes('totalFundRaisingB'))).toBe(true);
  });

  test('reward-mode transaction submitted as standard flags the platform id and the fee', async () => {
    const r = diffLaunchAgainstPricing(await decodeOk(), pricing, 'standard', EXAMPLE_LAUNCH.quoteMint);
    const fields = r.mismatches.map((m) => m.field);
    expect(fields).toContain('platformId');
    expect(fields).toContain('transferFeeExtensionParams');
    expect(fields).toContain('curve rule account (last account)');
  });

  test('no LaunchLab instruction → instruction mismatch', () => {
    const r = diffLaunchAgainstPricing({ version: 'legacy', feePayer: null, instructionCount: 1, usesLookupTables: false, programIds: ['11111111111111111111111111111111'], initialize: null }, pricing, 'reward', EXAMPLE_LAUNCH.quoteMint);
    expect(r.ok).toBe(false);
    expect(r.mismatches[0].field).toBe('instruction');
  });

  test('briefing renders mismatches', async () => {
    const tx = buildExampleLaunchTransaction({}, []);
    const r = { ...diffLaunchAgainstPricing(await decodeLaunchTransaction(tx), pricing, 'reward', EXAMPLE_LAUNCH.quoteMint), next_steps: ['fix it'] };
    const text = formatStonkPreflightBriefing(r);
    expect(text).toContain('NOT OK');
    expect(text).toContain('curve rule');
  });
});

// ---------------------------------------------------------------------------
describe('reward risk: scoreRewardRisk', () => {
  const base = () => ({
    mint: zcat.token.mint,
    listed: true,
    token: zcat.token,
    launch: zcat.launch,
    rewards: zcatRewards.rewards,
    rewardsQuote: zcatRewards.quote,
    onchain: parseMintAccount(mintZcat),
    expectedWithdrawAuthority: STONKFUN_WITHDRAW_AUTHORITY,
    top10Pct: 25,
    holderCountRpc: 20,
    now: NOW,
  });

  test('adopted, taxed, paying coin scores HEALTHY', () => {
    const r = scoreRewardRisk(base());
    expect(r.level).toBe('HEALTHY');
    expect(r.score).toBeGreaterThanOrEqual(70);
    expect(r.reward_mechanism).toBe('transfer_tax');
    expect(r.adoption.withdraw_authority_is_stonkfun).toBe(true);
    expect(r.transfer_fee.onchain_bps).toBe(300);
    expect(r.rewards.hours_since_last_payout).toBeGreaterThan(0);
    const text = formatStonkRewardRiskBriefing(r);
    expect(text).toContain('Reward Risk');
    expect(text).toContain('HEALTHY');
  });

  test('zero-rate tax scores under 20 with a clear reason', () => {
    const onchain = parseMintAccount(mintZcat);
    onchain.transferFee!.bps = 0;
    const r = scoreRewardRisk({ ...base(), onchain });
    expect(r.score).toBeLessThan(20);
    expect(r.level).toBe('BROKEN');
    expect(r.reasons.some((x) => x.includes('ZERO-RATE'))).toBe(true);
  });

  test('zero maximum fee scores under 20', () => {
    const onchain = parseMintAccount(mintZcat);
    onchain.transferFee!.maximumFeeRaw = '0';
    const r = scoreRewardRisk({ ...base(), onchain });
    expect(r.score).toBeLessThan(20);
    expect(r.reasons.some((x) => x.includes('maximum is 0'))).toBe(true);
  });

  test('unadopted taxed mint (not on StonkFun) scores under 20', () => {
    const r = scoreRewardRisk({ ...base(), listed: false, token: null, launch: null, rewards: null, rewardsQuote: null, onchain: parseMintAccount(mintNcat) });
    expect(r.score).toBeLessThan(20);
    expect(r.reasons.some((x) => x.includes('not adopted'))).toBe(true);
    expect(r.adoption.listed_on_stonkfun).toBe(false);
  });

  test('withdraw authority that is not StonkFun scores under 20', () => {
    const onchain = parseMintAccount(mintZcat);
    onchain.transferFee!.withdrawWithheldAuthority = 'WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh';
    const r = scoreRewardRisk({ ...base(), onchain });
    expect(r.score).toBeLessThan(20);
    expect(r.adoption.withdraw_authority_is_stonkfun).toBe(false);
  });

  test('mutable fee authority costs points and warns', () => {
    const healthy = scoreRewardRisk(base());
    const r = scoreRewardRisk({ ...base(), onchain: parseMintAccount({ ...mintNcat, parsed: { ...mintNcat.parsed, info: { ...mintNcat.parsed.info } } }) });
    expect(r.warnings.some((w) => w.includes('MUTABLE'))).toBe(true);
    expect(r.score).toBeLessThan(healthy.score);
  });

  test('legacy SPL reward coin is scored on its record, not BROKEN', () => {
    const r = scoreRewardRisk({ ...base(), onchain: parseMintAccount(mintBonk) });
    expect(r.reward_mechanism).toBe('legacy_fee_share');
    expect(r.level).not.toBe('BROKEN');
  });

  test('standard-mode coin is BROKEN for reward purposes', () => {
    const token = { ...zcat.token, mode: 'standard' as const };
    const r = scoreRewardRisk({ ...base(), token, onchain: parseMintAccount(mintBonk), rewards: null });
    expect(r.level).toBe('BROKEN');
  });

  test('stale payouts and concentrated holders pull the score down', () => {
    const rewards = { ...zcatRewards.rewards, lastPayoutAt: '2026-07-01T00:00:00Z' };
    const r = scoreRewardRisk({ ...base(), rewards, top10Pct: 85 });
    expect(r.warnings.some((w) => w.includes('quiet'))).toBe(true);
    expect(r.warnings.some((w) => w.includes('concentrate'))).toBe(true);
    expect(r.score).toBeLessThan(scoreRewardRisk(base()).score);
  });
});

// ---------------------------------------------------------------------------
describe('yield: trailingYield + computeYield', () => {
  const day = 86_400_000;
  const series: DayPoint[] = Array.from({ length: 31 }, (_, i) => ({
    t: NOW - (30 - i) * day,
    dist: i * 10,               // +10 quote tokens per day
    marketCapUsd: 1_000_000,
    holders: 100 + i,
  }));

  test('7d and 30d deltas over a full series', () => {
    const y7 = trailingYield(series, NOW, 7, 300, 1_000_000, 2);
    expect(y7.rewardsQuote).toBe(70);
    expect(y7.rewardsUsd).toBe(140);
    expect(y7.actualDays).toBe(7);
    expect(y7.yieldPct).toBeCloseTo(0.014, 4);
    const y30 = trailingYield(series, NOW, 30, 300, 1_000_000, 2);
    expect(y30.rewardsQuote).toBe(300);
    expect(y30.actualDays).toBe(30);
  });

  test('partial history reports the actual window', () => {
    const short = series.slice(-3); // 2 days back
    const y7 = trailingYield(short, NOW, 7, 300, 1_000_000, 2);
    expect(y7.actualDays).toBe(2);
    expect(y7.rewardsQuote).toBe(20);
  });

  test('empty series → nulls', () => {
    expect(trailingYield([], NOW, 7, 300, 1, 1).yieldPct).toBeNull();
  });

  test('computeYield flags sub-7d windows and no history', () => {
    const r = computeYield({
      mint: 'M', symbol: 'X', name: 'X', mode: 'reward', createdAt: new Date(NOW - 3 * day).toISOString(), launchMarketCapUsd: 5000,
      marketCapUsd: 100_000, distributedTokens: 5, payoutCount: 3, holderCount: 10, lastPayoutAt: null,
      quote: { mint: 'Q', symbol: 'NVDAX', decimals: 8, categoryRaw: 'xstock' }, quoteUsd: 200, series: [], now: NOW,
    });
    // 3-day-old coin: the 7d window starts at launch, annualized with caution.
    expect(r.trailing_7d.caution).toBe(true);
    expect(r.trailing_7d.actual_days).toBe(3);
    expect(r.trailing_7d.rewards_usd).toBe(1000);
    expect(r.trailing_7d.annualized_pct).not.toBeNull();
    expect(r.trailing_30d.caution).toBe(true);
    expect(r.lifetime.caution).toBe(true);
    expect(r.quote_exposure.long).toEqual(['X (the coin itself)', 'NVDAX (xstock)']);
    expect(r.reward_asset.category).toBe('xstock');
    const text = formatStonkYieldBriefing({ ...r, next_steps: [] });
    expect(text).toContain('Holder Yield');
    expect(text).toContain('⚠️');
  });

  test('computeYield with a 30-day series is clean on both windows', () => {
    const r = computeYield({
      mint: 'M', symbol: 'X', name: 'X', mode: 'reward', createdAt: new Date(NOW - 60 * day).toISOString(), launchMarketCapUsd: 5000,
      marketCapUsd: 1_000_000, distributedTokens: 300, payoutCount: 300, holderCount: 130, lastPayoutAt: null,
      quote: { mint: 'Q', symbol: 'ZEC', decimals: 8, categoryRaw: 'custom' }, quoteUsd: 2, series, now: NOW,
    });
    expect(r.trailing_7d.caution).toBe(false);
    expect(r.trailing_30d.caution).toBe(false);
    expect(r.trailing_30d.yield_pct).toBeCloseTo(0.06, 3);
    expect(r.trailing_30d.annualized_pct).toBeCloseTo(0.73, 1);
    expect(r.history.points).toBe(31);
  });
});

// ---------------------------------------------------------------------------
describe('index: screener over injected rows', () => {
  const makeIndex = async () => {
    const page = fixture<{ data: { tokens: StonkToken[] } }>('tokens-reward-page.json').data.tokens;
    const ledger = fixture<{ data: { launches: any[] } }>('rewards-ledger.json').data.launches;
    const client = {
      getTokens: async () => ({ tokens: page, pagination: { page: 1, pageSize: 25, total: page.length, totalPages: 1 } }),
      getRewardsLedger: async () => ledger,
    } as unknown as StonkFunClient;
    const fakePrices = async (mints: string[]) => Object.fromEntries(mints.map((m) => [m, { id: m, price: 100, mintSymbol: '', vsToken: '', vsTokenSymbol: 'USDC' }]));
    const jupiter = { getPrice: fakePrices, getPriceUncached: fakePrices } as any;
    const idx = new StonkIndex(client, jupiter, new Cache(), () => NOW);
    await idx.refresh();
    return idx;
  };

  test('refresh builds rows and screener filters/sorts', async () => {
    const idx = await makeIndex();
    const st = idx.status();
    expect(st.rows).toBe(25);
    expect(st.lastError).toBeNull();
    const all = idx.screen({ sort: 'volume24h', limit: 5 });
    expect(all.rows.length).toBe(5);
    expect(all.rows[0].volume24hUsd).toBeGreaterThanOrEqual(all.rows[4].volume24hUsd);
    const x = idx.screen({ category: 'xstock', limit: 50 });
    expect(x.rows.every((r) => r.quoteCategory === 'xstock')).toBe(true);
    expect(x.matched).toBeGreaterThan(0);
    const holders = idx.screen({ minHolders: 1_000_000 });
    expect(holders.rows.length).toBe(0);
    const zc = idx.getRow(zcat.token.mint);
    expect(zc?.bps).toBe(300);
    expect(idx.getQuoteUsd(zc!.quoteMint)).toBe(100);
  });

  test('screener responds well under 300ms', async () => {
    const idx = await makeIndex();
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) idx.screen({ sort: 'yield7d', limit: 25 });
    expect((performance.now() - t0) / 20).toBeLessThan(300);
  });

  test('observe() keeps one point per day', () => {
    const idx = new StonkIndex({} as any, {} as any, new Cache(), () => NOW);
    idx.observe('m', { t: NOW, dist: 1, marketCapUsd: 1, holders: 1 });
    idx.observe('m', { t: NOW + 1000, dist: 2, marketCapUsd: 2, holders: 2 });
    expect(idx.getSeries('m').length).toBe(1);
    idx.observe('m', { t: NOW + 86_400_000, dist: 2, marketCapUsd: 2, holders: 2 });
    expect(idx.getSeries('m').length).toBe(2);
  });

  test('normalizeCategory maps issuer labels', () => {
    expect(normalizeCategory('backpack')).toBe('prestock');
    expect(normalizeCategory('tessera')).toBe('xstock');
    expect(normalizeCategory('weird')).toBe('custom');
  });

  // 2026-09-21: production served 0 rows for 1.6 h after a restart because one timed-out page failed the whole
  // 200-page walk, and the only retry was the 10-minute timer.
  describe('partial walk and retry', () => {
    const page = fixture<{ data: { tokens: StonkToken[] } }>('tokens-reward-page.json').data.tokens;
    const ledger = fixture<{ data: { launches: any[] } }>('rewards-ledger.json').data.launches;
    const fakePrices = async (mints: string[]) => Object.fromEntries(mints.map((m) => [m, { id: m, price: 100, mintSymbol: '', vsToken: '', vsTokenSymbol: 'USDC' }]));
    const jupiter = { getPrice: fakePrices, getPriceUncached: fakePrices } as any;
    // Three pages of the same fixture with distinct mints; `failAt` throws like an aborted fetch.
    const pagedClient = (failAt: number | null) => ({
      getTokens: async ({ page: n }: { page: number }) => {
        if (n === failAt) throw new Error('The operation was aborted.');
        return { tokens: page.map((t) => ({ ...t, mint: `${t.mint.slice(0, 40)}p${n}` })), pagination: { page: n, pageSize: 25, total: 75, totalPages: 3 } };
      },
      getRewardsLedger: async () => ledger,
    }) as unknown as StonkFunClient;

    test('a page that fails after page 1 keeps the pages already read and marks the index partial', async () => {
      const idx = new StonkIndex(pagedClient(3), jupiter, new Cache(), () => NOW);
      await idx.refresh();
      const st = idx.status();
      expect(st.rows).toBe(50);
      expect(st.lastError).toBeNull();
      expect(st.partial).toEqual({ pages: 2, totalPages: 3, reason: 'skipped page 3 of 3: The operation was aborted.' });
      expect(idx.screen({ limit: 100 }).rows.length).toBe(50);
    });

    // 2026-09-22: ending the walk at the first failed page lost every page after it (production: 176 of 200).
    test('a failed page in the middle is skipped and the walk continues', async () => {
      const idx = new StonkIndex(pagedClient(2), jupiter, new Cache(), () => NOW);
      await idx.refresh();
      const st = idx.status();
      expect(st.rows).toBe(50); // pages 1 and 3
      expect(st.partial).toEqual({ pages: 2, totalPages: 3, reason: 'skipped page 2 of 3: The operation was aborted.' });
    });

    test('five failed pages in a row end the walk (upstream down)', async () => {
      const client = {
        getTokens: async ({ page: n }: { page: number }) => {
          if (n >= 2) throw new Error('The operation was aborted.');
          return { tokens: page.map((t) => ({ ...t, mint: `${t.mint.slice(0, 40)}p${n}` })), pagination: { page: n, pageSize: 25, total: 250, totalPages: 10 } };
        },
        getRewardsLedger: async () => ledger,
      } as unknown as StonkFunClient;
      const calls: number[] = [];
      const spy = { ...client, getTokens: async (q: { page: number }) => { calls.push(q.page); return (client as any).getTokens(q); } } as unknown as StonkFunClient;
      const idx = new StonkIndex(spy, jupiter, new Cache(), () => NOW);
      await idx.refresh();
      expect(calls).toEqual([1, 2, 3, 4, 5, 6]);
      expect(idx.status().rows).toBe(25);
      expect(idx.status().partial?.reason).toBe('ended at page 6 after 5 failures in a row of 6: The operation was aborted.');
    });

    test('a full walk clears the partial mark', async () => {
      const idx = new StonkIndex(pagedClient(null), jupiter, new Cache(), () => NOW);
      await idx.refresh();
      expect(idx.status().rows).toBe(75);
      expect(idx.status().partial).toBeNull();
    });

    test('page 1 failing is still a failed refresh, and the previous rows stay', async () => {
      const idx = new StonkIndex(pagedClient(null), jupiter, new Cache(), () => NOW);
      await idx.refresh();
      const broken = new StonkIndex(pagedClient(1), jupiter, new Cache(), () => NOW);
      await broken.refresh();
      expect(broken.status().rows).toBe(0);
      expect(broken.status().lastError).toBe('The operation was aborted.');
      // Same instance: a later failure keeps the rows from the good refresh.
      (idx as any).client = pagedClient(1);
      await idx.refresh();
      expect(idx.status().rows).toBe(75);
      expect(idx.status().lastError).toBe('The operation was aborted.');
    });

    test('the client retries a timed-out request once, and an HTTP error not at all', async () => {
      // Bun.serve on a random port: the first request to /pairs hangs past the timeout, the second answers.
      let calls = 0;
      const server = Bun.serve({
        port: 0,
        fetch: async (req) => {
          const url = new URL(req.url);
          if (url.pathname === '/pairs') {
            calls++;
            if (calls === 1) await new Promise((r) => setTimeout(r, 400));
            return Response.json({ data: { pairs: [{ mint: 'm', symbol: 'S', category: 'xstock' }] } });
          }
          calls++;
          return Response.json({ error: { code: 'nope', message: 'no' } }, { status: 503 });
        },
      });
      try {
        const client = new StonkFunClient(new Cache(), `http://127.0.0.1:${server.port}`);
        const pairs = await (client as any).request('/pairs', 100);
        expect(pairs.pairs.length).toBe(1);
        expect(calls).toBe(2);
        calls = 0;
        await expect((client as any).request('/stats', 100)).rejects.toThrow('stonkfun 503');
        expect(calls).toBe(1);
      } finally {
        server.stop(true);
      }
    });

    test('a failed refresh schedules one retry after RETRY_DELAY_MS, only while started', async () => {
      const idx = new StonkIndex(pagedClient(1), jupiter, new Cache(), () => NOW);
      await idx.refresh(); // not started: no timer, no retry
      expect((idx as any).retryTimer).toBeNull();
      await idx.start(60 * 60 * 1000);
      await new Promise((r) => setTimeout(r, 20)); // let the start() refresh fail
      expect((idx as any).retryTimer).not.toBeNull();
      idx.stop();
      expect((idx as any).retryTimer).toBeNull();
    });
  });

  // 2026-09-22: `sort=volume24h` is not a StonkFun sort value; the API fell back to market cap without an error,
  // and the index walked the top 200 pages by market cap instead of the ~116 pages of coins that trade.
  describe('volume-sorted walk', () => {
    const page = fixture<{ data: { tokens: StonkToken[] } }>('tokens-reward-page.json').data.tokens;
    const ledger = fixture<{ data: { launches: any[] } }>('rewards-ledger.json').data.launches;
    const fakePrices = async (mints: string[]) => Object.fromEntries(mints.map((m) => [m, { id: m, price: 100, mintSymbol: '', vsToken: '', vsTokenSymbol: 'USDC' }]));
    const jupiter = { getPrice: fakePrices, getPriceUncached: fakePrices } as any;
    const withVol = (t: StonkToken, v: number, n: number, tag = 'p') => ({ ...t, mint: `${t.mint.slice(0, 40)}${tag}${n}`, market: { ...(t.market as any), volume24hUsd: v } });
    // `vols[n-1]` = the 24h volume of every coin on page n; `failAt` throws like an aborted fetch;
    // `tag` changes the mints, so a second walk can return different coins on the same page.
    const client = (vols: number[], failAt: number | null, sorts: unknown[], tag = 'p') => ({
      getTokens: async (q: { page: number; sort?: string }) => {
        sorts.push(q.sort);
        if (q.page === failAt) throw new Error('The operation was aborted.');
        return { tokens: page.map((t) => withVol(t, vols[q.page - 1], q.page, q.page === 1 ? 'p' : tag)), pagination: { page: q.page, pageSize: 25, total: 25 * vols.length, totalPages: vols.length } };
      },
      getRewardsLedger: async () => ledger,
    }) as unknown as StonkFunClient;

    test('asks for the volume sort, and the constant is the value StonkFun honors', async () => {
      expect(STONK_VOLUME_SORT).toBe('volume');
      const sorts: unknown[] = [];
      await new StonkIndex(client([500, 400], null, sorts), jupiter, new Cache(), () => NOW).refresh();
      expect(sorts.length).toBe(2);
      expect(sorts.every((s) => s === 'volume')).toBe(true);
    });

    test('stops at the first page that ends on a $0 coin, as a complete walk', async () => {
      const sorts: unknown[] = [];
      const idx = new StonkIndex(client([500, 0, 0, 0], null, sorts), jupiter, new Cache(), () => NOW);
      await idx.refresh();
      expect(sorts.length).toBe(2);
      expect(idx.status().rows).toBe(50);
      expect(idx.status().partial).toBeNull();
    });

    test('a carried row that dropped out of a complete walk shows $0 volume, not its old volume', async () => {
      const idx = new StonkIndex(client([500, 400], null, []), jupiter, new Cache(), () => NOW);
      await idx.refresh();
      const dropped = withVol(page[0], 0, 2).mint;
      expect(idx.getRow(dropped)?.volume24hUsd).toBe(400);
      // Page 2 now holds other coins at $0; the old page-2 coins are not returned at all.
      (idx as any).client = client([500, 0, 0], null, [], 'q');
      await idx.refresh();
      expect(idx.status().partial).toBeNull();
      expect(idx.getRow(dropped)?.volume24hUsd).toBe(0);
      expect(idx.status().rows).toBe(75); // the row stays, so its history stays reachable
    });

    test('after a skipped page, a carried row is capped at the last volume read before the skip', async () => {
      const idx = new StonkIndex(client([500, 400, 300], null, []), jupiter, new Cache(), () => NOW);
      await idx.refresh();
      const p2 = withVol(page[0], 0, 2).mint;
      const p3 = withVol(page[0], 0, 3).mint;
      (idx as any).client = client([500, 40, 30], 2, []); // page 2 skipped: floor = page 1's last coin (500)
      await idx.refresh();
      expect(idx.status().partial?.reason).toBe('skipped page 2 of 3: The operation was aborted.');
      expect(idx.getRow(p2)?.volume24hUsd).toBe(400); // under the floor: unchanged
      expect(idx.getRow(p3)?.volume24hUsd).toBe(30); // page 3 was read after the skip
      (idx as any).client = client([100, 40, 30], 2, []);
      await idx.refresh();
      expect(idx.getRow(p2)?.volume24hUsd).toBe(100); // 400 > floor 100: capped
    });
  });
});

// ---------------------------------------------------------------------------
describe('pairs: buildPairsResult', () => {
  test('normalizes categories and flags agent-launchable pairs', () => {
    const r = buildPairsResult(pairs, { launchable_only: false });
    expect(r.total).toBe(pairs.length);
    expect(r.by_category.prestock).toBeGreaterThan(0); // backpack folded in
    const nvdax = r.pairs.find((p) => p.symbol === 'NVDAX');
    expect(nvdax?.category).toBe('xstock');
    expect(nvdax?.is_agent_launchable).toBe(true);
    const only = buildPairsResult(pairs, { launchable_only: true, category: 'xstock' });
    expect(only.pairs.every((p) => p.is_agent_launchable && p.category === 'xstock')).toBe(true);
    expect(formatStonkPairsBriefing(only)).toContain('Launchable Pairs');
  });
});

// ---------------------------------------------------------------------------
describe.skipIf(!process.env.STONK_LIVE)('LIVE: StonkFun API + chain', () => {
  const client = new StonkFunClient(new Cache());

  test('pairs + pricing + token + rewards respond with the recorded shapes', async () => {
    const p = await client.getPairs();
    expect(p.length).toBeGreaterThan(100);
    const pr = await client.getLaunchLabPricing(EXAMPLE_LAUNCH.quoteMint);
    expect(pr.curve.configId).toBe(EXAMPLE_LAUNCH.configId);
    expect(pr.platform.reward).toBe(EXAMPLE_LAUNCH.platformReward);
    expect(pr.curveRule.reward).toBe(EXAMPLE_LAUNCH.curveRuleReward);
    expect(pr.modes.reward.withdrawWithheldAuthority).toBe(STONKFUN_WITHDRAW_AUTHORITY);
    const t = await client.getToken(zcat.token.mint);
    expect(t?.token.mode).toBe('reward');
    const r = await client.getTokenRewards(zcat.token.mint);
    expect(r?.rewards?.payoutCount).toBeGreaterThan(0);
    expect(await client.getToken('11111111111111111111111111111111')).toBeNull();
  }, 30_000);

  test('live preflight of the example launch has no mismatches', async () => {
    const pr = await client.getLaunchLabPricing(EXAMPLE_LAUNCH.quoteMint);
    const r = diffLaunchAgainstPricing(await decodeLaunchTransaction(buildExampleLaunchTransaction()), pr, 'reward', EXAMPLE_LAUNCH.quoteMint);
    expect(r.mismatches).toEqual([]);
  }, 30_000);
});

// ---------------------------------------------------------------------------
import { scoreGem, quoteStats, payoutStatus, hoursSince } from '../src/enrichers/stonk-gems';
import { describeTransferTax, netPnlAfterExitTaxPct } from '../src/sources/token-2022';
import { buildLaunchIntel, toScreenerRowOut } from '../src/entrypoints/stonk';
import { formatStonkGemsBriefing, formatStonkLaunchIntelBriefing } from '../src/formatters/llm-stonk';
import { toRow, type StonkIndexRow } from '../src/enrichers/stonk-index';
import { POPULATION_CACHE_KEY, buildPopulation, populationStatus, walkAllRewardTokens } from '../src/enrichers/stonk-population';
import { StonkYieldAnalyzer } from '../src/enrichers/stonk-yield';
import { StonkYieldBatchInput, StonkAlertsInput } from '../src/schemas/stonk';
import { formatStonkYieldBatchBriefing, formatStonkAlertsBriefing } from '../src/formatters/llm-stonk';
import { StonkAlertChecker, detectStonkAlerts, baselinePoint, DEFAULT_STONK_ALERT_CRITERIA } from '../src/enrichers/stonk-alerts';

describe('stonk-alerts: detectors', () => {
  const C = DEFAULT_STONK_ALERT_CRITERIA;
  // Runs at registration, before the H/D/iso consts further down exist; test bodies run later and may use them.
  const since = NOW - 6 * 3_600_000;
  const types = (xs: { type: string }[]) => xs.map((a) => a.type).sort();

  test('payout inside the window → payout_landed; no stale; trading', () => {
    const r = row({ lastPayoutAt: iso(NOW - 1 * H), volume24hUsd: 5_000 });
    expect(types(detectStonkAlerts(r, [], 100, since, NOW, C))).toEqual(['payout_landed']);
  });

  test('stale boundary inside the window → payout_stale (high); outside → nothing', () => {
    const wentStale = row({ lastPayoutAt: iso(NOW - 26 * H), volume24hUsd: 5_000 }); // boundary = NOW - 2h, inside
    const a = detectStonkAlerts(wentStale, [], 100, since, NOW, C);
    expect(types(a)).toEqual(['payout_stale']);
    expect(a[0].severity).toBe('high');
    const longStale = row({ lastPayoutAt: iso(NOW - 40 * H), volume24hUsd: 5_000 }); // boundary = NOW - 16h, before since
    expect(detectStonkAlerts(longStale, [], 100, since, NOW, C)).toEqual([]);
  });

  test('no 24h volume → stopped_trading', () => {
    const r = row({ lastPayoutAt: iso(NOW - 40 * H), volume24hUsd: 0 });
    expect(types(detectStonkAlerts(r, [], 100, since, NOW, C))).toEqual(['stopped_trading']);
  });

  test('holders_change against the snapshot nearest to since; rewards_since in quote + USD', () => {
    const series = [
      { t: NOW - 2 * D, dist: 10, marketCapUsd: 1e6, holders: 100 },
      { t: NOW - 1 * D, dist: 40, marketCapUsd: 1e6, holders: 200 }, // latest at or before since (NOW - 6h)
    ];
    const r = row({ lastPayoutAt: iso(NOW - 40 * H), volume24hUsd: 5_000, holderCount: 150, distributedTokens: 55 });
    const a = detectStonkAlerts(r, series, 2, since, NOW, C);
    expect(types(a)).toEqual(['holders_change', 'rewards_since']);
    const h = a.find((x) => x.type === 'holders_change')!;
    expect(h.data).toMatchObject({ from: 200, to: 150, change_pct: -25 });
    expect(h.severity).toBe('medium');
    const rw = a.find((x) => x.type === 'rewards_since')!;
    expect(rw.data).toMatchObject({ rewards_quote: 15, rewards_usd: 30, approximate: true });
  });

  test('baselinePoint: latest at or before since, else the earliest after', () => {
    const s = [{ t: 10, dist: 0, marketCapUsd: 0, holders: 1 }, { t: 20, dist: 0, marketCapUsd: 0, holders: 2 }];
    expect(baselinePoint(s, 15)!.t).toBe(10);
    expect(baselinePoint(s, 5)!.t).toBe(10);
    expect(baselinePoint(s, 25)!.t).toBe(20);
    expect(baselinePoint([], 5)).toBeNull();
  });
});

const H = 3_600_000;
const D = 86_400_000;
const iso = (t: number) => new Date(t).toISOString();

function row(over: Partial<StonkIndexRow> = {}): StonkIndexRow {
  return {
    mint: 'M' + Math.random().toString(36).slice(2, 10),
    symbol: 'X', name: 'X',
    quoteMint: 'QZEC', quoteSymbol: 'ZEC', quoteDecimals: 8, quoteCategory: 'custom', quoteCategoryRaw: 'custom',
    launchpad: 'raydium', mode: 'reward', bps: 300, flywheelActive: false,
    priceUsd: 0.001, marketCapUsd: 250_000, volume24hUsd: 100_000, priceChange24h: 20,
    status: 'graduated', createdAt: iso(NOW - 3 * D), graduatedAt: null,
    distributedTokens: 10, distributedRaw: null, payoutCount: 40, holderCount: 300, lastPayoutAt: iso(NOW - 2 * H),
    ...over,
  };
}

describe('gems: scoreGem + payoutStatus', () => {
  test('a young, paying, small, liquid coin on a strong quote is a GEM', () => {
    const g = scoreGem(row(), NOW, { tradedShare24h: 0.87, coins: 505 });
    expect(g.stage).toBe('GEM');
    expect(g.score).toBeGreaterThanOrEqual(70);
    expect(g.reasons.some((r) => r.includes('paid holders'))).toBe(true);
    expect(g.reasons.some((r) => r.includes('ZEC quote'))).toBe(true);
  });

  test('no 24h volume is DEAD regardless of everything else', () => {
    const g = scoreGem(row({ volume24hUsd: 0 }), NOW, null);
    expect(g.stage).toBe('DEAD');
    expect(g.score).toBe(0);
  });

  test('never-paid, tiny-holder, parabolic coin on a weak quote is NOISE with warnings', () => {
    const g = scoreGem(row({ payoutCount: 0, lastPayoutAt: null, holderCount: 3, priceChange24h: 900, marketCapUsd: 50_000_000, volume24hUsd: 1000 }), NOW, { tradedShare24h: 0.1, coins: 600 });
    expect(g.stage).toBe('NOISE');
    expect(g.warnings.some((w) => w.includes('never paid'))).toBe(true);
    expect(g.warnings.some((w) => w.includes('already ran'))).toBe(true);
    expect(g.warnings.some((w) => w.includes('only 3'))).toBe(true);
  });

  test('a stale payout scores lower than a fresh one, all else equal', () => {
    const fresh = scoreGem(row(), NOW, null).score;
    const stale = scoreGem(row({ lastPayoutAt: iso(NOW - 5 * D) }), NOW, null).score;
    expect(fresh - stale).toBeGreaterThanOrEqual(20);
  });

  test('payoutStatus is what a holder observes', () => {
    expect(payoutStatus(row(), NOW)).toBe('PAYING');
    expect(payoutStatus(row({ lastPayoutAt: iso(NOW - 3 * D) }), NOW)).toBe('STALE');
    expect(payoutStatus(row({ payoutCount: 0, lastPayoutAt: null }), NOW)).toBe('NEVER');
    expect(payoutStatus(row({ mode: 'standard' }), NOW)).toBe('NOT_REWARD');
    expect(hoursSince(iso(NOW - 90 * 60_000), NOW)).toBe(1.5);
    expect(hoursSince(null, NOW)).toBeNull();
  });

  test('reward-risk result carries payout_status + trading_cost', () => {
    const r = scoreRewardRisk({
      mint: zcat.token.mint, listed: true, token: zcat.token, launch: zcat.launch,
      rewards: { ...zcatRewards.rewards, lastPayoutAt: iso(NOW - 1 * H) }, rewardsQuote: zcatRewards.quote,
      onchain: parseMintAccount(mintZcat), expectedWithdrawAuthority: STONKFUN_WITHDRAW_AUTHORITY,
      top10Pct: 20, holderCountRpc: 20, now: NOW,
    });
    expect(r.payout_status).toBe('PAYING');
    expect(r.trading_cost.bps).toBe(300);
    expect(r.trading_cost.round_trip_pct).toBe(6);
    const brief = formatStonkRewardRiskBriefing(r);
    expect(brief).toContain('PAYING');
    expect(brief).toContain('round trip costs 6%');
  });
});

describe('transfer tax as a trading cost', () => {
  test('describeTransferTax reads bps and computes the round trip', () => {
    const t = describeTransferTax(parseMintAccount(mintZcat));
    expect(t?.bps).toBe(300);
    expect(t?.per_transfer_pct).toBe(3);
    expect(t?.round_trip_pct).toBe(6);
    expect(t?.program).toBe('token-2022');
    expect(describeTransferTax(parseMintAccount(null))).toBeNull();
  });

  test('netPnlAfterExitTaxPct pays only the sell leg', () => {
    // +50% gross, 300 bps sell tax -> proceeds 1.5 x 0.97 = 1.455 -> +45.5%
    expect(netPnlAfterExitTaxPct(1, 1.5, 300)).toBe(45.5);
    expect(netPnlAfterExitTaxPct(1, 1, 300)).toBe(-3);
    expect(netPnlAfterExitTaxPct(1, 1.5, 0)).toBe(50);
  });
});

describe('launch intel: quoteStats + buildLaunchIntel', () => {
  const rows: StonkIndexRow[] = [
    // ZEC: 4 coins, 3 traded, 2 paying, 2 older than 3d of which 2 traded
    row({ quoteMint: 'QZEC', quoteSymbol: 'ZEC', createdAt: iso(NOW - 5 * D) }),
    row({ quoteMint: 'QZEC', quoteSymbol: 'ZEC', createdAt: iso(NOW - 4 * D), bps: 100 }),
    row({ quoteMint: 'QZEC', quoteSymbol: 'ZEC', createdAt: iso(NOW - 2 * H), lastPayoutAt: null, payoutCount: 0 }),
    row({ quoteMint: 'QZEC', quoteSymbol: 'ZEC', createdAt: iso(NOW - 1 * D), volume24hUsd: 0, lastPayoutAt: null, payoutCount: 0 }),
    // SPCXX: 6 coins, 1 traded, 0 paying, 5 older than 3d none traded -> crowded, weak
    ...Array.from({ length: 5 }, () => row({ quoteMint: 'QSPCXX', quoteSymbol: 'SPCXX', quoteCategory: 'xstock', createdAt: iso(NOW - 4 * D), volume24hUsd: 0, lastPayoutAt: null, payoutCount: 0 })),
    row({ quoteMint: 'QSPCXX', quoteSymbol: 'SPCXX', quoteCategory: 'xstock', createdAt: iso(NOW - 1 * D), lastPayoutAt: null, payoutCount: 0, bps: 100 }),
  ];

  test('quoteStats aggregates per quote', () => {
    const qs = quoteStats(rows, NOW);
    const zec = qs.find((q) => q.quote_symbol === 'ZEC')!;
    const sp = qs.find((q) => q.quote_symbol === 'SPCXX')!;
    expect(zec.coins).toBe(4);
    expect(zec.traded_24h).toBe(3);
    expect(zec.paying_24h).toBe(2);
    expect(zec.launches_24h).toBe(2);
    expect(zec.launches_7d).toBe(4);
    expect(zec.survival_3d).toBe(1);
    expect(zec.tax_mix).toEqual({ bps_100: 1, bps_300: 3, other: 0 });
    expect(sp.coins).toBe(6);
    expect(sp.traded_share_24h).toBeCloseTo(1 / 6, 3);
    expect(sp.survival_3d).toBe(0);
    expect(zec.demand_score).toBeGreaterThan(sp.demand_score);
  });

  test('buildLaunchIntel ranks by demand, honors min_coins, and writes recommendations', () => {
    const status = { rows: rows.length, lastRefreshAt: iso(NOW), lastRefreshMs: 1, lastError: null, refreshing: false, seriesCoins: 0, seriesDays: 0, oldestPointAt: null, quotePrices: 2 };
    const r = buildLaunchIntel(quoteStats(rows, NOW), { minCoins: 1, sort: 'demand', limit: 10 }, status);
    expect(r.quotes[0].quote_symbol).toBe('ZEC');
    expect(r.quotes[0].rank).toBe(1);
    expect(r.overall.coins).toBe(10);
    expect(r.overall.traded_24h).toBe(4);
    expect(r.overall.tax.bps_300.coins).toBe(8);
    expect(r.overall.tax.bps_100.coins).toBe(2);
    expect(r.overall.by_category.xstock.coins).toBe(6);
    const only5 = buildLaunchIntel(quoteStats(rows, NOW), { minCoins: 5, sort: 'launches', limit: 10 }, status);
    expect(only5.quotes.map((q) => q.quote_symbol)).toEqual(['SPCXX']);
    expect(r.recommendations.length).toBeGreaterThan(0);
    const brief = formatStonkLaunchIntelBriefing(r);
    expect(brief).toContain('Launch Intel');
    expect(brief).toContain('ZEC');
  });

  // 2026-09-23: the index holds only traded coins, so shelf stats over it are overstated. Without fresh
  // population data, launch-intel says so first; with it, it names the source and the page coverage.
  test('buildLaunchIntel: index source leads with the LIMITED caveat; population source names its coverage', () => {
    const status = { rows: rows.length, lastRefreshAt: iso(NOW), lastRefreshMs: 1, lastError: null, refreshing: false, seriesCoins: 0, seriesDays: 0, oldestPointAt: null, quotePrices: 2 };
    const limited = buildLaunchIntel(quoteStats(rows, NOW), { minCoins: 1, sort: 'demand', limit: 10 }, status);
    expect(limited.shelf.source).toBe('index');
    expect(limited.caveats[0]).toStartWith('LIMITED:');
    const population = populationStatus(buildPopulation(rows, NOW - 2 * H, { upstreamTotal: 12, pagesRead: 9, pagesTotal: 10 }), NOW)!;
    const full = buildLaunchIntel(quoteStats(rows, NOW), { minCoins: 1, sort: 'demand', limit: 10 }, status, { source: 'population', population });
    expect(full.shelf).toEqual({ source: 'population', as_of: iso(NOW - 2 * H), coins: 10, pages_read: 9, pages_total: 10 });
    expect(full.caveats[0]).toContain('10 reward coins');
    expect(full.caveats.some((c) => c.startsWith('LIMITED'))).toBe(false);
  });
});

describe('population: summary, freshness, and what the index does with it', () => {
  const page = fixture<{ data: { tokens: StonkToken[] } }>('tokens-reward-page.json').data.tokens;
  const ledger = fixture<{ data: { launches: any[] } }>('rewards-ledger.json').data.launches;
  const fakePrices = async (mints: string[]) => Object.fromEntries(mints.map((m) => [m, { id: m, price: 100, mintSymbol: '', vsToken: '', vsTokenSymbol: 'USDC' }]));
  const jupiter = { getPrice: fakePrices, getPriceUncached: fakePrices } as any;
  const client = {
    getTokens: async () => ({ tokens: page, pagination: { page: 1, pageSize: 25, total: page.length, totalPages: 1 } }),
    getRewardsLedger: async () => ledger,
  } as unknown as StonkFunClient;
  // Population where every quote has half its coins traded → the quote factor adds points.
  const popRows = (): StonkIndexRow[] => {
    const ledgerByMint = new Map(ledger.map((l: any) => [l.mint, l]));
    const traded = page.map((t) => toRow(t, ledgerByMint.get(t.mint) as any));
    const idle = traded.map((r) => ({ ...r, mint: `${r.mint.slice(0, 40)}idle`, volume24hUsd: 0 }));
    return [...traded, ...idle];
  };

  test('populationStatus: fresh up to 48h, stale after, null for junk', () => {
    const p = buildPopulation(popRows(), NOW, { upstreamTotal: 50, pagesRead: 1, pagesTotal: 1 });
    expect(p.coins).toBe(50);
    expect(populationStatus(p, NOW + 47 * H)!.fresh).toBe(true);
    expect(populationStatus(p, NOW + 49 * H)!.fresh).toBe(false);
    expect(populationStatus(null, NOW)).toBeNull();
    expect(populationStatus({ version: 2 } as any, NOW)).toBeNull();
  });

  test('no population: gems skip the quote factor, shelf source is the index', async () => {
    const idx = new StonkIndex(client, jupiter, new Cache(), () => NOW);
    await idx.refresh();
    expect(idx.shelfStats().source).toBe('index');
    const g = idx.gems({ maxAgeDays: 3650, minHolders: 0, maxMarketCapUsd: 1e15, limit: 50 });
    expect(g.gems.length).toBeGreaterThan(0);
    expect(g.gems.every((r) => r.gem.reasons.concat(r.gem.warnings).every((s) => !s.includes(' quote: ')))).toBe(true);
  });

  test('fresh population in the cache: loaded on refresh, used for shelf stats and the gem quote factor', async () => {
    const cache = new Cache();
    await cache.set(POPULATION_CACHE_KEY, buildPopulation(popRows(), NOW - H, { upstreamTotal: 50, pagesRead: 1, pagesTotal: 1 }), 3600);
    const idx = new StonkIndex(client, jupiter, cache, () => NOW);
    await idx.refresh();
    const shelf = idx.shelfStats();
    expect(shelf.source).toBe('population');
    expect(shelf.stats.reduce((s, q) => s + q.coins, 0)).toBe(50);
    const g = idx.gems({ maxAgeDays: 3650, minHolders: 0, maxMarketCapUsd: 1e15, limit: 50 });
    expect(g.gems.some((r) => r.gem.reasons.concat(r.gem.warnings).some((s) => s.includes(' quote: ')))).toBe(true);
  });

  test('stale population (> 48h): falls back to the index', async () => {
    const cache = new Cache();
    await cache.set(POPULATION_CACHE_KEY, buildPopulation(popRows(), NOW - 50 * H, { upstreamTotal: 50, pagesRead: 1, pagesTotal: 1 }), 3600);
    const idx = new StonkIndex(client, jupiter, cache, () => NOW);
    await idx.refresh();
    expect(idx.shelfStats().source).toBe('index');
    expect(idx.populationStatus()!.fresh).toBe(false);
  });

  // stonk-yield-batch: the buyer loop seen in production was screener → stonk-yield per coin.
  test('yield batch: by mints (found + not_found) and by filters, same math as the single-coin path', async () => {
    const idx = new StonkIndex(client, jupiter, new Cache(), () => NOW);
    await idx.refresh();
    const analyzer = new StonkYieldAnalyzer(client, idx, jupiter, new Cache());
    const known = page[0].mint;
    const unknown = 'So11111111111111111111111111111111111111112';
    const byMints = analyzer.batch({ mints: [known, unknown, known], filters: {} }, NOW);
    expect(byMints.selection).toEqual({ mode: 'mints', requested: 3, matched: 1, limit: 3 });
    expect(byMints.coins.map((c) => c.mint)).toEqual([known]); // duplicates collapse
    expect(byMints.not_found).toEqual([unknown]);
    expect(byMints.caveats.some((c) => c.includes('not in the index'))).toBe(true);
    const single = analyzer.fromIndexRow(idx.getRow(known)!, NOW);
    expect(byMints.coins[0]).toEqual({ ...single, rank: 1 });

    const byFilters = analyzer.batch({ filters: { sort: 'volume24h', limit: 5 } }, NOW);
    expect(byFilters.selection.mode).toBe('filters');
    expect(byFilters.coins.length).toBe(5);
    expect(byFilters.coins.map((c) => c.rank)).toEqual([1, 2, 3, 4, 5]);
    for (const c of byFilters.coins) {
      expect(c.trailing_7d.window_days).toBe(7);
      expect(c.trailing_30d.window_days).toBe(30);
      expect(typeof c.reward_asset.symbol).toBe('string');
    }
    const brief = formatStonkYieldBatchBriefing({ ...byFilters });
    expect(brief).toContain('Holder Yield');
    expect(brief.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| #')).length).toBe(5);
  });

  test('yield batch input: at most 25 mints, limit capped at 25', () => {
    const m = page[0].mint;
    expect(StonkYieldBatchInput.safeParse({ mints: Array(25).fill(m) }).success).toBe(true);
    expect(StonkYieldBatchInput.safeParse({ mints: Array(26).fill(m) }).success).toBe(false);
    expect(StonkYieldBatchInput.safeParse({ limit: 26 }).success).toBe(false);
    expect(StonkYieldBatchInput.parse({}).limit).toBe(25);
  });

  test('stonk-alerts: watchlist against the index — status rows, not_found, since clamp', async () => {
    const idx = new StonkIndex(client, jupiter, new Cache(), () => NOW);
    await idx.refresh();
    const checker = new StonkAlertChecker(idx);
    const known = page[0].mint;
    const unknown = 'So11111111111111111111111111111111111111112';
    const r = checker.check([known, unknown], iso(NOW - 40 * D), {}, NOW);
    expect(r.since_clamped_from).toBe(iso(NOW - 40 * D));
    expect(r.since).toBe(iso(NOW - 31 * D));
    expect(r.coins.map((c) => c.mint)).toEqual([known]);
    expect(r.not_found).toEqual([unknown]);
    expect(['PAYING', 'STALE', 'NEVER', 'NOT_REWARD']).toContain(r.coins[0].payout_status);
    expect(r.checked_at).toBe(iso(NOW));
    const order = { high: 0, medium: 1, low: 2 } as const;
    for (let i = 1; i < r.alerts.length; i++) expect(order[r.alerts[i - 1].severity]).toBeLessThanOrEqual(order[r.alerts[i].severity]);
    expect(formatStonkAlertsBriefing(r)).toContain('StonkFun Alerts');
    expect(StonkAlertsInput.safeParse({ mints: [known], since: '2026-09-23T00:00:00Z' }).success).toBe(true);
    expect(StonkAlertsInput.safeParse({ mints: [], since: '2026-09-23T00:00:00Z' }).success).toBe(false);
    expect(StonkAlertsInput.safeParse({ mints: [known] }).success).toBe(false);
  });

  test('walkAllRewardTokens: skips a failed page after one retry pass, counts coverage', async () => {
    let calls = 0;
    const sorts = new Set<unknown>();
    const flaky = {
      getTokens: async ({ page: n, sort }: { page: number; sort?: string }) => {
        calls++;
        sorts.add(sort);
        if (n === 3) throw new Error('The operation was aborted.');
        return { tokens: page.slice(0, 2).map((t) => ({ ...t, mint: `${t.mint.slice(0, 40)}w${n}` })), pagination: { page: n, pageSize: 2, total: 8, totalPages: 4 } };
      },
    } as unknown as StonkFunClient;
    const w = await walkAllRewardTokens(flaky, { concurrency: 2, timeoutMs: 100 });
    expect(w.pagesTotal).toBe(4);
    expect(w.pagesRead).toBe(3);
    expect(w.failedPages).toEqual([3]);
    expect(w.tokens.length).toBe(6);
    expect(w.upstreamTotal).toBe(8);
    expect(calls).toBe(5); // pages 1, 2, 3, 4 + one retry of 3
    expect([...sorts]).toEqual(['newest']); // the stable order: market cap reshuffles during a walk
  });
});

describe('index: gems + new screener filters', () => {
  const makeIndex = async () => {
    const page = fixture<{ data: { tokens: StonkToken[] } }>('tokens-reward-page.json').data.tokens;
    const ledger = fixture<{ data: { launches: any[] } }>('rewards-ledger.json').data.launches;
    const client = {
      getTokens: async () => ({ tokens: page, pagination: { page: 1, pageSize: 25, total: page.length, totalPages: 1 } }),
      getRewardsLedger: async () => ledger,
    } as unknown as StonkFunClient;
    const fakePrices = async (mints: string[]) => Object.fromEntries(mints.map((m) => [m, { id: m, price: 100, mintSymbol: '', vsToken: '', vsTokenSymbol: 'USDC' }]));
    const jupiter = { getPrice: fakePrices, getPriceUncached: fakePrices } as any;
    const idx = new StonkIndex(client, jupiter, new Cache(), () => NOW);
    await idx.refresh();
    return idx;
  };

  test('screener rows carry payout status, live flag, and round-trip cost; filters apply', async () => {
    const idx = await makeIndex();
    const all = idx.screen({ limit: 100 });
    expect(all.rows.length).toBeGreaterThan(0);
    for (const r of all.rows) {
      expect(['PAYING', 'STALE', 'NEVER', 'NOT_REWARD']).toContain(r.payoutStatus);
      if (r.bps != null) expect(r.roundTripPct).toBe(r.bps * 2 / 100);
      expect(r.live).toBe(r.paying24h && r.volume24hUsd > 0);
    }
    const paying = idx.screen({ payingOnly: true, limit: 100 });
    expect(paying.rows.every((r) => r.paying24h)).toBe(true);
    const live = idx.screen({ liveOnly: true, limit: 100 });
    expect(live.rows.every((r) => r.live)).toBe(true);
    expect(live.matched).toBeLessThanOrEqual(paying.matched);
    const small = idx.screen({ maxMarketCapUsd: 1, limit: 100 });
    expect(small.rows.every((r) => r.marketCapUsd <= 1)).toBe(true);
    const byPayout = idx.screen({ sort: 'lastPayout', limit: 100 }).rows.filter((r) => r.hoursSinceLastPayout != null);
    for (let i = 1; i < byPayout.length; i++) expect(byPayout[i - 1].hoursSinceLastPayout!).toBeLessThanOrEqual(byPayout[i].hoursSinceLastPayout!);
    const out = toScreenerRowOut(all.rows[0], 1);
    expect(out.rank).toBe(1);
    expect(out.payout_status).toBe(all.rows[0].payoutStatus);
  });

  test('gems() scores, ranks, and respects filters; briefing renders', async () => {
    const idx = await makeIndex();
    const g = idx.gems({ maxAgeDays: 3650, minHolders: 0, maxMarketCapUsd: 1e15, limit: 10 });
    expect(g.scanned).toBe(25);
    expect(g.gems.length).toBeLessThanOrEqual(10);
    for (let i = 1; i < g.gems.length; i++) expect(g.gems[i - 1].gem.score).toBeGreaterThanOrEqual(g.gems[i].gem.score);
    expect(g.stageCounts.DEAD).toBe(0); // zero-volume rows are filtered before scoring
    const none = idx.gems({ maxAgeDays: 0, limit: 10 });
    expect(none.gems.length).toBe(0);
    const qs = idx.quoteStats();
    expect(qs.reduce((a, q) => a + q.coins, 0)).toBe(25);
    expect(idx.quoteStats()).toBe(qs); // memoized per refresh
    const brief = formatStonkGemsBriefing({
      gems: g.gems.map((r, i) => ({
        rank: i + 1, mint: r.mint, symbol: r.symbol, name: r.name, quote_mint: r.quoteMint, quote_symbol: r.quoteSymbol, quote_category: r.quoteCategory,
        gem_score: r.gem.score, stage: r.gem.stage, reasons: r.gem.reasons, warnings: r.gem.warnings, payout_status: r.payoutStatus,
        hours_since_last_payout: r.hoursSinceLastPayout, payout_count: r.payoutCount, transfer_fee_bps: r.bps, round_trip_pct: r.roundTripPct,
        holder_count: r.holderCount, age_days: r.ageDays, price_usd: r.priceUsd, market_cap_usd: r.marketCapUsd, volume_24h_usd: r.volume24hUsd,
        turnover_24h_pct: null, price_change_24h_pct: r.priceChange24h, flywheel_active: r.flywheelActive, rewards_usd: r.rewardsUsd, yield_7d_pct: r.yield7dPct,
        launchpad: r.launchpad, status: r.status,
      })),
      scanned: g.scanned, passed_filters: g.passedFilters, stage_counts: g.stageCounts,
      filters: { quote_mint: null, category: null, max_age_days: 3650, min_holders: 0, max_market_cap_usd: 1e15, limit: 10 },
      index: { rows: 25, last_refresh_at: iso(NOW), series_days: 0, oldest_point_at: null }, caveats: [], next_steps: [],
    });
    expect(brief).toContain('StonkFun Gems');
    expect(brief).toContain('How to read this');
  });
});

// ---------------------------------------------------------------------------
import { buildStonkQuote, impactAtSize, pickYieldBasis } from '../src/enrichers/stonk-quote';
import { formatStonkQuoteBriefing } from '../src/formatters/llm-stonk';

describe('stonk-quote: pure math', () => {
  const est = [
    { size_usd: 100, price_impact_pct: 0.1 }, { size_usd: 1000, price_impact_pct: 0.5 },
    { size_usd: 10000, price_impact_pct: 3 }, { size_usd: 100000, price_impact_pct: 20 },
  ].map((e) => ({ ...e, output_amount: 0, input_amount: 0 }));

  test('impactAtSize interpolates on a log scale and clamps at the ends', () => {
    expect(impactAtSize(est, 100)).toBe(0.1);
    expect(impactAtSize(est, 1000)).toBe(0.5);
    const mid = impactAtSize(est, 3162)!; // geometric midpoint of 1K and 10K
    expect(mid).toBeGreaterThan(1.5); expect(mid).toBeLessThan(2.0);
    expect(impactAtSize(est, 1_000_000)).toBe(20);
    expect(impactAtSize(est, 10)).toBe(0.01);
    expect(impactAtSize(undefined, 100)).toBeNull();
    expect(impactAtSize([], 100)).toBeNull();
  });

  const win = (yield_pct: number | null, actual_days: number | null, window_days: number, caution = false) =>
    ({ window_days, actual_days, rewards_quote: null, rewards_usd: yield_pct != null ? 100 : null, avg_market_cap_usd: 1e6, yield_pct, annualized_pct: null, caution, caution_reason: caution ? 'partial' : null });

  test('pickYieldBasis prefers the shortest complete window, else lifetime', () => {
    expect(pickYieldBasis({ trailing_7d: win(1, 7, 7), trailing_30d: win(4, 30, 30), lifetime: win(6, 40, 0) }).basis).toBe('7d');
    expect(pickYieldBasis({ trailing_7d: win(1, 3, 7, true), trailing_30d: win(4, 10, 30, true), lifetime: win(6, 12, 0) }).basis).toBe('30d');
    expect(pickYieldBasis({ trailing_7d: win(null, null, 7, true), trailing_30d: win(null, null, 30, true), lifetime: win(2, 2, 0) }).basis).toBe('lifetime');
    expect(pickYieldBasis({ trailing_7d: win(null, null, 7, true), trailing_30d: win(null, null, 30, true), lifetime: win(null, null, 0, true) }).basis).toBeNull();
  });

  const risk = (over: Partial<any> = {}) => ({
    mint: 'M', symbol: 'ZCAT', name: 'Anonymous Cat', payout_status: 'PAYING', trading_cost: { bps: 300, per_transfer_pct: 3, round_trip_pct: 6 },
    score: 90, level: 'HEALTHY', reasons: [], warnings: [], reward_mechanism: 'transfer_tax',
    adoption: { listed_on_stonkfun: true, mode: 'reward', launchpad: 'raydium', withdraw_authority_is_stonkfun: true },
    transfer_fee: { onchain_bps: 300, onchain_maximum_fee_raw: '1', maximum_fee_binds: false, withdraw_withheld_authority: 'X', config_authority: null, withheld_amount_raw: '0', stonkfun_bps: 300, token_program: 'token-2022' },
    rewards: { distributed_tokens: 10, distributed_raw: null, reward_asset: 'ZEC', payout_count: 100, holder_count: 500, last_payout_at: null, hours_since_last_payout: 1 },
    flywheel_active: true, holders: { count: 500, top10_pct: 20, source: 'stonkfun' },
    quote: { mint: 'Q', symbol: 'ZEC', category: 'custom', category_raw: 'custom' },
    market: { price_usd: 0.1, market_cap_usd: 1_000_000, volume_24h_usd: 50_000, price_change_24h_pct: 5 },
    age_days: 10, status: 'graduated', graduated: true, next_steps: [], ...over,
  }) as any;
  const yld = (weeklyPct: number) => ({
    mint: 'M', symbol: 'ZCAT', name: null, mode: 'reward', reward_asset: { mint: 'Q', symbol: 'ZEC', decimals: 8, category: 'custom', usd_price: 50 },
    lifetime: win(weeklyPct * 4, 28, 0), trailing_7d: win(weeklyPct, 7, 7), trailing_30d: win(weeklyPct * 4, 28, 30, true),
    quote_exposure: { long: ['ZCAT', 'ZEC'], reward_asset: 'ZEC', note: '' }, distributed_tokens_total: 10, payout_count: 100, holder_count: 500,
    last_payout_at: null, market_cap_usd: 1_000_000, age_days: 10, history: { points: 10, oldest_at: null, index_started: true }, caveats: [], next_steps: [],
  }) as any;
  const token = { price_usd: 0.1, market_cap: 1_000_000, volume_24h: 50_000, liquidity: 200_000, slippage_estimates: est, transfer_tax: { bps: 300 } } as any;
  const NOWQ = Date.parse('2026-09-17T00:00:00Z');

  test('a coin paying 8%/week PAYS at $100 over 7 days; costs are tax + impact each way', () => {
    const q = buildStonkQuote({ mint: 'M', sizeUsd: 100, holdDays: 7, risk: risk(), yld: yld(8), token, now: NOWQ });
    expect(q.entry.tax_pct).toBe(3); expect(q.entry.price_impact_pct).toBe(0.1); expect(q.entry.total_pct).toBe(3.1);
    expect(q.round_trip.cost_pct).toBe(6.2); expect(q.round_trip.cost_usd).toBe(6.2);
    expect(q.round_trip.breakeven_move_pct).toBeGreaterThan(6.2); // (1.031/0.969 − 1) ≈ 6.4%
    expect(q.expected_payout.basis).toBe('7d'); expect(q.expected_payout.usd_per_week).toBe(8); expect(q.expected_payout.usd_over_hold).toBe(8);
    expect(q.net.verdict).toBe('MARGINAL'); // 8 ≥ 6.2 but < 9.3
    const q2 = buildStonkQuote({ mint: 'M', sizeUsd: 100, holdDays: 14, risk: risk(), yld: yld(8), token, now: NOWQ });
    expect(q2.net.verdict).toBe('PAYS'); expect(q2.net.usd_over_hold).toBe(9.8);
    expect(q2.net.breakeven_hold_days).toBeCloseTo(5.43, 1);
    expect(q.eligibility.share_of_supply_pct).toBe(0.01);
  });

  test('a thin payout COSTS; no payouts is NOT_PAYING; no history is UNKNOWN', () => {
    expect(buildStonkQuote({ mint: 'M', sizeUsd: 100, holdDays: 7, risk: risk(), yld: yld(0.5), token, now: NOWQ }).net.verdict).toBe('COSTS');
    const never = buildStonkQuote({ mint: 'M', sizeUsd: 100, holdDays: 7, risk: risk({ payout_status: 'NEVER' }), yld: yld(8), token, now: NOWQ });
    expect(never.net.verdict).toBe('NOT_PAYING'); expect(never.warnings.some((w) => w.includes('never paid'))).toBe(true);
    const none = buildStonkQuote({ mint: 'M', sizeUsd: 100, holdDays: 7, risk: risk(), yld: null, token, now: NOWQ });
    expect(none.net.verdict).toBe('UNKNOWN'); expect(none.caveats.some((c) => c.includes('unknown, not zero'))).toBe(true);
  });

  test('size drives impact and dust risk; missing token leg degrades to tax only', () => {
    const big = buildStonkQuote({ mint: 'M', sizeUsd: 10_000, holdDays: 7, risk: risk(), yld: yld(8), token, now: NOWQ });
    expect(big.entry.price_impact_pct).toBe(3); expect(big.round_trip.cost_pct).toBe(12);
    const tiny = buildStonkQuote({ mint: 'M', sizeUsd: 1, holdDays: 7, risk: risk(), yld: yld(8), token, now: NOWQ });
    expect(tiny.eligibility.dust_risk).toBe(true);
    const noTok = buildStonkQuote({ mint: 'M', sizeUsd: 100, holdDays: 7, risk: risk(), yld: yld(8), token: null, now: NOWQ });
    expect(noTok.entry.price_impact_pct).toBeNull(); expect(noTok.entry.total_pct).toBe(3);
    expect(noTok.caveats.some((c) => c.includes('tax only'))).toBe(true);
    const brief = formatStonkQuoteBriefing(big);
    expect(brief).toContain('StonkFun Quote'); expect(brief).toContain('Round trip');
  });
});
