/**
 * API root (B2, 2026-09-20). Intercepted at the Bun fetch level in src/index.ts
 * because the Lucid SDK registers `GET /` inside createAgentApp (its generated
 * entrypoint page, or a 404 when disabled), ahead of any route we can add.
 *
 * Browsers and crawlers (Accept leads with text/html) → 301 to the marketing
 * site, so the brand query has one indexable home. Agents (curl, fetch, SDKs:
 * Accept is `*​/*` or application/json) → a small JSON index of the discovery
 * surfaces. Same content negotiation /docs uses.
 */
export const WWW = 'https://www.solenrich.com/';
export const API = 'https://api.solenrich.com';

export const ROOT_INDEX = {
  name: 'SolEnrich',
  description: 'Onchain intelligence API for Solana agents. Pay per call with USDC (x402, Solana or Base) or by card (MPP/Stripe). No API keys.',
  site: WWW,
  discovery: {
    docs: `${API}/docs`,
    llms_txt: `${API}/llms.txt`,
    llms_full_txt: `${API}/llms-full.txt`,
    openapi: `${API}/openapi.json`,
    x402: `${API}/.well-known/x402`,
    agent_card: `${API}/.well-known/agent.json`,
    mcp: `${API}/mcp`,
    status: `${API}/status`,
  },
  how_to_call: 'POST /entrypoints/{key}/invoke with a JSON body; a 402 response lists price, networks, and every endpoint.',
};

export function wantsHtml(accept: string | null): boolean {
  const a = (accept ?? '').toLowerCase();
  return a.startsWith('text/html') && !a.includes('application/json');
}

/** Returns a Response for `GET /` (or HEAD), null for any other path. */
export function rootResponse(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.pathname !== '/') return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  if (wantsHtml(request.headers.get('accept'))) {
    return new Response(null, { status: 301, headers: { Location: WWW, 'Cache-Control': 'public, max-age=3600' } });
  }
  return new Response(JSON.stringify(ROOT_INDEX, null, 2), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
  });
}

/**
 * robots.txt for the API host. Allow-list the discovery files; keep crawlers
 * off paid routes, the demo, MCP, and the A2A path. Everything a person should
 * read is on www, which has its own robots and the sitemap.
 */
export const API_ROBOTS_TXT = `User-agent: *
Allow: /docs
Allow: /llms.txt
Allow: /llms-full.txt
Allow: /openapi.json
Allow: /.well-known/
Allow: /status
Allow: /health
Disallow: /entrypoints/
Disallow: /demo/
Disallow: /mcp
Disallow: /tasks
Disallow: /metrics
Disallow: /

Sitemap: https://www.solenrich.com/sitemap.xml
`;
