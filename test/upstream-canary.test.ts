import { describe, expect, test } from 'bun:test';
import { UpstreamCanary, canaryReasons, NULL_CACHE } from '../src/lib/upstream-canary';

describe('upstream canary', () => {
  test('records ok, false, throw, and timeout as separate outcomes', async () => {
    const canary = new UpstreamCanary(
      [
        { name: 'good', run: async () => true },
        { name: 'bad_shape', run: async () => false },
        { name: 'throws', run: async () => { throw new Error('Helius HTTP 404: Not Found'); } },
        { name: 'slow', run: () => new Promise<boolean>((r) => setTimeout(() => r(true), 500)) },
      ],
      50,
    );
    const r = await canary.runOnce();
    expect(r.good.ok).toBe(true);
    expect(r.good.error).toBeNull();
    expect(r.bad_shape).toMatchObject({ ok: false, error: 'unexpected response shape' });
    expect(r.throws).toMatchObject({ ok: false, error: 'Helius HTTP 404: Not Found' });
    expect(r.slow.ok).toBe(false);
    expect(r.slow.error).toContain('timeout');
  });

  test('one failing probe does not block the others', async () => {
    const canary = new UpstreamCanary([
      { name: 'a', run: async () => { throw new Error('down'); } },
      { name: 'b', run: async () => true },
    ]);
    const r = await canary.runOnce();
    expect(r.a.ok).toBe(false);
    expect(r.b.ok).toBe(true);
  });

  test('reasons list only the failing upstreams', () => {
    const reasons = canaryReasons({
      helius_enhanced_tx: { ok: false, checked_at: '2026-10-14T00:00:00.000Z', ms: 120, error: 'Helius HTTP 404: Not Found' },
      jupiter_tokens: { ok: true, checked_at: '2026-10-14T00:00:00.000Z', ms: 90, error: null },
    });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('helius_enhanced_tx');
    expect(reasons[0]).toContain('404');
  });

  test('no results yet means no reasons', () => {
    expect(canaryReasons({})).toEqual([]);
  });

  test('the null cache never returns a stored value', async () => {
    await NULL_CACHE.set('k', 'v', 60);
    expect(await NULL_CACHE.get('k')).toBeNull();
  });
});
