/**
 * Flash venue status (2026-11-02): honest unavailable reasons and the skip-after-failure window.
 * Offline: fetch is replaced. Run: bun test test/perps-flash.test.ts
 */
import { describe, test, expect, afterEach } from 'bun:test';
import { flashUnavailableReason } from '../src/enrichers/perps-cross-venue';
import { FlashPerpsClient, SOURCE_RETRY_MS } from '../src/sources/flash-perps';
import { NULL_CACHE } from '../src/lib/upstream-canary';

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe('flashUnavailableReason', () => {
  test('source down says so and does not blame the venue', () => {
    const r = flashUnavailableReason('SOL', false, 'unreachable');
    expect(r).toContain('not responding');
    expect(r).toContain('Flash itself is live');
    expect(r).not.toContain('SOL not available');
  });

  test('source ok but no market → not listed (or slow)', () => {
    expect(flashUnavailableReason('BONK', false, 'ok')).toBe('BONK is not listed on Flash, or its data did not load in time.');
  });

  test('market loaded but no borrow rate keeps the old message', () => {
    expect(flashUnavailableReason('SOL', true, 'ok')).toBe('Flash borrow-rate read failed.');
  });
});

describe('FlashPerpsClient source status', () => {
  test('a failed pool-data fetch marks the source unreachable and skips the next fetch', async () => {
    let calls = 0;
    globalThis.fetch = (async () => { calls++; throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    const client = new FlashPerpsClient(NULL_CACHE);
    expect(client.sourceStatus()).toBe('ok');
    expect(await client.getMarket('SOL')).toBeNull();
    expect(client.sourceStatus()).toBe('unreachable');
    expect(await client.getMarket('BTC')).toBeNull();
    expect(calls).toBe(1);
    expect(client.sourceStatus(Date.now() + SOURCE_RETRY_MS + 1)).toBe('ok');
  });

  test('a successful fetch with no matching symbol is "ok" (not listed)', async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ pools: [{ custodyStats: [{ symbol: 'XAU', custodyAccount: 'x', utilizationUi: '1', priceUi: '1', totalUsdOwnedAmountUi: '1' }] }] }))) as unknown as typeof fetch;
    const client = new FlashPerpsClient(NULL_CACHE);
    expect(await client.getMarket('SOL')).toBeNull();
    expect(client.sourceStatus()).toBe('ok');
  });
});
