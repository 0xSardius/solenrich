/**
 * B3 (2026-09-20): suite map covers every endpoint exactly once; llms.txt and
 * llms-full.txt lead with what sells and group by suite, stonk first.
 */
import { describe, test, expect } from 'bun:test';
import { ENDPOINT_SUITES, SUITE_ORDER } from '../src/lib/suites';
import { buildLlmsTxt } from '../src/lib/llms-txt';
import { buildLlmsFull } from '../src/lib/llms-full';
import { PRICING, FREE_ENDPOINTS } from '../src/config';
import { ENDPOINT_META } from '../src/openapi';

const ALL = [...Object.keys(PRICING), ...FREE_ENDPOINTS];

describe('endpoint suites', () => {
  test('every priced or free endpoint is in exactly one suite, and every suite key exists', () => {
    const counts = new Map<string, number>();
    for (const k of SUITE_ORDER) counts.set(k, (counts.get(k) ?? 0) + 1);
    expect(ALL.filter((k) => !counts.has(k))).toEqual([]);
    expect([...counts].filter(([, n]) => n > 1).map(([k]) => k)).toEqual([]);
    expect(SUITE_ORDER.filter((k) => !ALL.includes(k))).toEqual([]);
  });

  test('stonk suite is first and opens with the free catalog call; trenches is second', () => {
    expect(ENDPOINT_SUITES[0].id).toBe('stonkfun');
    expect(ENDPOINT_SUITES[0].keys[0]).toBe('stonk-pairs');
    expect(ENDPOINT_SUITES[1].id).toBe('trenches');
  });
});

describe('llms.txt order', () => {
  const txt = buildLlmsTxt({ pricing: PRICING as Record<string, string>, free: FREE_ENDPOINTS, meta: ENDPOINT_META, suites: ENDPOINT_SUITES, baseAccepts: true });

  test('lead paragraph names StonkFun, trenches, smart money, and perps, with the real counts', () => {
    const lead = txt.split('\n').find((l) => l.startsWith('> '))!;
    for (const w of ['StonkFun', 'trenches', 'smart-money', 'perps', `${Object.keys(PRICING).length} paid endpoints`]) expect(lead).toContain(w);
  });

  test('"Start here" precedes the first suite, and the first suite is StonkFun', () => {
    const start = txt.indexOf('## Start here');
    const stonk = txt.indexOf('## StonkFun reward coins');
    const trench = txt.indexOf('## Trenches');
    expect(start).toBeGreaterThan(0);
    expect(stonk).toBeGreaterThan(start);
    expect(trench).toBeGreaterThan(stonk);
    // The first endpoint link in the file is the stonk entry call.
    const firstLink = txt.match(/^- \[([a-z0-9-]+)\]\(/m)![1];
    expect(firstLink).toBe('stonk-pairs');
  });

  test('every endpoint is listed once with its price, and loop totals are computed from PRICING', () => {
    for (const k of ALL) {
      const occurrences = txt.split(`- [${k}](`).length - 1;
      expect(occurrences).toBe(1);
    }
    const loop = Number(PRICING['stonk-gems']) + Number(PRICING['stonk-quote']) + Number(PRICING['exit-signal']);
    expect(txt).toContain(`StonkFun trade, $${loop.toFixed(3).replace(/0+$/, '')} end to end`);
  });
});

describe('llms-full.txt order', () => {
  const full = buildLlmsFull({ pricing: PRICING as Record<string, string>, free: FREE_ENDPOINTS, meta: ENDPOINT_META, docs: {}, baseAccepts: true, suites: ENDPOINT_SUITES });

  test('grouped by suite in the same order, no "Other" bucket', () => {
    const headers = [...full.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    const suiteTitles = ENDPOINT_SUITES.map((s) => s.title);
    expect(headers.filter((h) => suiteTitles.includes(h))).toEqual(suiteTitles);
    expect(full).not.toContain('## Other');
    const firstSection = full.match(/^### ([a-z0-9-]+) — /m)![1];
    expect(firstSection).toBe('stonk-pairs');
  });
});
