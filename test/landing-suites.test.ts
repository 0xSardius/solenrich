/**
 * Home page endpoint suites guard (2026-09-21). The endpoint cards on landing/index.html are hand-written
 * copy grouped into <details class="suite"> blocks. Before this guard, four priced endpoints had no card at
 * all and nothing noticed. The page must follow src/lib/suites.ts (suites, order, membership) and
 * src/config.ts (prices).
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { ENDPOINT_SUITES } from '../src/lib/suites';
import { PRICING, FREE_ENDPOINTS } from '../src/config';

const html = readFileSync('landing/index.html', 'utf8');

interface PageSuite { id: string; count: string; cards: Array<{ name: string; price: string }> }

const pageSuites: PageSuite[] = [...html.matchAll(/<details class="suite" id="suite-([a-z-]+)"[^>]*>([\s\S]*?)<\/details>/g)].map(
  ([, id, body]) => ({
    id,
    count: (body.match(/<span class="suite-meta">([^<]+)<\/span>/) || [])[1] || '',
    cards: [...body.matchAll(/<span class="endpoint-name">([^<]+)<\/span>\s*<span class="endpoint-price">([^<]+)<\/span>/g)].map(
      ([, name, price]) => ({ name: name.trim(), price: price.trim() }),
    ),
  }),
);

describe('home page endpoint suites', () => {
  test('the page has the suites of suites.ts, in the same order', () => {
    expect(pageSuites.map((s) => s.id)).toEqual(ENDPOINT_SUITES.map((s) => s.id));
  });

  test('each suite holds exactly its endpoints, in the same order', () => {
    for (const suite of ENDPOINT_SUITES) {
      const page = pageSuites.find((s) => s.id === suite.id);
      expect({ suite: suite.id, cards: page?.cards.map((c) => c.name) }).toEqual({ suite: suite.id, cards: suite.keys });
    }
  });

  test('no endpoint card sits outside a suite', () => {
    const all = [...html.matchAll(/<span class="endpoint-name">([^<]+)<\/span>\s*<span class="endpoint-price">/g)].length;
    expect(all).toBe(pageSuites.reduce((n, s) => n + s.cards.length, 0));
  });

  test('the count in each suite header is the number of cards under it', () => {
    for (const s of pageSuites) {
      expect({ suite: s.id, count: s.count }).toEqual({ suite: s.id, count: s.cards.length === 1 ? '1 call' : `${s.cards.length} calls` });
    }
  });

  test('every card price equals PRICING (or "free" for a free endpoint)', () => {
    for (const { name, price } of pageSuites.flatMap((s) => s.cards)) {
      const expected = (FREE_ENDPOINTS as readonly string[]).includes(name) ? 'free' : `$${PRICING[name as keyof typeof PRICING]}`;
      expect({ name, price }).toEqual({ name, price: expected });
    }
  });

  test('every suite starts open in the markup (the page script closes all but the first on a phone)', () => {
    const openers = [...html.matchAll(/<details class="suite"[^>]*>/g)].map((m) => m[0]);
    for (const o of openers) expect(o).toContain(' open');
  });
});
