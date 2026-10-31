// Blocks Lucid's A2A `/tasks` routes. They run any skill without payment and
// keep every task in an unbounded in-memory Map (closed in 1b04ee7).
//
// The first guard in src/index.ts compares the raw URL pathname, which keeps
// percent-encoding: `/%74asks` passed it, and Hono decoded it to `/tasks` and
// ran Lucid's handler (found 2026-10-31). `blockTaskRoutes` registers the block
// inside Hono, before Lucid mounts its routes, so it matches the same decoded
// path that Hono routes on. Keep both guards.
import type { Hono } from 'hono';

export function tasksBlockedResponse(): Response {
  return new Response(
    JSON.stringify({
      error: 'Payment Required',
      message:
        'A2A task execution is not available on SolEnrich. Every skill is a paid endpoint — call it directly and pay per request via x402.',
      how_to_call: 'POST /entrypoints/{key}/invoke with {"input": {...}}',
      discovery: { endpoints: '/entrypoints', docs: '/docs', mcp: '/mcp' },
    }),
    { status: 402, headers: { 'Content-Type': 'application/json' } },
  );
}

export function blockTaskRoutes(app: Hono): void {
  app.all('/tasks', () => tasksBlockedResponse());
  app.all('/tasks/*', () => tasksBlockedResponse());
}
