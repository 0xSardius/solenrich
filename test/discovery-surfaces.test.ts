/**
 * B2 (2026-09-20): API root negotiation, API robots.txt, llms-full.txt.
 * Pure modules, no network. Run: bun test test/discovery-surfaces.test.ts
 */
import { describe, test, expect } from 'bun:test';
import { rootResponse, wantsHtml, API_ROBOTS_TXT, ROOT_INDEX, WWW } from '../src/lib/root';
import { buildLlmsFull } from '../src/lib/llms-full';
import { PRICING, FREE_ENDPOINTS } from '../src/config';
import { ENDPOINT_META } from '../src/openapi';

const req = (path: string, accept?: string, method = 'GET') =>
  new Request(`https://api.solenrich.com${path}`, { method, headers: accept ? { accept } : {} });

describe('API root', () => {
  test('a browser (Accept leads with text/html) gets a 301 to www', async () => {
    const r = rootResponse(req('/', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'))!;
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe(WWW);
  });

  test('curl / fetch / SDK defaults get the JSON discovery index', async () => {
    for (const accept of [undefined, '*/*', 'application/json', 'application/json, text/plain, */*']) {
      const r = rootResponse(req('/', accept))!;
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(j.discovery.docs).toBe('https://api.solenrich.com/docs');
      expect(j.discovery.llms_full_txt).toBe('https://api.solenrich.com/llms-full.txt');
      expect(j).toEqual(ROOT_INDEX);
    }
  });

  test('Googlebot-style Accept is treated as a browser', () => {
    expect(wantsHtml('text/html,application/xhtml+xml,application/signed-exchange;v=b3;q=0.7,*/*;q=0.8')).toBe(true);
    expect(wantsHtml('text/html, application/json')).toBe(false);
    expect(wantsHtml(null)).toBe(false);
  });

  test('only GET/HEAD on exactly "/" is intercepted', () => {
    expect(rootResponse(req('/docs', 'text/html'))).toBeNull();
    expect(rootResponse(req('/entrypoints/query/invoke', '*/*', 'POST'))).toBeNull();
    expect(rootResponse(req('/', '*/*', 'POST'))).toBeNull();
    expect(rootResponse(req('/', 'text/html', 'HEAD'))!.status).toBe(301);
  });
});

describe('API robots.txt', () => {
  test('allows the discovery files, disallows paid routes, points at the www sitemap', () => {
    for (const line of ['Allow: /docs', 'Allow: /llms.txt', 'Allow: /llms-full.txt', 'Allow: /openapi.json', 'Allow: /.well-known/', 'Disallow: /entrypoints/', 'Disallow: /mcp', 'Sitemap: https://www.solenrich.com/sitemap.xml']) {
      expect(API_ROBOTS_TXT).toContain(line + '\n');
    }
  });
});

describe('llms-full.txt', () => {
  const docs = {
    methodology: { risk_score: { description: 'Wallet risk 0–1.', factors: ['New wallet — +0.15', 'Low diversity — +0.1'] } },
    data_sources: { helius: 'DAS API.', dexscreener: 'Prices.' },
  };
  const txt = buildLlmsFull({ pricing: PRICING as Record<string, string>, free: FREE_ENDPOINTS, meta: ENDPOINT_META, docs, baseAccepts: true });

  test('lists every paid and free endpoint with its price and invoke URL', () => {
    for (const [key, price] of Object.entries(PRICING)) {
      expect(txt).toContain(`### ${key} — $${price} USDC`);
      expect(txt).toContain(`POST https://api.solenrich.com/entrypoints/${key}/invoke`);
    }
    for (const key of FREE_ENDPOINTS) expect(txt).toContain(`### ${key} — free`);
  });

  test('renders required inputs, defaults, and the methodology/data-source trees', () => {
    expect(txt).toContain('- `address` string (required)');
    expect(txt).toContain('- `mint` string (required)');
    expect(txt).toMatch(/- `size_usd` number \([^)]*default 100/);
    expect(txt).toContain('## Scoring methodology');
    expect(txt).toContain('- **risk_score**');
    expect(txt).toContain('  - New wallet — +0.15');
    expect(txt).toContain('- **helius**: DAS API.');
    expect(txt).toContain('Base mainnet');
  });

  test('no-input endpoints say so instead of listing nothing', () => {
    expect(txt).toMatch(/### stonk-gems[\s\S]*?Inputs:\n- `quote_mint`/);
    expect(txt).toMatch(/### perps-market-structure[\s\S]*?Inputs:\n- (No inputs|`)/);
  });

  test('Base line disappears when Base accepts are off', () => {
    const solanaOnly = buildLlmsFull({ pricing: PRICING as Record<string, string>, free: FREE_ENDPOINTS, meta: ENDPOINT_META, docs, baseAccepts: false });
    expect(solanaOnly).not.toContain('Base mainnet');
  });
});
