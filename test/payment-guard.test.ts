// Unit tests for the fail-closed paywall (src/lib/payment-guard.ts). The fake
// Lucid routes are registered AFTER the guard, as in src/lib/agent.ts, where
// the guard is installed before any addEntrypoint call.
import { describe, test, expect } from 'bun:test';
import { Hono } from 'hono';
import { paymentsRequired, paywallClosedMiddleware, skipX402ForMpp } from '../src/lib/payment-guard';

describe('paymentsRequired', () => {
  test('Railway is production', () => {
    expect(paymentsRequired({ RAILWAY_ENVIRONMENT_NAME: 'production' })).toBe(true);
    expect(paymentsRequired({ RAILWAY_ENVIRONMENT_ID: 'abc' })).toBe(true);
    expect(paymentsRequired({ RAILWAY_ENVIRONMENT: 'production' })).toBe(true);
  });
  test('local dev is not, unless REQUIRE_PAYMENTS=true', () => {
    expect(paymentsRequired({})).toBe(false);
    expect(paymentsRequired({ REQUIRE_PAYMENTS: 'TRUE' })).toBe(true);
  });
  test('REQUIRE_PAYMENTS=false overrides Railway', () => {
    expect(paymentsRequired({ RAILWAY_ENVIRONMENT_NAME: 'production', REQUIRE_PAYMENTS: 'false' })).toBe(false);
  });
});

describe('skipX402ForMpp', () => {
  test('skips only with an MPP credential AND MPP installed', () => {
    expect(skipX402ForMpp('Payment abc', true)).toBe(true);
    expect(skipX402ForMpp('Payment abc', false)).toBe(false);
    expect(skipX402ForMpp('Bearer abc', true)).toBe(false);
    expect(skipX402ForMpp(undefined, true)).toBe(false);
  });
});

describe('paywallClosedMiddleware', () => {
  const app = new Hono();
  app.use('/entrypoints/*', paywallClosedMiddleware(['stonk-pairs']));
  app.get('/entrypoints', (c) => c.json({ items: [] }));
  app.post('/entrypoints/:key/invoke', (c) => c.json({ output: 'paid data' }));
  app.post('/entrypoints/:key/stream', (c) => c.json({ output: 'paid data' }));
  app.get('/health', (c) => c.text('ok'));

  const call = (method: string, path: string) =>
    app.fetch(new Request(`http://x${path}`, { method, body: method === 'POST' ? '{}' : undefined }));

  for (const path of [
    '/entrypoints/enrich-token-light/invoke',
    '/entrypoints/smart-money-flow/invoke',
    '/entrypoints/%65nrich-token-light/invoke',
    '/entrypoints/enrich-token-light/%69nvoke',
    '/entrypoints/enrich-token-light/stream',
    '/entrypoints/unknown-key/invoke',
  ]) {
    test(`POST ${path} → 503`, async () => {
      const res = await call('POST', path);
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('60');
      expect(((await res.json()) as { error: string }).error).toBe('payments_unavailable');
    });
  }

  test('free endpoint still runs', async () => {
    expect((await call('POST', '/entrypoints/stonk-pairs/invoke')).status).toBe(200);
  });
  test('entrypoint list and other routes stay open', async () => {
    expect((await call('GET', '/entrypoints')).status).toBe(200);
    expect((await call('GET', '/health')).status).toBe(200);
  });
});
