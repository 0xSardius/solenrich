# SolEnrich Discoverability Audit (2026-06-25)

Comprehensive audit of whether agents can actually *find* SolEnrich, across four discovery surfaces
(x402 ecosystem, MCP directories, agent registries/marketplaces, open-web/search) + our own discovery
files. Run via 4 parallel research agents + live checks.

## TL;DR

**SolEnrich is *visible* but not *discoverable where it counts.*** Our own metadata is excellent — the
problem is **one structural bug + distribution placement**, not product or description quality.

- **Demand reality (the grounding):** x402scan shows **287 txs, ~$3.37 USDC lifetime, only 2 unique
  buyers, 0 agent bookmarks**; Orbis shows **31 calls, 0 subscribers**. That footprint reads as
  dogfood/test traffic — i.e. **almost no organic agent discovery is happening.** The "demand
  bottleneck" is, specifically, a **discoverability bottleneck** — and it's fixable.
- **The one structural bug:** SolEnrich is **NOT in the CDP x402 Bazaar** — the canonical layer agents
  query programmatically — because our per-route **402 response is a custom human-readable JSON body, not
  the standard x402 `accepts[]` payment-requirements schema** the CDP indexer parses. Agents doing the
  canonical "search the bazaar for a capability" flow never find us. This cascades: **agentic.market and
  others auto-index FROM the CDP bazaar**, so this single fix unlocks several registries at once.
- **Distribution gaps:** missing from most MCP directories, the awesome-lists, and effectively invisible
  in search for every use-case query.
- **Our own docs are great:** `/.well-known/x402` and `/llms.txt` are both rich and intent-keyword-matched
  (perps, smart-money, risk, due-diligence). Metadata quality is NOT the problem.

## Surface-by-surface

### 1. x402 ecosystem
| Surface | Listed? | Notes |
|---|---|---|
| **x402scan** server page | ✅ strong | Good name + intent-rich description + 3 tags + all 28 endpoints listed. BUT usage: 287 txs / ~$3.37 / **2 buyers / 0 bookmarks** (`agentConfigurationResources: 0` on every endpoint). |
| **CDP Bazaar** `/discovery/resources` + `/discovery/search` | ❌ **NOT indexed** | Absent from the 24-item catalog. A search for our exact capabilities ("Solana wallet token risk perps funding") returns competitors (ApiToll Perps, generic "Solana On-Chain API", "Hyperliquid Funding Extremes") — **never SolEnrich.** Root cause: non-standard 402 response (see below). |
| **x402.org/ecosystem** | ❌ | Curated partner directory; not applied. Solana is a Premier Member (warm path). |
| **`/.well-known/x402` (self)** | ✅ healthy/rich | 31 endpoints, categories (`onchain-data, solana, defi, risk-intelligence, perps`), prices, OpenAPI link. Self-hosted → not crawled by CDP. |

### 2. MCP directories
| Directory | Listed? | Notes |
|---|---|---|
| **Smithery** | ✅ (needs fix) | `solenrich/SE01` exists, but description **under-sells perps + smart-money** (our top differentiators), and tool list / remote URL look stale. Manual login to fix. |
| **Official MCP Registry** (registry.modelcontextprotocol.io) | ❌ | **Highest-leverage gap** — downstream registries mirror it. |
| **Glama** | ❌ | Big-4 registry, feeds ChatGPT-style UIs. |
| **PulseMCP** | ❌ | Competitors (SendAI, Aldrin, openSVM…) listed; we're absent from a directory where our category is browsed. |
| **mcp.so / awesome-mcp-servers** | ❌ | Community-submittable, free. |
| **mcp.run** | ❌ (low priority) | Rebranded → turbomcp.ai; servlet-oriented, weak fit. |

CoinStats wins "best API for Solana agents" queries largely because its MCP server is **documented + cited**. MCP presence is a search-ranking lever, not just a directory checkbox.

### 3. Agent registries / marketplaces
| Registry | Listed? | Notes |
|---|---|---|
| **Orbis** | ✅ | 31 calls, **0 subscribers**, 100% uptime. Thin but real. |
| **agentic.market** | ❌ | **Auto-indexes from CDP Bazaar** → blocked by the same 402 issue. Competitors (Nansen, CoinGecko, Messari…) listed. |
| **MPPScan** | ❌ | Manual submit (mppscan.com/register); we're eligible (MPP + OpenAPI). **Easy free win.** |
| **XGATE** (Daydreams) | ❓ unconfirmed | Rule: "list on 8004 + host x402." We do both → should be eligible; verify in browser. |
| **8004-solana** | ✅ on-chain | Discoverable via Solana 8004 surfaces (8004market.io, SATI, 8004.qnt.sh, downstream XGATE). NOT 8004scan (EVM-only). Verify the asset renders with a good agent-card. |

### 4. Open web / search ("agent's-eye view")
Ranks for **1 of 8** category queries (#1 "Solana onchain data API for AI agents", via homepage only).
**Invisible for all 7 feature/use-case queries** an operator actually types — wallet risk, perps funding,
due diligence, smart money, x402 Solana, best-API-for-agents, Nansen-alternative. Competitors rank instead:
**Solana Tracker** (owns risk/DD), **CoinStats** (owns "agent" via its MCP), **Solsniffer** (token safety),
**Birdeye/Helius**, and now **Nansen** (launched x402 pay-per-call at $0.01 + agents.nansen.ai — directly
occupying our positioning with far more authority).
- Only **one** third-party citation exists: stealthex.io's "top Solana API providers" listicle.
- **Absent** from `awesome-solana-ai` and `awesome-x402` (both list competitors).
- Root cause: single landing page (no per-feature URLs to match queries 2–8), near-zero backlinks, no MCP-directory citations.

## Root causes (only 2–3 real ones)

1. **Non-standard 402 response** → not in CDP Bazaar → cascades to agentic.market + downstream registries. *The single highest-leverage fix.*
2. **Distribution gaps** — missing from MCP directories, awesome-lists, MPPScan (all free/fast).
3. **No search/content footprint** — one landing page, ~1 backlink, no per-feature pages → invisible for use-case search.

(Metadata quality is NOT a root cause — our `/.well-known/x402` + `/llms.txt` are strong.)

## Prioritized fix plan

### P0 — Fix CDP Bazaar indexing — ✅ FIXED + DEPLOYED 2026-06-26 (`bb13cf5`)

**CORRECTION to the audit's root cause:** our 402 was NOT non-standard. The standard payment
requirements (`x402Version: 2`, `accepts[]` with scheme/network/asset/payTo/feePayer) + the bazaar
extension are emitted in the **`payment-required` HTTP header** (base64) — the audit only inspected the
JSON body and missed it. The *real* bug: `declareDiscoveryExtension()` already returns `{ bazaar: {...} }`,
but `routeConfig` wrapped it AGAIN under `extensions: { bazaar: ... }`, producing malformed
`extensions.bazaar.bazaar.{info,schema}` that CDP's indexer can't parse. Fix (one line in `agent.ts`):
assign `declareDiscoveryExtension(...)` directly to `extensions`. Metadata-only — `accepts[]`, verification,
and handlers untouched. Verified live: prod 402 now shows correct `extensions.bazaar.{info,schema}` and
unchanged `accepts[]`; all endpoints green.

**SEEDED 2026-06-26:** ran SolScout `--paid --mode stress` → **29/29 endpoints settled real USDC through
CDP** (full paid E2E also re-verified). Immediately after, SolEnrich is **NOT yet in CDP `/discovery/resources`**
(253 items, mostly EVM/Base; our solana payTo absent). Most likely **CDP indexer lag** (async cataloging) —
the extension is confirmed well-formed + `accepts[]` valid, so re-check `/discovery/resources` + `/discovery/search`
in a few hours / next day. If still absent after the indexer should have caught up, there's a deeper CDP-side
requirement to chase (registration step, or extension format nuance) — not the malformed-nesting bug, which is fixed.

**Follow-up — SolScout stress list is STALE:** it does NOT include the 5 newest endpoints
(`hyperliquid-trader-profile`, `hyperliquid-smart-money`, `perps-cross-venue-funding`,
`perps-venue-comparison`, `perps-basis-signal`), so those did NOT get seeded. Update `agents/solscout/stress.ts`
+ re-run paid to seed them for full bazaar coverage. Also `check-alerts` 402'd in the run (didn't settle).

#### Original audit notes (superseded by the correction above):
- **Inspect our live 402 first** (touches payment middleware — don't break payments). Current per-route 402
  is a custom `{"error":"Payment Required","pricing":{...},"all_endpoints":{...}}` body (likely from
  `build402Body` in `src/index.ts`). It must emit/also-offer the **standard x402 payment-requirements**:
  top-level `x402Version` + `accepts[]` per route (`scheme`, `network`, `maxAmountRequired`, `payTo`,
  `asset`, `resource`) + the **bazaar discovery extension** (`extra`/`outputSchema`/`description`).
- After the schema fix, **re-settle one CDP payment per endpoint** (scripted self-call across all 31) to
  seed the catalog; confirm routes appear in `GET /v2/x402/discovery/resources`.
- Mirror our strong x402scan per-endpoint descriptions into the `accepts[].extra.description` so we win the
  semantic-search terms ("perps funding", "wallet risk", "due diligence").

### P1 — Free, fast distribution (do this week)
- **MCP submissions:** Official MCP Registry (server.json + publisher CLI) → Glama → PulseMCP → mcp.so.
- **Fix Smithery** listing: correct remote URL (`api.solenrich.com/mcp`) + tool list + **rewrite description
  to lead with perps cross-venue funding + smart money + wallet risk + due diligence.**
- **awesome-list PRs:** `solana-foundation/awesome-solana-ai` + `xpaysh/awesome-x402` (free, high-authority backlinks).
- **MPPScan** manual submit.

### P2 — Search/content (compounding)
- **Per-use-case landing pages** targeting the failed queries: `/solana-perps-funding-rate-api`,
  `/solana-wallet-risk-score-api`, `/token-due-diligence-api`, `/smart-money-api`,
  `/nansen-alternative-for-agents`, `/x402-solana-data-api`. Mirror Solana Tracker's per-feature-page pattern.
- **Lean into perps** — "cross-venue Solana perps funding API for agents" is a near-unclaimed term (no
  dedicated agent-API competitor ranks for it).
- **Position vs Nansen's x402 tier** — a searchable comparison page ($0.001 + synthesized briefings + perps).

### P3 — Verify + polish
- Confirm 8004 rendering (8004market.io / SATI / 8004.qnt.sh) + XGATE indexing in a browser.
- Drive x402scan bookmark count off 0 (dogfood agents add endpoints to their configs).
- Increase unique buyers beyond 2 (a few genuine external paid calls change how every explorer scores us).
- Brand-disambiguate vs the "SE" Bags token on branded search.

## Who does what
- **Claude can do:** the 402-schema fix (carefully, behind verification) + the re-settle script; draft the
  MCP `server.json` + all directory/awesome-list submission content; build the per-feature landing pages;
  write the Nansen-comparison content.
- **Sardius does:** manual-login submissions (Smithery fix, MPPScan form, awesome-list PR merges), and
  relationship/citation outreach (roundup inclusion, Flash-style partner intros).
