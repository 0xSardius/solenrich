import { app } from './lib/agent';
import { PRICING } from './config';

const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const PAY_TO = process.env.AGENT_WALLET_ADDRESS ?? '';
const FACILITATOR = process.env.FACILITATOR_URL ?? 'https://facilitator.payai.network';

console.log(`Starting agent server on port ${port}...`);

function build402Body(url: URL) {
  const entrypointKey = url.pathname.split('/entrypoints/')[1]?.split('/')[0] ?? '';
  const price = PRICING[entrypointKey as keyof typeof PRICING] ?? null;

  return {
    error: 'Payment Required',
    message: 'This endpoint requires a USDC micropayment via x402 protocol.',
    endpoint: entrypointKey || undefined,
    pricing: {
      amount: price,
      currency: 'USDC',
      network: 'solana',
      payTo: PAY_TO,
    },
    how_to_pay: {
      protocol: 'x402',
      header: 'X-Payment',
      facilitator: FACILITATOR,
      docs: 'https://www.x402.org/',
    },
    all_endpoints: Object.fromEntries(
      Object.entries(PRICING)
        .filter(([k]) => k !== 'query')
        .map(([k, v]) => [k, `$${v} USDC`]),
    ),
  };
}

export default {
  port,
  hostname: '0.0.0.0',
  // Largest legitimate request body is a batch-enrich list (~5KB); default 128MB
  // let scanners buffer gigabytes (2x with the metrics clone). OOM hardening 2026-07-16.
  maxRequestBodySize: 1_048_576,
  // Bun default is 10s, which reaped slow cold-cache queries (due-diligence, batch).
  // 60s gives them room while still bounding hung/held-open connections.
  idleTimeout: 60,
  async fetch(request: Request, server: any): Promise<Response> {
    // --- A2A /tasks guard (2026-08-09) ---
    // Lucid's built-in /tasks route dispatches ANY registered skill by `skillId`
    // with no payment challenge — verified in prod: it returned a full
    // enrich-token-light payload for free, i.e. every paid endpoint was
    // reachable unpaid by anyone who found the route. It also files each task
    // into an in-memory Map that is written in five places and never deleted
    // from, so it doubles as an unbounded memory vector.
    // We never advertise A2A tasks (not in the agent card, README, or /docs);
    // all documented access is /entrypoints/{key}/invoke or /mcp. Answer with a
    // 402 that points at the paid route rather than a bare 404, so a genuine
    // A2A caller learns where to go. Intercepted here because Lucid registers
    // /tasks inside createAgentApp, ahead of any middleware we could add.
    const path = new URL(request.url).pathname;
    if (path === '/tasks' || path.startsWith('/tasks/')) {
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

    const res = await app.fetch(request, { IP: server?.requestIP?.(request) });
    if (res.status !== 402) return res;

    const url = new URL(request.url);
    if (!url.pathname.startsWith('/entrypoints/')) return res;

    // Read the body directly instead of cloning. `clone()` tees the stream, and
    // on Bun 1.3.14 the un-read branch is retained forever (~260KB/request — see
    // the note in lib/agent.ts). We always return a freshly built Response here,
    // so the original body is never needed again: consume it once, no tee.
    let originalBody: Record<string, unknown> = {};
    try {
      originalBody = JSON.parse(await res.text());
    } catch {}

    // Our custom fields first, middleware details override — so verify failures
    // (like "transaction_simulation_failed") propagate to clients instead of being
    // masked by the generic "Payment Required" message.
    const enrichedBody = { ...build402Body(url), ...originalBody };

    // Preserve x402 protocol headers
    const headers = new Headers(res.headers);
    headers.set('Content-Type', 'application/json');
    headers.delete('Content-Length');

    return new Response(JSON.stringify(enrichedBody), { status: 402, headers });
  },
};
