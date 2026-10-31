// Unit tests for the /tasks block (src/lib/tasks-guard.ts). The fake Lucid
// routes are registered AFTER the block, as createAgentApp's beforeMount does.
import { describe, test, expect } from 'bun:test';
import { Hono } from 'hono';
import { blockTaskRoutes } from '../src/lib/tasks-guard';

function appWithFakeLucid(): Hono {
  const app = new Hono();
  blockTaskRoutes(app);
  app.get('/tasks', (c) => c.json({ tasks: [] }));
  app.post('/tasks', (c) => c.json({ taskId: 't1' }));
  app.get('/tasks/:id', (c) => c.json({ id: c.req.param('id') }));
  app.post('/tasks/:id/cancel', (c) => c.json({ cancelled: true }));
  app.get('/health', (c) => c.text('ok'));
  return app;
}

describe('blockTaskRoutes', () => {
  const app = appWithFakeLucid();
  const cases: Array<[string, string]> = [
    ['GET', '/tasks'],
    ['POST', '/tasks'],
    ['GET', '/tasks/abc'],
    ['POST', '/tasks/abc/cancel'],
    ['GET', '/%74asks'],
    ['POST', '/%74asks'],
    ['POST', '/%74%61%73%6b%73'],
    ['GET', '/%74asks/abc'],
  ];

  for (const [method, path] of cases) {
    test(`${method} ${path} → 402`, async () => {
      const res = await app.fetch(new Request(`http://x${path}`, { method, body: method === 'POST' ? '{}' : undefined }));
      expect(res.status).toBe(402);
    });
  }

  test('other routes are untouched', async () => {
    const res = await app.fetch(new Request('http://x/health'));
    expect(res.status).toBe(200);
  });
});
