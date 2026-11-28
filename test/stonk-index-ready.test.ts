// A paid call must not settle for an empty answer (2026-11-28). After a restart the StonkFun index has no rows for
// about a minute. The index-backed handlers used to return 200 with zero rows and a "warming up" caveat, so the
// payment settled. They now throw: the HTTP layer answers 500 and the x402 middleware does not settle a failed call.
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StonkIndex, StonkIndexNotReadyError } from '../src/enrichers/stonk-index';
import { registerStonkEntrypoints } from '../src/entrypoints/stonk';
import type { StonkFunClient, StonkToken } from '../src/sources/stonkfun';
import { Cache } from '../src/cache';

const FIX = join(import.meta.dir, 'fixtures', 'stonk');
const fixture = <T>(name: string): T => JSON.parse(readFileSync(join(FIX, name), 'utf8')) as T;
const NOW = Date.parse('2026-09-06T12:00:00Z');

type Handler = (ctx: { input: Record<string, unknown> }) => Promise<{ output: unknown }>;

function handlersFor(index: StonkIndex): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  const fail = () => { throw new Error('an analyzer ran before the index check'); };
  registerStonkEntrypoints((def: { key: string; handler: Handler }) => { handlers.set(def.key, def.handler); }, {
    client: {} as any,
    index,
    rewardRisk: {} as any,
    yieldAnalyzer: { batch: fail } as any,
    preflight: {} as any,
    quote: {} as any,
    creator: { analyze: fail } as any,
    pulse: { analyze: fail } as any,
    cache: new Cache(),
  });
  return handlers;
}

const emptyIndex = () => new StonkIndex({} as any, {} as any, new Cache(), () => NOW);

async function filledIndex(): Promise<StonkIndex> {
  const page = fixture<{ data: { tokens: StonkToken[] } }>('tokens-reward-page.json').data.tokens;
  const ledger = fixture<{ data: { launches: any[] } }>('rewards-ledger.json').data.launches;
  const client = {
    getTokens: async () => ({ tokens: page, pagination: { page: 1, pageSize: 25, total: page.length, totalPages: 1 } }),
    getRewardsLedger: async () => ledger,
  } as unknown as StonkFunClient;
  const prices = async (mints: string[]) => Object.fromEntries(mints.map((m) => [m, { id: m, price: 100, mintSymbol: '', vsToken: '', vsTokenSymbol: 'USDC' }]));
  const idx = new StonkIndex(client, { getPrice: prices, getPriceUncached: prices } as any, new Cache(), () => NOW);
  await idx.refresh();
  return idx;
}

const INDEX_BACKED: Array<[string, Record<string, unknown>]> = [
  ['stonk-gems', { limit: 3, max_age_days: 14, min_holders: 25, max_market_cap_usd: 5_000_000, format: 'json' }],
  ['stonk-screener', { sort: 'volume24h', limit: 5, paying_only: false, live_only: false, format: 'json' }],
  ['stonk-yield-batch', { limit: 5, format: 'json' }],
  ['stonk-alerts', { mints: ['So11111111111111111111111111111111111111112'], format: 'json' }],
  ['stonk-market-pulse', { format: 'json' }],
  ['stonk-creator', { creator: 'So11111111111111111111111111111111111111112', format: 'json' }],
  ['stonk-launch-intel', { sort: 'demand', limit: 5, min_coins: 1, format: 'json' }],
];

describe('index-backed stonk endpoints refuse to answer from an empty index', () => {
  test('assertReady throws on an empty index and tells the caller to retry', () => {
    const idx = emptyIndex();
    expect(() => idx.assertReady()).toThrow(StonkIndexNotReadyError);
    expect(() => idx.assertReady()).toThrow(/Retry in about a minute/);
  });

  for (const [key, input] of INDEX_BACKED) {
    test(`${key} throws before any work when the index has no rows`, async () => {
      const handler = handlersFor(emptyIndex()).get(key)!;
      expect(handler).toBeDefined();
      await expect(handler({ input })).rejects.toBeInstanceOf(StonkIndexNotReadyError);
    });
  }

  test('a filled index answers: assertReady passes and stonk-gems returns rows', async () => {
    const idx = await filledIndex();
    expect(() => idx.assertReady()).not.toThrow();
    const res = await handlersFor(idx).get('stonk-gems')!({ input: { limit: 3, max_age_days: 100000, min_holders: 0, max_market_cap_usd: 1e12, format: 'json' } });
    const out = res.output as { scanned: number; index: { rows: number } };
    expect(out.index.rows).toBe(25);
    expect(out.scanned).toBeGreaterThan(0);
  });
});
