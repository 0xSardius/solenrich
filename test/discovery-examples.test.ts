/**
 * Discovery metadata guard (2026-09-25). The bazaar input/output examples and the parameter schema are what agents
 * see on the CDP bazaar and agentic.market before they pay. agentic.market builds its parameter list only from the
 * input example keys, and every endpoint used to send the same placeholder output. These tests keep every paid
 * endpoint's example real, valid against its schema, and small enough for the base64 `payment-required` header.
 */
import { describe, test, expect } from 'bun:test';
import { PRICING } from '../src/config';
import { ENDPOINT_META } from '../src/openapi';
import { INPUT_EXAMPLES } from '../src/lib/input-examples';
import OUTPUT_EXAMPLES from '../src/lib/output-examples.json';
import { describeSchema, rankTags, PARAM_DESCRIPTIONS, MAX_TAGS } from '../src/lib/discovery-meta';

const KEYS = Object.keys(PRICING);
const OUT = OUTPUT_EXAMPLES as Record<string, unknown>;
const MAX_OUTPUT_CHARS = 1000;
// Many HTTP clients and proxies cap a single header near 8 KB. Estimate the payment-required header: base64 (×4/3)
// of the input + output examples + schema, plus ~1.5 KB for accepts, resource, description, tags.
const HEADER_BUDGET_BYTES = 8000;

describe('bazaar input examples', () => {
  test('every paid endpoint has one', () => {
    expect(KEYS.filter((k) => !INPUT_EXAMPLES[k])).toEqual([]);
  });

  for (const key of KEYS) {
    test(`${key}: keys exist in the schema, required fields present`, () => {
      const schema = (ENDPOINT_META as any)[key]?.schema;
      expect(schema).toBeDefined();
      const ex = INPUT_EXAMPLES[key];
      const props = Object.keys(schema.properties ?? {});
      expect(Object.keys(ex).filter((k) => !props.includes(k))).toEqual([]);
      expect((schema.required ?? []).filter((r: string) => !(r in ex))).toEqual([]);
      for (const [name, value] of Object.entries(ex)) {
        const allowed = schema.properties[name]?.enum;
        if (allowed) expect(allowed).toContain(value);
      }
    });
  }
});

describe('bazaar output examples', () => {
  test('every paid endpoint has a real one (not the old placeholder)', () => {
    expect(KEYS.filter((k) => OUT[k] == null)).toEqual([]);
    expect(KEYS.filter((k) => JSON.stringify(OUT[k]).includes('string (llm format) or object'))).toEqual([]);
  });

  test(`each is at most ${MAX_OUTPUT_CHARS} characters`, () => {
    expect(KEYS.filter((k) => JSON.stringify(OUT[k]).length > MAX_OUTPUT_CHARS)).toEqual([]);
  });

  test(`estimated payment-required header stays under ${HEADER_BUDGET_BYTES} bytes`, () => {
    const over = KEYS.map((k) => {
      const raw = JSON.stringify(INPUT_EXAMPLES[k]).length + JSON.stringify(OUT[k]).length + JSON.stringify(describeSchema((ENDPOINT_META as any)[k].schema)).length + 1500;
      return [k, Math.round((raw * 4) / 3)] as const;
    }).filter(([, bytes]) => bytes > HEADER_BUDGET_BYTES);
    expect(over).toEqual([]);
  });
});

describe('discovery-meta helpers', () => {
  test('describeSchema fills missing descriptions and never overwrites', () => {
    const s = describeSchema({ type: 'object', properties: { format: { type: 'string' }, mint: { type: 'string', description: 'mine' }, oddball: { type: 'string' } } });
    expect(s.properties!.format.description).toBe(PARAM_DESCRIPTIONS.format);
    expect(s.properties!.mint.description).toBe('mine');
    expect(s.properties!.oddball.description).toBeUndefined();
  });

  test('rankTags puts specific tags first and keeps at most 5', () => {
    expect(rankTags(['solana', 'stonkfun', 'ai-agents', 'holder-yield', 'onchain', 'x', 'y'])).toEqual(['stonkfun', 'holder-yield', 'x', 'y', 'solana']);
    expect(rankTags(['solana', 'solana', 'wallet-risk']).length).toBeLessThanOrEqual(MAX_TAGS);
  });
});
