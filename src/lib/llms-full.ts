/**
 * llms-full.txt (B2, 2026-09-20). The long form of llms.txt per llmstxt.org:
 * everything an LLM needs to call SolEnrich without fetching anything else —
 * every endpoint with its inputs (types, required, defaults), the scoring
 * methodology and data sources from /docs, payment and networks.
 *
 * Pure: takes the same objects the API serves, returns markdown. Built once at
 * boot in agent.ts; served on api.solenrich.com and rewritten on www.
 */
export interface LlmsFullInput {
  pricing: Record<string, string>;
  free: readonly string[];
  meta: Record<string, { summary: string; description: string; schema: Record<string, unknown> }>;
  /** The /docs object; `methodology` and `data_sources` are rendered if present. */
  docs: Record<string, unknown>;
  baseAccepts: boolean;
}

type JsonSchema = {
  type?: string;
  required?: string[];
  properties?: Record<string, JsonSchemaProp>;
};
type JsonSchemaProp = {
  type?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  items?: { type?: string };
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};

function inputLines(schema: JsonSchema): string[] {
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const keys = Object.keys(props);
  if (keys.length === 0) return ['- No inputs. Send `{}` (optional `format`: json | llm | both).'];
  return keys.map((k) => {
    const p = props[k];
    const type = p.type === 'array' ? `${p.items?.type ?? 'any'}[]` : (p.type ?? 'any');
    const bits: string[] = [];
    if (required.has(k)) bits.push('required');
    if (p.default !== undefined) bits.push(`default ${JSON.stringify(p.default)}`);
    if (p.enum) bits.push(`one of ${p.enum.map((e) => JSON.stringify(e)).join(', ')}`);
    if (p.minimum !== undefined || p.maximum !== undefined) bits.push(`range ${p.minimum ?? '…'}–${p.maximum ?? '…'}`);
    if (p.minItems !== undefined || p.maxItems !== undefined) bits.push(`${p.minItems ?? 1}–${p.maxItems ?? '…'} items`);
    const tail = bits.length ? ` (${bits.join(', ')})` : '';
    return `- \`${k}\` ${type}${tail}${p.description ? ` — ${p.description}` : ''}`;
  });
}

/** Render a nested plain object as markdown bullets. Strings are text; arrays are lists. */
function renderTree(value: unknown, depth = 0): string[] {
  const pad = '  '.repeat(depth);
  if (value == null) return [];
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return [`${pad}- ${String(value)}`];
  if (Array.isArray(value)) return value.flatMap((v) => (typeof v === 'object' && v !== null ? renderTree(v, depth) : [`${pad}- ${String(v)}`]));
  const out: string[] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out.push(`${pad}- **${k}**: ${String(v)}`);
    else {
      out.push(`${pad}- **${k}**`);
      out.push(...renderTree(v, depth + 1));
    }
  }
  return out;
}

export function buildLlmsFull(i: LlmsFullInput): string {
  const paid = Object.keys(i.pricing);
  const base = 'https://api.solenrich.com';
  const endpoint = (key: string, price: string | null) => {
    const m = i.meta[key];
    const lines = [
      `### ${key} — ${price ? `$${price} USDC` : 'free'}`,
      '',
      `POST ${base}/entrypoints/${key}/invoke`,
      '',
      m?.summary ?? key,
      '',
      m?.description ?? '',
      '',
      'Inputs:',
      ...inputLines((m?.schema ?? {}) as JsonSchema),
      '',
    ];
    return lines.join('\n');
  };

  const sections = [
    `# SolEnrich — full reference for LLMs`,
    '',
    `> Onchain intelligence API for Solana agents and LLMs. ${paid.length} paid endpoints and ${i.free.length} free. Pay per call with USDC over x402 on Solana${i.baseAccepts ? ' or Base' : ''}, or by card via MPP/Stripe. No API key. Every verdict is deterministic: no LLM runs inside SolEnrich, so a briefing costs the same as JSON and never hallucinates.`,
    '',
    '## How to call',
    '',
    `- Every endpoint is \`POST ${base}/entrypoints/{key}/invoke\` with a JSON body. A flat body works (\`{"mint": "...", "format": "llm"}\`); so does \`{"input": {...}}\`.`,
    '- `format`: `json` (default, typed fields), `llm` (a short deterministic briefing), or `both`.',
    '- Without payment the response is HTTP 402 with `pricing`, `how_to_pay`, and `all_endpoints` (every key with its price). Pay with an x402 client (`@x402/fetch` + `@x402/svm` for Solana, `@x402/evm` for Base) or the Solana Foundation `pay` CLI (`pay curl ...`).',
    `- Free without a wallet: \`GET /docs\`, \`GET /llms.txt\`, \`GET /openapi.json\`, \`GET /.well-known/x402\`, \`GET /status\`, \`POST /demo/enrich\` (10 per hour), and \`POST /entrypoints/stonk-pairs/invoke\`.`,
    '- Results are cached server-side from 30 seconds to 10 minutes by data type. Re-polling inside the window pays for the same answer.',
    '- Every response carries `caveats` (which legs degraded) and `next_steps` (the next call to make). Never drop the caveats.',
    '',
    '## Networks',
    '',
    '- Solana mainnet (CAIP-2 `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`), USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`',
    ...(i.baseAccepts ? ['- Base mainnet (CAIP-2 `eip155:8453`), USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` — same price per call, the payer picks the network'] : []),
    '',
    '## Endpoints',
    '',
    ...paid.map((k) => endpoint(k, i.pricing[k])),
    '## Free endpoints',
    '',
    ...i.free.map((k) => endpoint(k, null)),
  ];

  if (i.docs.methodology) {
    sections.push('## Scoring methodology', '', ...renderTree(i.docs.methodology), '');
  }
  if (i.docs.data_sources) {
    sections.push('## Data sources', '', ...renderTree(i.docs.data_sources), '');
  }
  sections.push(
    '## Links',
    '',
    `- Site: https://www.solenrich.com`,
    `- Short index: ${base}/llms.txt`,
    `- OpenAPI: ${base}/openapi.json`,
    `- x402 discovery: ${base}/.well-known/x402`,
    `- MCP: ${base}/mcp`,
    `- Live status: ${base}/status`,
    `- Provider: @0xSardius (https://x.com/0xSardius)`,
    '',
  );
  return sections.join('\n');
}
