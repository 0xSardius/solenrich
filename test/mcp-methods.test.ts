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
    expect(body.result?.protocolVersion).toBe('2025-03-26'); // echoes supported client version
  });
});

// Dispatcher contract (2026-08-02 zero-allocation rewrite, src/lib/mcp-http.ts).
const post = (body: unknown) =>
  app.fetch(new Request('http://localhost/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  }));

describe('/mcp JSON-RPC dispatcher', () => {
  test('tools/list returns all registry tools with JSON Schema inputs', async () => {
    const res = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(res.status).toBe(200);
    const body = await res.json();
    const tools = body.result?.tools;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBeGreaterThanOrEqual(30);
    const enrichWallet = tools.find((t: any) => t.name === 'enrich_wallet');
    expect(enrichWallet?.description).toContain('wallet');
    expect(enrichWallet?.inputSchema?.type).toBe('object');
    expect(enrichWallet?.inputSchema?.required).toEqual(['address']);
  });

  test('tools/call with invalid arguments → -32602', async () => {
    const res = await post({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'enrich_wallet', arguments: { depth: 'light' } }, // missing address
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error?.code).toBe(-32602);
  });

  test('tools/call on unknown tool → -32602', async () => {
    const res = await post({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'nope', arguments: {} },
    });
    const body = await res.json();
    expect(body.error?.code).toBe(-32602);
  });

  test('unknown method → -32601', async () => {
    const res = await post({ jsonrpc: '2.0', id: 5, method: 'resources/list' });
    const body = await res.json();
    expect(body.error?.code).toBe(-32601);
  });

  test('notification (no id) → 202 with no body', async () => {
    const res = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(res.status).toBe(202);
    expect(await res.text()).toBe('');
  });

  test('ping → empty result', async () => {
    const res = await post({ jsonrpc: '2.0', id: 6, method: 'ping' });
    const body = await res.json();
    expect(body.result).toEqual({});
  });

  test('malformed JSON body → 400 parse error', async () => {
    const res = await app.fetch(new Request('http://localhost/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error?.code).toBe(-32700);
  });
});
