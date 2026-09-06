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
import { StonkIndex, trailingYield, normalizeCategory, type DayPoint } from '../src/enrichers/stonk-index';
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
    const jupiter = { getPrice: async (mints: string[]) => Object.fromEntries(mints.map((m) => [m, { id: m, price: 100, mintSymbol: '', vsToken: '', vsTokenSymbol: 'USDC' }])) } as any;
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
