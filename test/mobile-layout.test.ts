/**
 * Mobile layout guard (2026-09-20). The mobile audit (docs/mobile-audit-2026-09-20.md) found four
 * separate copies of the nav, three of them broken on a phone, because each page carried its own CSS.
 * These checks keep the pages on the shared files and keep the known phone defects from returning.
 *
 * Static checks only. The rendered check (overflow, tap targets, text size at 320/375/430/768 px) is
 * test/mobile-audit.browser.js — run it in a browser before a deploy that changes layout.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';

const DIR = 'landing';
// og-image.html is the source for the social card screenshot, not a served page.
const PAGES = readdirSync(DIR).filter((f) => f.endsWith('.html') && f !== 'og-image.html');
// Line endings are normalized: on Windows, git checks some files out with CRLF and leaves others LF.
const read = (f: string) => readFileSync(`${DIR}/${f}`, 'utf8').replace(/\r\n/g, '\n');

function nav(html: string): string {
  const m = html.match(/<nav class="site-nav"[\s\S]*?<\/nav>/);
  return m ? m[0] : '';
}

describe('landing pages: shared mobile layout', () => {
  test('there are pages to check', () => {
    expect(PAGES.length).toBeGreaterThanOrEqual(4);
  });

  for (const page of PAGES) {
    const html = read(page);

    test(`${page}: viewport tag, and zoom is not blocked`, () => {
      const tag = html.match(/<meta name="viewport" content="([^"]*)"/);
      expect(tag).not.toBeNull();
      expect(tag![1]).toContain('width=device-width');
      expect(tag![1]).not.toMatch(/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\.0)?\b/);
    });

    test(`${page}: links /site.css before its own <style>, and loads /site.js`, () => {
      const css = html.indexOf('href="/site.css"');
      const style = html.indexOf('<style>');
      expect(css).toBeGreaterThan(-1);
      expect(css).toBeLessThan(style);
      expect(html).toContain('<script src="/site.js" defer></script>');
    });

    test(`${page}: sets <html class="js"> in the head (site.css hides nav links and .reveal only with it)`, () => {
      const head = html.slice(0, html.indexOf('</head>'));
      expect(head).toContain("document.documentElement.className = 'js'");
    });

    test(`${page}: does not redefine the shared nav or the design tokens`, () => {
      const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
      expect(style).not.toMatch(/(^|[\s,}])\.?nav(-links|-logo|-toggle|-status)?\s*(\.container\s*)?\{/m);
      expect(style).not.toMatch(/--sol-green\s*:/);
    });

    test(`${page}: no input font-size under 16px on a phone (iOS Safari zooms on focus)`, () => {
      const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>')).replace(/\/\*[\s\S]*?\*\//g, '');
      // Rules whose selector names the input/textarea/select ELEMENT (".endpoint-input" is a class, not an input).
      // An input styled only through a class is not seen here; the rendered audit covers that case.
      const rules = [...style.matchAll(/([^{}]*(?<![\w.#-])(?:input|textarea|select)(?![\w-])[^{}]*)\{([^}]*)\}/g)];
      const sizes = rules
        .map(([, selector, body]) => ({ selector: selector.trim(), size: body.match(/font-size:\s*([\d.]+)px/) }))
        .filter((r) => r.size);
      // The last matching rule per selector wins the cascade; the mobile rule must come last and be >= 16.
      const last = new Map<string, number>();
      for (const r of sizes) last.set(r.selector, parseFloat(r.size![1]));
      for (const [selector, size] of last) {
        expect({ selector, size, ok: size >= 16 }).toEqual({ selector, size, ok: true });
      }
    });
  }

  test('the nav markup is identical on every page, apart from aria-current', () => {
    const navs = PAGES.map((p) => nav(read(p)).replace(/ aria-current="page"/g, ''));
    for (const n of navs) expect(n.length).toBeGreaterThan(0);
    for (const n of navs) expect(n).toBe(navs[0]);
  });

  test('each page marks at most one nav link as current, and it is its own path', () => {
    for (const page of PAGES) {
      const current = [...nav(read(page)).matchAll(/href="([^"]+)" aria-current="page"/g)].map((m) => m[1]);
      const path = page === 'index.html' ? null : '/' + page.replace(/\.html$/, '');
      expect(current).toEqual(path ? [path] : []);
    }
  });

  test('site.css and every page use only the two agreed breakpoints (768px, 1024px)', () => {
    const sources = [readFileSync(`${DIR}/site.css`, 'utf8'), ...PAGES.map(read)];
    for (const source of sources) {
      const widths = [...source.matchAll(/@media[^{]*\b(?:max|min)-width:\s*(\d+)px/g)].map((m) => Number(m[1]));
      for (const w of widths) expect([768, 1024]).toContain(w);
    }
  });

  test('no page hides sideways overflow on html or body (fix the element that overflows instead)', () => {
    for (const page of PAGES) {
      const style = read(page).slice(read(page).indexOf('<style>'), read(page).indexOf('</style>'));
      const rootRules = [...style.matchAll(/(?:^|\})\s*((?:html|body)(?:\s*,\s*(?:html|body))*)\s*\{([^}]*)\}/g)];
      for (const [, selector, body] of rootRules) {
        expect({ page, selector, hides: /overflow(-x)?\s*:\s*(hidden|clip)/.test(body) }).toEqual({ page, selector, hides: false });
      }
    }
  });

  test('every :hover rule sits inside @media (hover: hover), so it does not stick after a tap', () => {
    for (const page of PAGES) {
      const html = read(page);
      const style = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
      const hovers = (style.match(/:hover/g) || []).length;
      const guarded = (style.match(/@media \(hover: hover\) \{[^{}]*:hover/g) || []).length;
      expect({ page, unguarded: hovers - guarded }).toEqual({ page, unguarded: 0 });
    }
  });
});
