/**
 * Copy-count guard (B1, 2026-09-20). Every "<N> endpoints" / "<N> tools" claim
 * on the public surfaces must equal the real counts in code. Google showed
 * "38 endpoints" for two months after the count reached 45 because nothing
 * checked the copy.
 *
 * Checked: landing/index.html, landing/docs.html, README.md, mcp/README.md.
 * Phrasings caught: a number followed within a few words by "endpoint(s)",
 * "tool(s)", or "pay-per-call". A count phrased another way slips past.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { PRICING, FREE_ENDPOINTS } from '../src/config';
import { MCP_TOOLS } from '../src/mcp-tools';

const PAID = Object.keys(PRICING).length;
const FREE = FREE_ENDPOINTS.length;
const TOTAL = PAID + FREE;
const TOOLS = MCP_TOOLS.length;

// mcp/README.md states no counts, so it is not listed; add it if it ever does.
const FILES = ['landing/index.html', 'landing/docs.html', 'README.md'];

// "45 endpoints", "45 paid endpoints", "45 onchain intelligence endpoints", "46 endpoints (45 paid + 1 free)",
// "44 tools", "44 MCP tools", "38 pay-per-call endpoints". Up to three words between the number and the noun.
// "55 endpoint tests" is a test count, not an endpoint count — excluded by the lookahead.
const CLAIM = /\b(\d{2})\b(?:\s+[A-Za-z-]+){0,3}\s+(endpoints?|tools?)\b(?!\s+tests?\b)/g;

function claims(file: string): Array<{ n: number; noun: string; line: number; text: string }> {
  const out: Array<{ n: number; noun: string; line: number; text: string }> = [];
  const lines = readFileSync(file, 'utf8').split('\n');
  lines.forEach((text, i) => {
    for (const m of text.matchAll(CLAIM)) {
      out.push({ n: Number(m[1]), noun: m[2].replace(/s$/, ''), line: i + 1, text: m[0] });
    }
  });
  return out;
}

describe('public copy states the real endpoint and tool counts', () => {
  test(`code: ${PAID} paid + ${FREE} free = ${TOTAL} endpoints, ${TOOLS} MCP tools`, () => {
    expect(PAID).toBeGreaterThan(40);
    expect(TOOLS).toBeGreaterThan(40);
  });

  for (const file of FILES) {
    test(`${file}: every "<N> endpoints/tools" claim matches code`, () => {
      const found = claims(file);
      expect(found.length).toBeGreaterThan(0);
      const wrong = found.filter(({ n, noun }) => {
        if (noun === 'tool') return n !== TOOLS;
        // An endpoint count may be the paid count or paid+free.
        return n !== PAID && n !== TOTAL;
      });
      expect(
        wrong.map((w) => `${file}:${w.line} "${w.text}" (expected ${w.noun === 'tool' ? TOOLS : `${PAID} or ${TOTAL}`})`),
      ).toEqual([]);
    });
  }
});
