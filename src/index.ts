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
