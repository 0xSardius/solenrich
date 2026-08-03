/**
 * Stateless MCP-over-HTTP dispatcher.
 *
 * Replaces the SDK's per-request McpServer + StreamableHTTPServerTransport pair
 * (2026-08-02). Even with correct teardown (the 2026-07-21 fix), building a
 * 32-tool McpServer graph per POST retained ~1.5-2MB per request under Bun —
 * MCP directory crawlers (~1K POSTs/day) walked Railway RSS to the 8GB cap
 * every ~3 days. Everything here is computed once at module load; a request
 * allocates only its own parsed body and response object.
 *
 * Speaks the subset of MCP that a stateless tools-only server needs:
 * initialize, ping, tools/list, tools/call, notifications. No sessions, no SSE,
 * no server push — same surface the previous stateless config exposed.
 */

import { z } from 'zod';
import { MCP_TOOLS } from '../mcp-tools';

const SERVER_INFO = { name: 'SolEnrich', version: '1.0.0' };
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_PROTOCOL_VERSION = '2025-06-18';

// Built once: validation schema + JSON Schema per tool.
const TOOLS = new Map(
  MCP_TOOLS.map((def) => [def.name, { def, schema: z.object(def.inputSchema) }]),
);

const TOOLS_LIST_RESULT = {
  tools: MCP_TOOLS.map((def) => ({
    name: def.name,
    title: def.title,
    description: def.description,
    inputSchema: z.toJSONSchema(z.object(def.inputSchema), { io: 'input' }),
  })),
};

type JsonRpcId = string | number;

function rpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: '2.0' as const, id, result };
}

function rpcError(id: JsonRpcId | null, code: number, message: string) {
  return { jsonrpc: '2.0' as const, id, error: { code, message } };
}

export const MCP_PARSE_ERROR = rpcError(null, -32700, 'Parse error: body is not valid JSON');

async function dispatchSingle(msg: unknown): Promise<object | null> {
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
    return rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC message object');
  }
  const { id, method, params } = msg as { id?: unknown; method?: unknown; params?: any };

  // Notifications (no id) get no response — the route layer turns null into 202.
  if (id === undefined || id === null) return null;
  if (typeof id !== 'string' && typeof id !== 'number') {
    return rpcError(null, -32600, 'Invalid Request: id must be a string or number');
  }
  if (typeof method !== 'string') {
    return rpcError(id, -32600, 'Invalid Request: method must be a string');
  }

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      return rpcResult(id, {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    }

    case 'ping':
      return rpcResult(id, {});

    case 'tools/list':
      return rpcResult(id, TOOLS_LIST_RESULT);

    case 'tools/call': {
      const name = params?.name;
      const tool = typeof name === 'string' ? TOOLS.get(name) : undefined;
      if (!tool) {
        return rpcError(id, -32602, `Unknown tool: ${String(name)}`);
      }
      const parsed = tool.schema.safeParse(params?.arguments ?? {});
      if (!parsed.success) {
        return rpcError(id, -32602, `Invalid arguments for ${name}: ${parsed.error.message}`);
      }
      try {
        const text = await tool.def.handler(parsed.data);
        return rpcResult(id, { content: [{ type: 'text', text }] });
      } catch (err) {
        // Tool execution failures are results with isError, not protocol errors
        // (MCP spec) — matches the SDK's behavior for thrown handler errors.
        return rpcResult(id, {
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        });
      }
    }

    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/**
 * Dispatch a parsed JSON-RPC body (single message or batch).
 * Returns null when there is nothing to respond with (notification-only input)
 * — the caller should reply 202 Accepted with no body.
 */
export async function dispatchMcpRequest(body: unknown): Promise<object | object[] | null> {
  if (Array.isArray(body)) {
    if (body.length === 0) {
      return rpcError(null, -32600, 'Invalid Request: empty batch');
    }
    const responses = (await Promise.all(body.map(dispatchSingle))).filter(
      (r): r is object => r !== null,
    );
    return responses.length > 0 ? responses : null;
  }
  return dispatchSingle(body);
}
