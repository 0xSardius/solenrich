/**
 * Settle-first middleware + cache warmer (A1, 2026-09-20).
 * Run: bun test test/settle-first.test.ts
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { settleFirstMiddleware, settleFirstStats, type SettleFirstServer } from '../src/lib/settle-first';
import { CacheWarmer } from '../src/lib/cache-warmer';

type Mode = 'verified' | 'no-payment' | 'payment-error' | 'settle-fails' | 'settle-throws';

function fakeServer(mode: Mode, order: string[]): SettleFirstServer {
  return {
    requiresPayment: () => true,
    processHTTPRequest: async () => {
      order.push('verify');
      if (mode === 'no-payment') return { type: 'no-payment-required' } as any;
      if (mode === 'payment-error') {
        return { type: 'payment-error', response: { status: 402, headers: { 'payment-required': 'abc' }, body: { error: 'no payment' } } } as any;
      }
      return { type: 'payment-verified', paymentPayload: { p: 1 }, paymentRequirements: { r: 1 }, declaredExtensions: undefined, cancellationDispatcher: { cancel: async () => {} } } as any;
    },
    processSettlement: async (_p, _r, _e, transport) => {
      order.push('settle');
      if (mode === 'settle-throws') throw new Error('facilitator down');
      if (mode === 'settle-fails') {
        return { success: false, errorReason: 'transaction_simulation_failed', response: { status: 402, headers: { 'payment-response': 'ZmFpbA==' }, body: { error: 'settle failed' } } } as any;
      }
      // Settle-first passes no response body: the handler has not run yet.
      expect(transport?.responseBody).toBeUndefined();
      return { success: true, headers: { 'payment-response': 'b2s=' } } as any;
    },
  };
}

function appWith(server: SettleFirstServer, order: string[], handler: 'ok' | 'fail' | 'throw', onLoss?: (l: any) => void) {
  const app = new Hono();
  app.use('/entrypoints/*', settleFirstMiddleware(server, { onLoss }));
  app.post('/entrypoints/:key/invoke', (c) => {
    order.push('handler');
    if (handler === 'throw') throw new Error('boom');
    if (handler === 'fail') return c.json({ error: 'upstream' }, 500);
    return c.json({ ok: true });
  });
  return app;
}

const post = (app: Hono, key = 'smart-money-flow') =>
  app.request(`http://x/entrypoints/${key}/invoke`, { method: 'POST', headers: { 'payment-signature': 'sig' } });

describe('settle-first middleware', () => {
  beforeEach(() => {
    settleFirstStats.today = 0;
    settleFirstStats.settledToday = 0;
    settleFirstStats.lastKey = null;
    settleFirstStats.lastStatus = null;
  });

  test('settles BEFORE the handler and attaches the settlement header to the 200', async () => {
    const order: string[] = [];
    const res = await post(appWith(fakeServer('verified', order), order, 'ok'));
    expect(res.status).toBe(200);
    expect(order).toEqual(['verify', 'settle', 'handler']);
    expect(res.headers.get('payment-response')).toBe('b2s=');
    expect(await res.json()).toEqual({ ok: true });
    expect(settleFirstStats.settledToday).toBe(1);
    expect(settleFirstStats.today).toBe(0);
  });

  test('handler 5xx after settlement is a counted loss, still carries the receipt header', async () => {
    const order: string[] = [];
    const losses: any[] = [];
    const res = await post(appWith(fakeServer('verified', order), order, 'fail', (l) => losses.push(l)));
    expect(res.status).toBe(500);
    expect(order).toEqual(['verify', 'settle', 'handler']);
    expect(res.headers.get('payment-response')).toBe('b2s=');
    expect(losses).toEqual([{ key: 'smart-money-flow', status: 500 }]);
    expect(settleFirstStats.today).toBe(1);
    expect(settleFirstStats.lastKey).toBe('smart-money-flow');
  });

  test('handler throw after settlement is a counted loss (Hono routes the throw to onError before next() resolves)', async () => {
    const order: string[] = [];
    const losses: any[] = [];
    const app = appWith(fakeServer('verified', order), order, 'throw', (l) => losses.push(l));
    app.onError((_e, c) => c.json({ error: 'crashed' }, 500));
    const res = await post(app);
    expect(res.status).toBe(500);
    expect(order).toEqual(['verify', 'settle', 'handler']);
    expect(losses).toHaveLength(1);
    expect(losses[0]).toMatchObject({ key: 'smart-money-flow', status: 500 });
    expect(res.headers.get('payment-response')).toBe('b2s=');
    expect(settleFirstStats.today).toBe(1);
  });

  test('a refused settlement returns the facilitator 402 and never runs the handler', async () => {
    const order: string[] = [];
    const res = await post(appWith(fakeServer('settle-fails', order), order, 'ok'));
    expect(res.status).toBe(402);
    expect(order).toEqual(['verify', 'settle']);
    expect(res.headers.get('payment-response')).toBe('ZmFpbA==');
    expect(await res.json()).toEqual({ error: 'settle failed' });
    expect(settleFirstStats.settledToday).toBe(0);
  });

  test('a settlement exception is a 402, not a free call', async () => {
    const order: string[] = [];
    const res = await post(appWith(fakeServer('settle-throws', order), order, 'ok'));
    expect(res.status).toBe(402);
    expect(order).toEqual(['verify', 'settle']);
  });

  test('payment-error (no/invalid payment) returns the 402 challenge with its headers', async () => {
    const order: string[] = [];
    const res = await post(appWith(fakeServer('payment-error', order), order, 'ok'));
    expect(res.status).toBe(402);
    expect(res.headers.get('payment-required')).toBe('abc');
    expect(order).toEqual(['verify']);
  });

  test('no-payment-required passes straight through', async () => {
    const order: string[] = [];
    const res = await post(appWith(fakeServer('no-payment', order), order, 'ok'));
    expect(res.status).toBe(200);
    expect(order).toEqual(['verify', 'handler']);
  });
});

describe('settle-first input check (before settlement)', () => {
  beforeEach(() => {
    settleFirstStats.settledToday = 0;
    settleFirstStats.rejectedToday = 0;
    settleFirstStats.lastRejected = null;
  });

  // Stands in for the entrypoint's Zod schema: `amountIn` must be a positive number.
  const validate = (_key: string, input: any) =>
    typeof input?.amountIn === 'number' && input.amountIn > 0
      ? null
      : [{ path: ['amountIn'], code: 'invalid_type', message: 'Expected positive number' }];

  function validatingApp(order: string[], seen: unknown[]) {
    const app = new Hono();
    app.use('/entrypoints/*', settleFirstMiddleware(fakeServer('verified', order), { validate }));
    app.post('/entrypoints/:key/invoke', async (c) => {
      order.push('handler');
      seen.push(await c.req.json());
      return c.json({ ok: true });
    });
    return app;
  }

  const send = (app: Hono, body: string) =>
    app.request('http://x/entrypoints/audace-intent-check/invoke', {
      method: 'POST',
      headers: { 'payment-signature': 'sig', 'content-type': 'application/json' },
      body,
    });

  test('invalid input returns 400 and never settles', async () => {
    const order: string[] = [];
    const res = await send(validatingApp(order, []), JSON.stringify({ amountIn: -1 }));
    expect(res.status).toBe(400);
    expect(order).toEqual(['verify']);
    expect(res.headers.get('payment-response')).toBeNull();
    const body = (await res.json()) as any;
    expect(body.error.code).toBe('invalid_input');
    expect(body.error.issues[0].path).toEqual(['amountIn']);
    expect(settleFirstStats.settledToday).toBe(0);
    expect(settleFirstStats.rejectedToday).toBe(1);
    expect(settleFirstStats.lastRejected).toEqual({ key: 'audace-intent-check', paths: ['amountIn'] });
  });

  test('valid input settles, and the handler still reads the full body', async () => {
    const order: string[] = [];
    const seen: unknown[] = [];
    const res = await send(validatingApp(order, seen), JSON.stringify({ amountIn: 5 }));
    expect(res.status).toBe(200);
    expect(order).toEqual(['verify', 'settle', 'handler']);
    expect(seen).toEqual([{ amountIn: 5 }]);
    expect(settleFirstStats.rejectedToday).toBe(0);
  });

  test('the { input: {...} } envelope is unwrapped like Lucid does', async () => {
    const order: string[] = [];
    const res = await send(validatingApp(order, []), JSON.stringify({ input: { amountIn: 5 } }));
    expect(res.status).toBe(200);
    expect(order).toEqual(['verify', 'settle', 'handler']);
  });

  test('unparseable JSON is validated as empty input and refused unpaid', async () => {
    const order: string[] = [];
    const res = await send(validatingApp(order, []), '{not json');
    expect(res.status).toBe(400);
    expect(order).toEqual(['verify']);
  });
});

describe('cache warmer', () => {
  const mk = (runs: string[], fail = false) => {
    let t = 1_000_000;
    const now = () => t;
    const w = new CacheWarmer({ now, log: () => {}, defaultDemandWindowSec: 7200, graceSec: 5 });
    w.register({ key: 'smart-money-flow', ttlSec: 600, run: async () => { runs.push('smf'); if (fail) throw new Error('upstream'); } });
    w.register({ key: 'smart-money-trenches', ttlSec: 120, run: async () => { runs.push('smt'); } });
    return { w, advance: (sec: number) => { t += sec * 1000; }, now };
  };

  test('nothing runs without demand; a call makes the entry due; re-runs only after TTL+grace', async () => {
    const runs: string[] = [];
    const { w, advance } = mk(runs);
    expect(await w.tick()).toEqual([]);
    w.note('smart-money-flow');
    expect(await w.tick()).toEqual(['smart-money-flow']);
    expect(runs).toEqual(['smf']);
    advance(600); // TTL exactly — not yet (grace 5s)
    expect(await w.tick()).toEqual([]);
    advance(6);
    expect(await w.tick()).toEqual(['smart-money-flow']);
    expect(runs).toEqual(['smf', 'smf']);
  });

  test('demand expires after the window; unknown keys are ignored', async () => {
    const runs: string[] = [];
    const { w, advance } = mk(runs);
    w.note('not-registered');
    w.note('smart-money-trenches');
    expect(await w.tick()).toEqual(['smart-money-trenches']);
    advance(7200 + 1);
    expect(await w.tick()).toEqual([]);
    expect(w.stats()['smart-money-trenches'].in_demand).toBe(false);
  });

  test('failures are counted, never thrown, and the entry is retried after TTL', async () => {
    const runs: string[] = [];
    const { w, advance } = mk(runs, true);
    w.note('smart-money-flow');
    await w.tick();
    const s = w.stats()['smart-money-flow'];
    expect(s.failures).toBe(1);
    expect(s.last_error).toBe('upstream');
    expect(s.warm).toBe(false);
    advance(606);
    expect(await w.tick()).toEqual(['smart-money-flow']);
    expect(w.stats()['smart-money-flow'].failures).toBe(2);
  });

  test('stats report warm within TTL after a good run', async () => {
    const runs: string[] = [];
    const { w, advance } = mk(runs);
    w.note('smart-money-trenches');
    await w.tick();
    expect(w.stats()['smart-money-trenches'].warm).toBe(true);
    advance(121);
    expect(w.stats()['smart-money-trenches'].warm).toBe(false);
  });
});
