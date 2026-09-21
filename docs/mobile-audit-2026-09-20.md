# Mobile audit — www.solenrich.com (2026-09-20)

## Method

- Pages: `/`, `/docs`, `/stonkfun`, `/agent-card` (production, after commit `c59ee9c`).
- Each page was loaded in Chrome inside an iframe at 320, 375, 430 and 768 px. Media queries respond to the
  iframe width. A script measured: document scroll width, elements past the right edge, elements wider than
  their box, tap targets under 40 px, text under 12 px, form inputs under 16 px, fixed elements.
- Screenshots at 375 px of the top of each page and of the demo, format, compare, loop, table and code blocks.
- Static read of the CSS in each file.
- Not tested: a real iOS Safari or Android Chrome device, Lighthouse, screen readers. The desktop iframe has a
  15 px scrollbar, so the layout width was 305 / 360 / 415 px — slightly narrower than the named phone.

## Findings, by severity

### P0 — a visitor on a phone cannot do something

| # | Page | Finding | Measured |
|---|---|---|---|
| 1 | `/` | The mobile rule is `.nav-links { display: none }` and there is no menu button. A phone visitor has no link to StonkFun, Docs, Agent Card or the page sections. | Nav at 375 px shows the logo and "LIVE ON MAINNET" only. |
| 2 | `/docs`, `/agent-card` | The nav has no mobile rule. `.nav-links` runs from 177 px to 418 px at a 375 px viewport. `body { overflow: clip }` cuts the last link ("Agent Card") off the screen and it cannot be scrolled to. "Try It" wraps to two lines. | `nav 360/418`, last link at 379–418 px. |
| 3 | `/stonkfun` | Same nav at 320 px (177 → 340 px). At 375 px it fits but "Agent Card" wraps to two lines. | `nav 305/340`. |
| 4 | `/stonkfun` | One `<code>` element runs from 24 px to 420 px at 375 px. The page clips it, so the end of the line is unreadable. At 320 px, 12 elements pass the edge (eight `.endpoint` cards, two `code`, `#jobs`, `#loop`). | `div.page 360/420`. |

### P1 — works, but poor on a phone

| # | Page | Finding | Measured |
|---|---|---|---|
| 5 | `/` | The three demo inputs use 13 px text. iOS Safari zooms the page when an input under 16 px takes focus, and does not zoom back. `/docs` has one such input. | `#demo-input`, `#compare-input-1`, `#compare-input-2`: 13 px. |
| 6 | `/` | The endpoints section is 12,565 px tall at 375 px: 42 cards in one column, about 16 screens. The whole page is 28,003 px. | Section offsets from the DOM. |
| 7 | `/` | `section.cta-section` is 480 px wide at a 375 px viewport (a decorative glow). `body { overflow-x: hidden }` hides it. The cause is not fixed, and iOS Safari does not always honour `overflow-x: hidden` on `body` alone. At 320 px the proof strip and the footer also pass the edge (341 px, 281 px in a 257 px box). | `html 360/480`. |
| 8 | all | Tap targets under 40 px: demo mode buttons 29 px high, example buttons 28 px, proof-strip links 16 px, footer links 38 px, `/docs` sidebar links 29 px (23 of them), `collapse all` 23 px, sidebar section toggles 26 px. | 15 on `/`, 69 on `/docs`, 9 on `/stonkfun`, 11 on `/agent-card`. |
| 9 | `/` | Text at 10–11 px: endpoint tags (10 px, 585 characters), source details, section labels, MCP tool tags, step code, the demo counter. `/docs`, `/stonkfun` and `/agent-card` have 3–4 such styles each. | 17 styles under 12 px on `/`. |
| 10 | `/stonkfun` | Code blocks inside the loop steps are 201 px wide with 711–779 px of content. The step number column and nested padding take 174 px of a 375 px screen. | `div.code-block 201/764`. |
| 11 | `/docs` | The full sidebar (about 700 px) renders above the content on a phone. Long inline JSON breaks in the middle of a word. | Screenshot. |
| 12 | `/` | The LLM briefing sample in the formats section loses its line breaks at 375 px: "DUE DILIGENCE", the rule line and "Price:" run together. | Screenshot. |

### P2 — code quality

| # | Finding |
|---|---|
| 13 | Four pages carry four separate copies of the CSS (1,379 + 415 + 105 + 304 lines) and four copies of the nav markup. The four navs already differ: `/` has six links, `/stonkfun` five, `/docs` and `/agent-card` four with no StonkFun link. |
| 14 | Breakpoints are not consistent: 640, 700, 768, 900 and 1024 px across the files; `index.html` has eight `@media` blocks in different places. |
| 15 | `index.html` has 79 inline `style=""` attributes. |
| 16 | 74 `.reveal` elements start at `opacity: 0` and show only when the script adds `.visible`. If the script fails, or a crawler renders without scrolling, the content is blank. No `prefers-reduced-motion` rule on any page. |
| 17 | 33 `:hover` rules and no `@media (hover: hover)` guard, so hover styles stick after a tap. No `:focus-visible` style on any page. |
| 18 | `100vh` on `/` and `/docs` (mobile browsers count the URL bar in `vh`; `dvh` is the fix). No `theme-color` meta. No `safe-area-inset` padding on the fixed nav. |
| 19 | The font request loads 11 weights in three families on every page. JetBrains Mono 300 and 700 and Space Grotesk 400 are candidates to drop after a usage check. |

### Correct today

- Every page has `width=device-width, initial-scale=1` and does not block zoom.
- No page scrolls sideways at 375 px or wider (the overflow is clipped, not scrolled).
- Code blocks and the `/stonkfun` quote table sit in `overflow-x: auto` wrappers and scroll inside their box.
- Hero, persona cards, compare cards, value cards and the footer stack to one column at 768 px and under.
- No images in the page body, so no image sizing problem.

## Proposed fix (one change, reviewed as one row)

1. Move the shared tokens, reset, nav, footer, buttons, code block and table styles into `landing/site.css`.
   Each page keeps only its own page-specific rules.
2. One nav for all four pages: same six links, a menu button under 768 px that opens a full-width panel,
   44 px link rows, `aria-expanded`, closes on link tap and on Escape. About 25 lines of script, shared in
   `landing/site.js`.
3. Two breakpoints only: 768 px and 1024 px. Fix each overflow at its source (cta glow, proof strip, footer,
   `/stonkfun` cards and code), then remove `overflow-x: hidden` / `overflow: clip` from `body`.
4. Inputs to 16 px. Tap targets to 44 px minimum. Body-adjacent text to 12 px minimum.
5. `/` endpoints section: group by suite (the order in `src/lib/suites.ts`), first suite open, the others
   collapsed under 768 px with `<details>`. No content removed.
6. `/stonkfun` loop steps: number above the title under 768 px, so code blocks get the full card width.
7. `/docs`: sidebar collapsed behind a "Contents" button under 900 px; `overflow-wrap: anywhere` on inline code.
8. `.reveal` becomes progressive: visible by default, hidden only when the script marks `<html class="js">`;
   `prefers-reduced-motion` turns the transition off. Hover rules inside `@media (hover: hover)`.
   `:focus-visible` outline. `100dvh`. `theme-color`. Safe-area padding on the nav.
9. Guard: `test/mobile-layout.test.ts` — static checks that every landing page links `site.css`, has the
   viewport tag, has no `<input>` style under 16 px and no `overflow-x: hidden` on `body`. The rendered check
   (the script used in this audit) goes in `local/scripts/mobile-audit.js` for re-runs before a deploy.

Size: about one day. Verification: re-run the audit script on production at 320 / 375 / 430 / 768 px; the
target is zero elements past the edge, zero tap targets under 40 px outside running text, zero inputs under
16 px, on all four pages. A check on a real phone by Sardius closes the row.
