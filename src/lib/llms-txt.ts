/**
 * llms.txt (llmstxt.org): the short, crawler- and LLM-readable index.
 * Reordered 2026-09-20 (B3): lead names the suites that sell, endpoints are
 * grouped by suite with the stonk suite first, and a "start here" block gives
 * the two trade loops with total prices. Pure; built once at boot.
 */
import type { EndpointSuite } from './suites';

export interface LlmsTxtInput {
  pricing: Record<string, string>;
  free: readonly string[];
  meta: Record<string, { summary: string; description: string }>;
  suites: EndpointSuite[];
  baseAccepts: boolean;
}

const BASE = 'https://api.solenrich.com';

export function buildLlmsTxt(i: LlmsTxtInput): string {
  const paid = Object.keys(i.pricing).length;
  const price = (k: string) => (i.pricing[k] != null ? `$${i.pricing[k]} USDC` : 'free');
  const sum = (keys: string[]) => keys.reduce((s, k) => s + Number(i.pricing[k] ?? 0), 0);
  const money = (n: number) => `$${n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`;
  const line = (k: string) => `- [${k}](${BASE}/entrypoints/${k}/invoke) — ${i.meta[k]?.description ?? i.meta[k]?.summary ?? k} (${price(k)})`;

  const stonkLoop = ['stonk-gems', 'stonk-quote', 'exit-signal'];
  const trenchLoop = ['runner-scan', 'trenches-check', 'due-diligence', 'exit-signal'];

  const suites = i.suites.map((s) => [`## ${s.title}`, '', s.blurb, '', ...s.keys.map(line), ''].join('\n')).join('\n');

  return `# SolEnrich

> Onchain intelligence for Solana agents: verdicts, not raw data. ${paid} paid endpoints and ${i.free.length} free, pay per call with USDC over x402 (Solana${i.baseAccepts ? ' or Base' : ''}) or by card via MPP/Stripe, no API key. Suites: StonkFun reward-coin intelligence (gem finder, payout status, yield, trade cost, launch intel), the memecoin trenches lifecycle (runner-scan → trenches-check → exit-signal), smart-money and whale tracking on Solana and Hyperliquid, cross-venue perps (Jupiter, Adrena, Flash, Hyperliquid, dYdX), and the core wallet, token, and transaction primitives. Every score is deterministic — no LLM runs inside SolEnrich, so a briefing costs the same as JSON and never hallucinates.

- Base URL: ${BASE}
- Call: POST /entrypoints/{key}/invoke with a JSON body; \`format\`: json (default) | llm (briefing) | both
- Payment: x402 (USDC on Solana${i.baseAccepts ? ' or Base' : ''}) or MPP/Stripe (fiat cards). A 402 lists price, networks, and every endpoint.
- Discovery: GET /.well-known/x402, GET /openapi.json, GET /docs, GET /llms-full.txt (every input + methodology), GET /status (live health)
- MCP: ${BASE}/mcp
- Provider: @0xSardius (https://x.com/0xSardius)

## Start here

- **StonkFun trade, ${money(sum(stonkLoop))} end to end:** \`stonk-pairs\` (free, the quote catalog) → \`stonk-gems\` (${price('stonk-gems')}, ranked GEM/WATCH/NOISE) → \`stonk-quote\` (${price('stonk-quote')}, cost and payback at your size) → \`exit-signal\` (${price('exit-signal')}) while holding.
- **Fresh memecoin, ${money(sum(trenchLoop))} to enter and ${price('exit-signal')} per exit check:** \`runner-scan\` (${price('runner-scan')}) → \`trenches-check\` on one mint (${price('trenches-check')}) → \`due-diligence\` (${price('due-diligence')}) → \`exit-signal\` (${price('exit-signal')}).
- **Best perps venue at my size:** \`perps-venue-comparison\` (${price('perps-venue-comparison')}).
- **A question in plain English:** \`query\` (${price('query')}) routes it to the right enrichers.

Every response carries \`next_steps\` naming the next call and \`caveats\` naming any leg that degraded.

${suites}
## Networks

- Solana Mainnet (CAIP-2: solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp)
- USDC: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v${i.baseAccepts ? `
- Base Mainnet (CAIP-2: eip155:8453) — same USDC price per call, payer picks the network
- USDC (Base): 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` : ''}

## Integration

First call returns 402 with payment requirements; second call includes the signed payment and receives the data. Clients: \`@x402/fetch\` with \`@x402/svm\` (Solana) or \`@x402/evm\` (Base), or the Solana Foundation \`pay\` CLI (\`pay curl ...\`). Results are cached 30 seconds to 10 minutes by data type; re-polling inside the window pays for the same answer.

## Settlement History

- x402scan: https://www.x402scan.com/server/d9814c54-6fa6-4fa7-8b01-43a0ffbc7641 — lifetime on-chain settlement history.
`;
}
