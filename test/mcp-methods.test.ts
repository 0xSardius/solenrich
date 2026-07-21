// Regression guard for the 2026-07-21 OOM fix (docs/oom-rootcause-2026-07-21.md).
// The stateless /mcp endpoint must reject GET/DELETE with 405 so the MCP SDK never
// opens a standalone SSE ReadableStream that leaks a full server graph per probe.
import { describe, test, expect } from 'bun:test';
import { app } from '../src/lib/agent';

const req = (method: string) =>
  app.fetch(new Request('http://localhost/mcp', {
    method,
    headers: { Accept: 'text/event-stream, application/json' },
  }));

describe('/mcp method gating (OOM guard)', () => {
  test('GET /mcp → 405 (no SSE stream opened)', async () => {
    const res = await req('GET');
    expect(res.status).toBe(405);
  });

  test('DELETE /mcp → 405', async () => {
    const res = await req('DELETE');
    expect(res.status).toBe(405);
  });

  test('POST /mcp initialize → 200 buffered JSON (not text/event-stream)', async () => {
    const res = await app.fetch(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } },
      }),
    }));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('application/json');
    const body = await res.json();
    expect(body.result?.serverInfo?.name).toBe('SolEnrich');
  });
});
