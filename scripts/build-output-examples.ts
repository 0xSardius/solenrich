// Build src/lib/output-examples.json: one trimmed, real response per paid endpoint, sent as the bazaar
// `output.example` in every 402 (agent.ts routeConfig). Source: data/endpoint-examples/{key}.json (captured real
// responses). Until 2026-09-25 every endpoint sent the same placeholder
// ({"output":{"briefing":"string (llm format) or object (json format)"}}).
//
// The example rides inside the base64 `payment-required` header (2.6–5 KB today; many clients cap headers near
// 8 KB), so each example is cut to MAX_CHARS: arrays keep their first element, strings are shortened, nesting is
// capped, llm_summary is dropped, then keys per object shrink until it fits. Shape over completeness.
//
// Run: bun run scripts/build-output-examples.ts
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { PRICING } from '../src/config';

export const MAX_CHARS = 1000;
const DROP_KEYS = new Set(['llm_summary', 'content_type']);

function trim(v: unknown, depth: number, maxKeys: number, maxDepth: number): unknown {
  if (typeof v === 'string') return v.length > 80 ? v.slice(0, 77) + '...' : v;
  if (typeof v === 'number') return Number.isInteger(v) ? v : Number(v.toPrecision(5));
  if (Array.isArray(v)) {
    if (!v.length) return [];
    if (depth >= maxDepth) return ['…'];
    const scalars = v.every((x) => x === null || typeof x !== 'object');
    return scalars ? v.slice(0, 3).map((x) => trim(x, depth + 1, maxKeys, maxDepth)) : [trim(v[0], depth + 1, maxKeys, maxDepth)];
  }
  if (v && typeof v === 'object') {
    if (depth >= maxDepth) return '{…}';
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v).filter(([k]) => !DROP_KEYS.has(k)).slice(0, maxKeys)) out[k] = trim(x, depth + 1, maxKeys, maxDepth);
    return out;
  }
  return v;
}

export function trimExample(output: unknown): unknown {
  for (let maxDepth = 4; maxDepth >= 2; maxDepth--) {
    for (let maxKeys = 14; maxKeys >= 4; maxKeys--) {
      const t = trim(output, 0, maxKeys, maxDepth);
      if (JSON.stringify(t).length <= MAX_CHARS) return t;
    }
  }
  return trim(output, 0, 4, 1);
}

if (import.meta.main) {
  const dir = 'data/endpoint-examples';
  const out: Record<string, unknown> = {};
  const missing: string[] = [];
  const files = new Set(readdirSync(dir).map((f) => f.replace(/\.json$/, '')));
  for (const key of Object.keys(PRICING)) {
    if (!files.has(key)) { missing.push(key); continue; }
    const cap = JSON.parse(readFileSync(`${dir}/${key}.json`, 'utf8'));
    out[key] = trimExample(cap.output);
  }
  writeFileSync('src/lib/output-examples.json', JSON.stringify(out, null, 1) + '\n');
  const sizes = Object.entries(out).map(([k, v]) => [k, JSON.stringify(v).length] as const).sort((a, b) => b[1] - a[1]);
  console.log(`wrote ${Object.keys(out).length} examples; largest ${sizes.slice(0, 3).map(([k, n]) => `${k}=${n}`).join(', ')}; missing: ${missing.join(', ') || 'none'}`);
}
