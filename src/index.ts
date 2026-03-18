import { app } from './lib/agent';
import { PRICING } from './config';

const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
const PAY_TO = process.env.AGENT_WALLET_ADDRESS ?? '';
const FACILITATOR = process.env.FACILITATOR_URL ?? 'https://facilitator.payai.network';

console.log(`Starting agent server on port ${port}...`);

// Wrap app.fetch to enrich 402 responses with pricing info
const originalFetch = app.fetch.bind(app);

async function enrichedFetch(request: Request, ...args: any[]): Promise<Response> {
  const res = await (originalFetch as any)(request, ...args);
  if (res.status !== 402) return res;

  const url = new URL(request.url);
  if (!url.pathname.startsWith('/entrypoints/')) return res;

  const entrypointKey = url.pathname.split('/entrypoints/')[1]?.split('/')[0] ?? '';
  const price = PRICING[entrypointKey as keyof typeof PRICING] ?? null;

  let originalBody: Record<string, unknown> = {};
  try {
    originalBody = await res.clone().json();
  } catch {}

  const enrichedBody = {
    ...originalBody,
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

  // Preserve x402 protocol headers
  const headers = new Headers(res.headers);
  headers.set('Content-Type', 'application/json');
  headers.delete('Content-Length');

  return new Response(JSON.stringify(enrichedBody), {
    status: 402,
    headers,
  });
}

export default {
  port,
  hostname: '0.0.0.0',
  fetch: enrichedFetch,
};
