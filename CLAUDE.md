# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Workflow Rules

- **Commit and push after each feature or modular change.** Don't let work accumulate uncommitted — each phase, feature, or logical unit of work should be committed and pushed before moving on.

- **New endpoint checklist — when you add a paid endpoint, update ALL of these in the same change (or it ships half-wired):**
  1. `src/config.ts` — `PRICING` (+ `CACHE_TTL` if needed)
  2. Entrypoint handler + Zod schema + LLM formatter, registered in `src/lib/agent.ts`
  3. `src/mcp-tools.ts` — matching MCP tool
  4. `src/openapi.ts` — `ENDPOINT_META` entry (auto-flows to `/llms.txt`)
  5. `/docs` JSON in `src/lib/agent.ts`
  6. **`agents/solscout/stress.ts` — a stress config** (input + quality checks). Enforced: `STRESS_COVERAGE` + the `test/unit.test.ts` coverage test FAIL CI if a `PRICING` endpoint has no stress config.
  7. `test/test-all-endpoints.ts` — a verification entry
  8. README endpoint table + landing page if user-facing
  9. **`src/lib/agent.ts` — `BAZAAR_INPUT_EXAMPLES` entry IF the endpoint has required input params.** CDP's bazaar only catalogs endpoints it can demonstrate as callable: no-required-input endpoints catalog automatically, but a parameterized one (required `address`/`mint`/`market`/`signature`/etc.) needs a concrete `input` example or it stays **invisible** in the bazaar + agentic.market (confirmed empirically 2026-06-28 — input example → cataloged in ~11 min; without one, parameterized endpoints never catalog despite settling). Reuse the SolScout stress fixture as the example.
  After deploy, a SolScout `--paid` run seeds the endpoint into the CDP x402 Bazaar (settlement-driven discovery). Parameterized endpoints only appear there if step 9 is done.

## Project Overview

**SolEnrich** is a Solana onchain data enrichment agent. It accepts USDC micropayments via x402 protocol and returns enriched wallet/token/transaction data in JSON (for agents) or natural language (for LLMs).

- **Stack:** Lucid Agents SDK + Hono adapter + 8004-solana + Helius + Birdeye + DeFi Llama + Jupiter
- **Runtime:** Bun
- **Deploy:** Cloudflare Workers (stateless endpoints), Railway (streaming/webhooks)
- **Payment:** USDC on Solana via x402, Daydreams facilitator

## Build & Run Commands

```bash
# Install dependencies
bun install

# Start dev server (Hono on port 3000)
bun run dev

# Type check
bunx tsc --noEmit

# Run test script directly
bun run test/test-enrichment.ts

# Deploy to Cloudflare Workers
bunx wrangler deploy

# Set a CF Workers secret
bunx wrangler secret put HELIUS_API_KEY

# Register agent identity (run once)
bun run identity/register.ts

# Seed reputation (post-deploy)
bun run deploy/seed-reputation.ts
```

## Architecture

### Dual-Format Output

Every entrypoint accepts a `format` parameter: `"json"` (structured data for agents), `"llm"` (natural language briefing for LLM context windows), or `"both"` (JSON + `llm_summary` field). The enrichment engine runs identically for both — the LLM formatter is pure string interpolation (template literals with conditionals), not LLM inference. No template engines, no model calls.

### Request Flow

```
Client → x402 Paywall (Lucid native) → Entrypoint Router → Enrichment Engine → Format Router → Response
```

Without a valid x402 payment header, endpoints return HTTP 402 with payment instructions. The Daydreams facilitator (`https://facilitator.daydreams.systems`) handles payment verification and settlement.

### Source Directory Layout

```
src/
├── index.ts              # Hono app + Lucid adapter, server entry
├── config.ts             # Central config: env vars, PRICING, CACHE_TTL
├── agent.ts              # Lucid agent definition, client init, entrypoint registration
├── entrypoints/          # API endpoint handlers (one per route)
├── enrichers/            # Core business logic (wallet-profiler, token-analyzer, etc.)
├── formatters/           # LLM briefing generators (deterministic templates)
├── sources/              # Data source API clients (helius, birdeye, jupiter, etc.)
├── realtime/             # SSE streaming + webhook infrastructure
├── cache/                # Upstash Redis (prod) / in-memory Map (dev)
├── schemas/              # Zod input/output schemas
└── utils/                # parallel.ts (parallel fetch), normalize.ts (formatting helpers)
```

### Data Flow Through Enrichers

Enrichers are the core business logic. Each enricher:
1. Checks cache first (`solenrich:` prefixed keys in Redis)
2. On cache miss, uses `parallelFetch()` to hit multiple data sources simultaneously
3. Normalizes and cross-references data across sources
4. Runs labeling and/or risk scoring (pure logic, no external calls)
5. Caches result with appropriate TTL, returns typed object

The `WalletProfiler` is the most complex enricher — it orchestrates Helius, Birdeye, Jupiter, and Solana RPC in parallel, then feeds results through the labeler and risk scorer.

### Entrypoint Pattern (Lucid SDK — Actual API)

The actual Lucid SDK API differs from the PRD. The real pattern (from the scaffold):

```typescript
// src/lib/agent.ts — agent setup
import { createAgent } from "@lucid-agents/core";
import { createAgentApp } from "@lucid-agents/hono";
import { http } from "@lucid-agents/http";
import { payments, paymentsFromEnv } from "@lucid-agents/payments";

const agent = await createAgent({ name, version, description })
  .use(http())
  .use(payments({ config: paymentsFromEnv() }))
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// Registering an entrypoint — uses `key` not `name`, price is decimal string
addEntrypoint({
  key: "enrich-wallet",
  description: "Full wallet profile with holdings, DeFi positions, labels, and risk score",
  input: EnrichWalletInput,        // Zod schema
  output: WalletEnrichmentSchema,  // Zod schema
  price: "0.005",                  // USDC decimal string, NOT base units
  handler: async (ctx) => {
    const input = ctx.input as z.infer<typeof EnrichWalletInput>;
    const data = await profiler.enrich(input.address, input.depth);
    return { output: formatResponse(data, input.format, formatWalletBriefing) };
  },
});
```

Key differences from PRD: `key` not `name`, price is `"0.005"` not `5000`, handler returns `{ output: {...} }`, handler receives `ctx` object with `ctx.input`.

### Dependency Injection

Data source clients (HeliusClient, BirdeyeClient, etc.) are instantiated once in `src/agent.ts` and injected into enrichers via constructor parameters. Enrichers never instantiate their own clients.

## Key Implementation Notes

- **Lucid SDK may differ from PRD:** The SDK evolves fast. Always check installed package types (`node_modules/@lucid-agents/*/dist/index.d.ts`) for the real API surface. If `@lucid-agents/*` packages have been consolidated under `@lucid-dreams/*`, use that namespace.
- **Helius DAS API uses JSON-RPC** (POST with `method`/`params`), not REST. The enhanced transaction endpoint IS REST. Don't mix them up.
- **Birdeye headers are critical:** Every Birdeye request needs `X-API-KEY` and `x-chain: solana` headers. Missing headers cause silent failures.
- **Pricing amounts are in USDC base units** (6 decimals): `5000` = $0.005. Verify this matches how Lucid expects pricing — some SDKs use decimal strings like `"0.005"`.
- **Cache failures must never block enrichment.** Wrap all cache operations in try/catch, log errors, return null/void gracefully.
- **`parallelFetch()` uses `Promise.allSettled`** with 10-second per-task timeout. One slow upstream API must not block the entire enrichment.
- **Labeler and risk scorer are pure functions** — they receive data objects and return labels/scores. No API calls, no side effects. This logic is proprietary.
- **The `/query` endpoint is the ONLY one that uses LLM inference** (via Daydreams Router). All other LLM-format responses use deterministic string templates.
- **When adding new endpoints, also add a matching MCP tool** in `src/mcp-tools.ts`. Every endpoint should be accessible via MCP (Smithery, Claude Desktop, Cursor). Follow the existing pattern: `server.registerTool()` with Zod input schema, calling `invoke()` with `format: 'llm'`.

## Data Sources

| Source | Auth | Key Config Field | Notes |
|--------|------|-----------------|-------|
| Helius | API key in URL | `CONFIG.helius` | Primary source. DAS API for assets, enhanced txs for parsing. Pro = 50 RPS. |
| Birdeye | `X-API-KEY` header | `CONFIG.birdeye` | Token prices, market data, holder info. Always include `x-chain: solana`. |
| DeFi Llama | None | `CONFIG.defiLlama` | Free. Protocol TVL + yield data. Cache aggressively (10min TTL). |
| Jupiter | None | `CONFIG.jupiter` | Free. Token prices (cross-reference), token metadata, verified status. |
| Solana RPC | Via Helius URL | `CONFIG.helius.rpcUrl` | SOL balances, raw account data. |

## Known Solana Protocol Program IDs

Used by wallet-profiler for DeFi position detection:
- Marinade: `MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD`
- Jito: `Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb`
- Raydium: `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8`
- Orca: `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc`
- Kamino: `6LtLpnUFNByNXLyCoK9wA2MykKAmQNZKBdY8s47dehDc`
- Jupiter: `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4`
- marginfi: `MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA`
- Drift: `dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH`

## Documentation

- **`GET /docs`** — Agent-readable documentation endpoint. Returns JSON with all endpoint schemas, input/output descriptions, scoring methodology (risk score factors, HHI interpretation, volatility classifications), data sources, and entity labeling info.
- **IMPORTANT:** When adding new endpoints, scoring factors, or methodology changes, update the `/docs` endpoint in `src/lib/agent.ts` to keep agent-facing documentation in sync.
- **README.md** — Human-readable API docs with examples, pricing table, and integration guide.

## SolScout (Consumer Agent)

SolScout is a standalone consumer agent in `agents/solscout/` that calls SolEnrich over HTTP. It does NOT modify anything in `src/`.

```bash
# Stress test (local, free)
bun run agents/solscout/index.ts --target local --mode stress

# Stress test (production, verifies 402 paywall)
bun run agents/solscout/index.ts --target production --mode stress

# Paid E2E test (real USDC, ~$0.10 per run)
bun run agents/solscout/index.ts --target production --paid --mode stress

# Demo consumer (NL questions)
bun run agents/solscout/index.ts --target local --mode demo "Is JUP safe?"

# Save JSON report
bun run agents/solscout/index.ts --target production --paid --mode report
```

- **SolScout wallet:** `H3UyiWm1YTzSKxXTpyssxxEreq6HzWTwNW5BVYewmmfC` (env: `SOLSCOUT_PRIVATE_KEY`)
- **Reports:** `agents/solscout/reports/`
- **First E2E report:** 13/13 passed, avg 4.8s latency (2026-04-01)

## Test Addresses

- **Wallet:** `vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg` (Solana Foundation)
- **Token:** `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` (BONK mint)

## Build Order

The PRD (`solenrich-claude-code-prd.md`) specifies a strict dependency-ordered build sequence across 12 phases. Files have explicit dependency lists — do not build a file before its dependencies exist. The high-level order is:

1. **Phase 0:** Scaffold, install deps, env vars, tsconfig, directory structure
2. **Phase 1:** Config → Schemas → Cache → Utils (parallel, normalize)
3. **Phase 2:** Data source clients (helius, birdeye, defi-llama, jupiter, solana-rpc)
4. **Phase 3:** Enrichers (labeler → risk-scorer → wallet-profiler → token-analyzer → tx-parser)
5. **Phase 4:** LLM formatters
6. **Phase 5:** Entrypoint handlers + schemas
7. **Phase 6:** Agent assembly (`agent.ts`) + server entry (`index.ts`)
8. **Phase 7:** Verification (health, 402 paywall, enrichment correctness)
9. **Phase 8:** 8004-solana identity registration + Agent Card optimization
10. **Phase 9:** Premium endpoints (whale-watch, batch, graph, copy-trade, due-diligence, query)
11. **Phase 10:** MCP server wrapper
12. **Phase 11-12:** Deployment + launch checklist

## Current Progress

### Phase 0: Scaffold and setup — DONE
- [x] Lucid-agent-creator skill installed (`.claude/skills/lucid-agent-creator/`)
- [x] Solana-dev-skill installed (`.claude/skills/solana-dev-skill/`)
- [x] Scaffolded with `bunx @lucid-agents/cli` (blank template, Hono adapter, Solana network)
- [x] Dependencies installed (`@lucid-agents/core`, `@lucid-agents/hono`, `@lucid-agents/http`, `@lucid-agents/payments`, `@upstash/redis`, `helius-sdk`, `@solana/web3.js`, `zod`, `wrangler`)
- [x] `.env` configured with Helius API key, Solana private key, wallet address (`66Qvhr1xnwqbCT36KfHfZF1JpoWdmCQ3uFYTN335CGXe`), Lucid payment vars
- [x] `tsconfig.json` updated (outDir, rootDir, declaration, path aliases)
- [x] Directory structure created (`src/{entrypoints,enrichers,formatters,sources,cache,schemas,utils,realtime}`, `identity/`, `mcp/`, `deploy/`)
- [x] Server starts without errors (`bun run dev` → "Starting agent server on port 3000...")
- [x] All routes responding: `/health` (200), `/entrypoints` (200), `/.well-known/agent.json` (200). Fix was `hostname: '127.0.0.1'` in `src/index.ts` to avoid Windows IPv6 dual-stack issue.
- [x] Upstash Redis connected in production (2026-03-17)

### Phase 1: Core infrastructure — DONE
- [x] `src/config.ts` — CONFIG (env vars), PRICING (USDC decimal strings), CACHE_TTL (seconds)
- [x] `src/schemas/common.ts` — FormatSchema, DepthSchema, SolanaAddressSchema, TxSignatureSchema, TimestampSchema
- [x] `src/cache/index.ts` — Cache class with Upstash Redis (prod) / in-memory Map (dev), auto-detect, all ops try/catch
- [x] `src/utils/parallel.ts` — parallelFetch() with Promise.allSettled + 10s per-task timeout
- [x] `src/utils/normalize.ts` — shortenAddress, formatUsd, formatNumber, formatPercent, formatTimestamp, lamportsToSol, tokenAmountToDecimal
- [x] `test/test-phase1.ts` — smoke test covering all modules (all passing)

### Phase 2: Data source clients — DONE
- [x] `src/sources/helius.ts` — DAS API (getAssetsByOwner, getTokenAccounts, searchAssets), enhanced tx parsing, signatures
- [x] `src/sources/birdeye.ts` — token price/overview/security/holders, wallet portfolio, OHLCV
- [x] `src/sources/defi-llama.ts` — protocol TVL, Solana protocols list, yield pools
- [x] `src/sources/jupiter.ts` — batch price lookup (v2 + x-api-key auth), token metadata
- [x] `src/sources/solana-rpc.ts` — SOL balance, account info, parsed transactions, blockhash, `getTokenLargestAccounts` (with retry/fallback), `resolveTokenAccountOwners`
- [x] `test/test-phase2.ts` — live smoke tests (Helius DAS, DeFi Llama, Solana RPC all passing)
- [ ] Still need: Jupiter API key (free at portal.jup.ag), Birdeye API key

### Phase 3: Enrichment engine — DONE
- [x] `src/enrichers/labeler.ts` — pure function, 10 label rules (whale, active_trader, defi_user, etc.)
- [x] `src/enrichers/risk-scorer.ts` — pure function, 7-factor additive scoring clamped to 0.0-1.0 + risk levels (LOW/MODERATE/ELEVATED/HIGH/CRITICAL) + centralized `scoreTokenRisk()`
- [x] `src/enrichers/wallet-profiler.ts` — orchestrates Helius+Birdeye+Jupiter+RPC via parallelFetch, light/full modes
- [x] `src/enrichers/token-analyzer.ts` — cross-references DexScreener + Jupiter + on-chain mint info + top 20 holders via `getTokenLargestAccounts`, holder concentration metrics, 9 risk flags including `high_concentration` and `whale_dominated`
- [x] `src/enrichers/tx-parser.ts` — maps Helius EnhancedTransaction to clean structure, protocol detection
- [x] `test/test-phase3.ts` — unit tests for labeler+risk-scorer, live integration for wallet-profiler+tx-parser

### Phase 4: LLM Formatters — DONE
- [x] `src/formatters/index.ts` — `formatResponse()` router: json (raw), llm (briefing+content_type), both (data+llm_summary)
- [x] `src/formatters/llm-wallet.ts` — wallet briefing: age, holdings, DeFi, labels, risk, connected wallets
- [x] `src/formatters/llm-token.ts` — token briefing: price, market cap, liquidity assessment, risk flags, verification
- [x] `src/formatters/llm-transaction.ts` — tx briefing: type, protocol, transfers, accounts
- [x] `src/utils/normalize.ts` — improved `formatUsd()` to handle micro-prices (e.g. $0.0000234)
- [x] `test/test-phase4.ts` — all 3 formatters + format router assertions passing

### Phase 5-6: Entrypoints + agent assembly — DONE
- [x] `src/schemas/wallet.ts` — EnrichWalletInput + WalletEnrichmentSchema (Zod)
- [x] `src/schemas/token.ts` — EnrichTokenInput + TokenEnrichmentSchema (Zod)
- [x] `src/entrypoints/wallet.ts` — enrich-wallet-light + enrich-wallet-full (registers via addEntrypoint)
- [x] `src/entrypoints/token.ts` — enrich-token-light + enrich-token-full
- [x] `src/entrypoints/transaction.ts` — parse-transaction
- [x] `src/lib/agent.ts` — full dependency injection: Cache → clients → enrichers → entrypoint registration
- [x] All 5 entrypoints visible at `/entrypoints`, invoke works for json + llm + both formats
- **Note:** x402 pricing commented out — `@x402/solana` package doesn't exist yet. PRICING config is ready to enable.
- **Note:** Birdeye API key needs upgraded plan for wallet portfolio endpoint. Enrichment still works via Helius fallback.

### Phase 7: Verification — DONE
- [x] `test/test-enrichment.ts` — 37/37 passing: wallet/token/tx enrichment + LLM briefings + cache hit + format modes
- [x] `test/test-server.ts` — 26/26 passing: /health, agent card, /entrypoints, invoke (json/llm/both), input validation
- [x] Fixed `llm-token.ts` formatter crash on null holder data
- [x] Agent card uses `skills` key (Lucid SDK convention, not `entrypoints`)
- [x] Acceptance criteria met: server starts, health 200, agent card generated, all enrichers return data, LLM briefings readable, cache hits confirmed

### Phase 8: Identity & Discovery — DONE
- [x] `8004-solana@0.7.9` + `@lucid-agents/identity@2.5.0` installed
- [x] `identity/register.ts` — 3-step registration: create collection (IPFS), register agent with metadata, set operational wallet
- [x] `deploy/seed-reputation.ts` — seeds initial feedback (quality, speed) on 8004-solana registry
- [x] `src/config.ts` — added `CONFIG.identity` (agentAsset, operationalWallet)
- [x] `src/lib/agent.ts` — added `/agent-card-extended` endpoint with capabilities, chains, formats, pricing, and 8004 identity
- [x] Type check passes, server starts, all endpoints respond
- **Note:** PINATA_JWT is still placeholder — set real JWT before running `bun run identity/register.ts`
- **Note:** Wallet needs SOL funding on devnet/mainnet before registration
- **Note:** `@lucid-agents/identity` is EVM-focused (ERC-8004); we use `8004-solana` SDK directly for Solana registration

### Phase 9: Premium Endpoints — DONE
- [x] `src/schemas/{whale-watch,batch,graph,copy-trade,due-diligence}.ts` — Zod input schemas
- [x] `src/enrichers/whale-watch.ts` — WhaleWatcher: finds top holders via RPC, resolves wallet owners, tracks buy/sell activity per whale with balance and supply context
- [x] `src/enrichers/graph-mapper.ts` — GraphMapper: maps wallet connections, detects clusters, depth-1/2 hops
- [x] `src/enrichers/copy-trade-analyzer.ts` — CopyTradeAnalyzer: trade PnL, win rate, consistency, smart_money labeling
- [x] `src/enrichers/due-diligence.ts` — DueDiligenceAnalyzer: composite (token + whales + holders), centralized `scoreTokenRisk()` with holder concentration, risk levels, detailed risk factors
- [x] `src/formatters/llm-{whale-watch,graph,copy-trade,due-diligence}.ts` — LLM briefing generators
- [x] `src/entrypoints/{whale-watch,batch,graph,copy-trade,due-diligence}.ts` — entrypoint handlers
- [x] `src/lib/agent.ts` — all 16 entrypoints registered (5 core + 5 premium + query + 2 comparison + 2 temporal + 1 discovery)
- [x] Type check passes, server starts, all endpoints respond and return data
- **Note:** `query` endpoint (NL inference via Daydreams Router) deferred — lowest priority per PRD
- **Note:** Batch endpoint uses concurrency limit of 5 to prevent overwhelming data sources

### Phase 10: MCP Server Wrapper — DONE
- [x] `@modelcontextprotocol/sdk@1.27.1` installed
- [x] `src/mcp-tools.ts` — shared tool definitions (7 tools: wallet, token, tx, whale-watch, due-diligence, graph, copy-trade)
- [x] `mcp/server.ts` — stdio transport for local Claude Desktop/Code integration
- [x] `/mcp` HTTP endpoint — `WebStandardStreamableHTTPServerTransport` on production server (stateless, no install needed)
- [x] `mcp/README.md` — setup instructions for remote (URL) and local (stdio) modes
- [x] CORS configured for MCP protocol headers
- [x] All tools call SolEnrich agent via HTTP, return LLM-formatted briefings
- **Remote URL:** `https://api.solenrich.com/mcp`
- **Local:** `bun run mcp/server.ts`

### Phase 11-12: Deployment & Launch — DONE
- [x] Railway deployment (Docker + Bun native)
- [x] x402 paywall live — all 10 endpoints return 402 without payment
- [x] 8004-solana agent registered on mainnet
- [x] Landing page deployed to Vercel
- [x] README with API docs, pricing table, example requests

### Phase 13: Audit & Hardening (2026-06-10/11) — DONE

Comprehensive 4-track audit (enrichers/sources, payments/metrics, cross-surface consistency, infra/deps/security). No exposed secrets found; perps unit scaling verified correct; prices 100% consistent across config//docs/OpenAPI. All findings fixed same session.

**Bugs fixed:**
- [x] **Metrics entity tracking broken** (`09820e5`) — `c.req.raw.clone().json()` ran AFTER `await next()`; cloning a consumed Request body throws, swallowed by catch, so top-tokens/wallets never recorded. Middleware now registers before payment middleware and clones the pristine stream. Verified live: queried wallet appears in top_wallets.
- [x] **Per-caller tracking added** (`09820e5`) — `metrics:callers:{endpoint}:{date}` Redis sets; x402 payer wallet extracted from X-Payment tx signers, MPP credential hash, IP fallback. Cache gained `sadd`/`scard`. `/metrics` reports `unique_callers` + `callers_by_endpoint`. **This is the Feed V1 reopen prerequisite — gate can now resolve with real numbers.**
- [x] **Single shared Cache instance** (`09820e5`) — metrics + data no longer split across separate connections. Note: /metrics "returns 0" was partly by design — middleware only counts 200s, and unpaid 402 stress runs legitimately count zero.
- [x] **`/metrics` auth-gated** (`a884102`) — requires `Authorization: Bearer $METRICS_TOKEN`; locked in production when token unset, open in dev. (No wildcard CORS was actually registered on it — audit overstated that.) **ACTION: set `METRICS_TOKEN` on Railway.**
- [x] **Demo endpoints sanitized** (`a884102`) — no longer echo raw `err.message` (upstream errors can embed the Helius key from the RPC URL); full error logged server-side.
- [x] **`smart-money-flow` `total_buy_volume_usd`** (`95dba1b`) — documented as PnL-weighted proxy (avg_pnl × win_count, clamped ≥0); field name kept for API stability rather than breaking live consumers.

**Dependency/infra:**
- [x] **`@lucid-agents/{core,hono,http,payments}` pinned** (`53bd811`) — were `"latest"`; now 2.5.0 / 0.9.6 / 1.10.2 / 2.5.0.
- [x] **README → 29 endpoints** (`51e9864`) — added perps suite, orchestration, temporal, discovery, feed/signals sections; MCP count 7→27; env table gains BIRDEYE_API_KEY + METRICS_TOKEN.
- [x] **CI added** (`de71f85`) — `.github/workflows/ci.yml`: tsc + unit tests. Also fixed 4 stale parseIntent tests (safety-check compound intent). 138/138 green.
- [x] **`perps-market-structure` test coverage** (`95dba1b`) — added to test-all-endpoints.ts; full suite 60/60 against live server.
- [x] `stripe` is NOT unused (dynamic `await import('stripe')` in agent.ts for MPP) — audit agent false positive, kept. `wrangler` left in devDeps (still referenced in build docs).

**Cleanups:**
- [x] `helius.ts` no-op ternary + dead `isStandardRpc` param removed (`95dba1b`).
- [x] Metrics writes now `console.warn` on failure instead of silent `.catch(() => {})` (`09820e5`).
- [x] Tracked `test/test-cdp-auth.ts` + `logo_black_bg.png`; removed stale April worktree (abandoned @solana/kit 6.x experiment) (`95dba1b`).

**Audit false positives (checked, not bugs):** `alert-checker.ts` PnL toFixed is null-guarded upstream; `fetchWithRetry` always returns or throws; Jupiter/Adrena RATE_POWER and USDC decimal scaling all correct; x402/MPP dual-protocol gating sound; stripe dep in use.

## Bags Hackathon Submission

- **Hackathon:** [The Bags Hackathon](https://bags.fm/hackathon) — $4M funding, $1M in grants to 100 winners ($10K-$100K each)
- **Track:** AI Agents (also relevant: Payments, DeFi, Claude Skills)
- **Status:** SUBMITTED
- **Requirements:** Working product with real users/transactions, uses Bags token/API/fee-sharing, or is a verified onchain project
- **Judging:** Product traction (MRR, DAU, GitHub stars) + onchain performance (volume, active traders, revenue)
- **Partners/Judges:** Solana, Helius, Meteora, Privy, DFlow, Birdeye
- **Submit at:** https://bags.fm/apply | Questions: apps@bags.fm

## Strategic Positioning (2026-04-21)

**Thesis:** SolEnrich wins by being **agent-native first**, not dashboard-with-API. Counter-positioning play against Helius/Nansen/Birdeye/Dune — they can't copy us without sabotaging their existing subscription/dashboard businesses.

### Incumbents and their structural weaknesses (our attack surface)

| Incumbent | Strength | Structural weakness we exploit |
|---|---|---|
| Helius | Raw data infrastructure | Customers want data, not intelligence. Can't become synthesis layer without cannibalizing API customers. |
| Nansen | Wallet labeling, smart-money | $150/mo subscription. Agents can't sign up. Human-dashboard-first. |
| Birdeye | Market data + UI | Dashboard-first. API is retrofit. Token output, not briefings. |
| Dune | Flexible SQL | Query-writer required. Not agent-callable. |
| DexScreener | Token discovery | Ad-supported, free. Limits investment in agent infrastructure. |
| Step / Solscan / SolanaFM | Human explorers | Humans scroll; agents don't. No opportunity. |

### Our natural advantages (already real)

1. **Agent-native distribution channels incumbents aren't on** — Orbis, x402 bazaar, agentic.market, MCP directories. Proof: 2 paid Orbis calls within 18h of listing with zero marketing.
2. **Pay-per-call economics** — $0.002/call is in every agent's budget. $150/mo Nansen isn't.
3. **Composed intelligence over raw data** — `due-diligence` bundles 5 sources into one SAFE/CAUTION/RISKY verdict. Incumbents sell ingredients; we sell decisions.
4. **Jupiter Perps post-Drift** — only API serving this for agents. We filled the gap 2026-04-18.
5. **LLM-optimized briefings** — deterministic templates, no inference cost, tuned for context windows. Incumbents don't recognize this as a format.

### Guerilla warfare heuristics

- **Move faster than incumbents can copy.** Weekly ships, not quarterly roadmaps.
- **Pick terrain they can't fight on.** Agent marketplaces, MCP directories, x402 — yes. Enterprise RFPs, conference sponsorships — cede them.
- **Commoditize the supplier.** Use Helius/Birdeye/DexScreener as data sources; stay on top of the stack. Let them be shovels; we're the AI miner.
- **Build compounding moats, not defensible features.** Features get copied. These get stronger with usage:
  - Signal capture (consensus: "N agents queried this token in last hour")
  - Temporal snapshots (density grows with traffic)
  - Agent reputation / outcome correlation
- **Distribute where they don't.** Every new distribution channel is ground incumbents cede by default.

### Top 3 moves ranked by defensibility × leverage

1. **Intelligence Feed V1 (Priority 14)** — Shift from passive tool to signal source. Recurring-revenue model. Hardest to clone because requires temporal data + scoring + orchestration that only exists inside SolEnrich. Start with daily JSON feed ($0 marginal cost), escalate to SSE/webhooks if V1 validates demand.
2. **Smart Money Orchestration (Priority 9)** — `trending-signals`, `smart-money-flow`. Multi-endpoint chains. Raw-data providers can't compete because their architecture silos inputs. Justifies $0.05-$0.10 per call pricing.
3. **Data Network Effect (extension of Priority 8)** — Endpoints only we can offer because only we have agent query history. "Is this token being watched?" "What's trending among agents (not DEX volume)?" Unique to us, compounds with usage, incumbent can't replicate without building an agent business first.

### Build sequencing decision (2026-04-21)

**Smart Money Orchestration (#2) ships before Intelligence Feed V1 (#1).** Reason: `trending-signals` becomes the Feed's primary input. Building orchestration first gives Feed V1 higher-quality input with no rework. Feed V1 becomes a thin scheduled wrapper around `trending-signals` instead of a bespoke scanner. Net: same 4-5 total sessions, better composition, no throwaway code.

### Strategic pivot (2026-05-25)

**Platform is broad enough; next move is consumers.** 29 paid endpoints live including the full perps quintet (cross-venue funding, venue-comparison, basis-signal, perp position alerts via check-alerts, perps-market-trend). Smart Money Orchestration, Intelligence Feed V1, Consensus Signal all shipped. Most essential endpoints are built.

**Pivot:** build income-generating agents that consume SolEnrich. Two parallel tracks with different design tradeoffs:
- **Income track (private):** perps-bot dogfood plan (see `memory/project_perps_bot_dogfood.md`). Bot's Tier 1 / Tier 2 endpoint stack is now complete on Jupiter side. Adrena coverage adds multi-venue.
- **Demo track (public):** Telegram research bot or daily-digest tweet bot. Drives traffic + signal back to SolEnrich. Showmanship beats profit.

**What this means for the platform:** API additions become demand-driven (build what own bots need, not speculative endpoints). Validation gates resolve naturally because traffic shows up. Closes the loop between platform decisions and revenue.

**Open until next session:** which track first, and if income first, ship Adrena closeouts before bot v1 or after.

### Vibe-trading north star + agent swarm (2026-06-14)

**Thesis (locked):** "2026 = the year of vibe trading" (per the Coinbase Dev article). Trader supplies intent/thesis/taste/constraints; an AI agent does the search, monitoring, data access, routing, and (eventually) execution. The stack: *user intent → AI agent → live market data → **paid data access via x402** → wallet funds → DEX/CEX execution → feedback loop.* **SolEnrich IS the "paid agent-ready market-data" layer of that stack** — not adjacent to the thesis, a load-bearing part of it. The thesis expanding = SolEnrich's TAM expanding, with almost no change of direction required.

**Positioning (the lane):** the stack's data layer is "market AND cultural data." SolEnrich is the *on-chain truth half* — do NOT chase social/sentiment (no edge there, different game). Be **the ground-truth-and-execution-intelligence layer the vibe agent checks against**: "the timeline says ape — what does the chain actually say, and where do I execute at size." SolEnrich = the brain (the Sun at the center); the consumer agents are the swarm that orbits it.

**The moat:** `consensus-signal` (what agents query, from SolEnrich's own request stream) is a measure of *accelerating agent attention* — the article's "find momentum before price catches up," but proprietary and un-clonable without first owning an agent-data business. Every swarm agent feeds it. Now measurable since the 2026-06-11 caller-tracking fix.

**Swarm naming system:** **deities of time & eternity across world mythology** (rooted in "Parallax" = astronomy/position-by-angle; SolEnrich = "Sol", the Sun). Every candidate name MUST be availability-checked against Solana tokens before use — crypto naming is saturated (Aion, Aeon, Aevum, Kairos all taken; several as live Solana tokens). 
- **Ananke** = the perps agent (renamed from Riptide). Greek goddess of necessity/inevitability, coiled with Chronos as the serpent of eternity. Bonus: Ananke is a **moon of Jupiter** → ties to Jupiter Perps (a primary venue) AND the Parallax astronomy root. Verified clean on Solana 2026-06-14. Scope: `docs/perps-signals-bot-scope.md` (build frozen as-scoped; vibe-trading is the narrative wrapper + v1.5+ direction, not a v1 re-scope).
- Future agents (RWA/equities, signals, etc.) get their own time/eternity deity names, each availability-checked.

**Domains to expand (vibe-trading-shaped):** perps (complete; deepen Hyperliquid as first-class venue, not just reference) + **RWA tokenized equities** (new narrative — and buildable WITHOUT tokens.xyz: xStocks/Backed are SPL tokens with known mints; tokenized-equity-vs-real-spot is a **basis signal**, the exact machinery `perps-basis-signal` already implements). Sequence: prove ONE agent (Ananke) end-to-end with real users before fanning out the swarm — Tidal/Cardex/Pythia all stalled, so the bottleneck is proof-of-one, not quantity.

**Distribution angle:** SolEnrich runs on CDP's x402 facilitator — it's a live instance of the exact stack Coinbase Dev is evangelizing. Pursue showcase/partnership (same playbook as the Helius application).

### Vibe-trading endpoint roadmap (2026-06-16)

Endpoint-additions workshop output. Full detail: `docs/vibe-trading-endpoints-scope.md`. Five candidates scoped against three lenses (serves a vibe-trading agent / defensible synthesis / reuses existing machinery), ranked by **buyer ROI**:
1. **`hyperliquid-smart-money`** ($0.05–0.10) — ← **LOCKED as first new build (2026-06-16).** Highest provable buyer ROI: HL is the only high-volume venue where you can verify a trader's PnL history (`userFills`) AND live positions (`clearinghouseState`) on-chain → copy verifiably-profitable traders. Also the brain of Ananke's v1.5 copy-alert tier. "Nansen-for-Hyperliquid, agent-native."
2. **`vibe-check`** ($0.03–0.05) — one-call ACT/WAIT/AVOID verdict. Reuses `query` buy-decision intent + `consensus-signal` + slippage. The flagship vibe-trading primitive.
3. **`attention-momentum`** ($0.02) — agent-attention acceleration, the moat (reuses `signal-tracker`). Highest ceiling, traffic-gated → build rails now, compounds with the swarm.
4. **RWA tokenized-equity basis** — reuses `perps-basis-signal`; deferred behind HL track.

**HL track sequence:** Step 0 validation pull (backtest copying ~20 top HL traders' 30d position changes → proves the ROI + sets thresholds + yields marketing receipts) → Step 1 `hyperliquid-trader-profile` (3a, the enabler — new `clearinghouseState`/`userFills` methods on `PerpReferenceClient`) → Step 2 `hyperliquid-smart-money` (3b). HL = SolEnrich's first first-class off-Solana venue (perps intelligence is venue-agnostic; spot/wallet data stays Solana).

**The flywheel:** vibe-check = the verdict the agent asks; attention-momentum = the proprietary signal feeding it; HL smart-money = premium cross-venue intel; Ananke = the consumer that calls these AND generates the traffic that sharpens attention-momentum.

### Solana perps venue-coverage roadmap (2026-06-19)

Full research + integration-feasibility matrix: `docs/solana-perps-landscape.md`. Thesis: the Solana perps scene is **accelerating AND fragmenting** (6+ live venues, mixed pool/CLOB, no unified venue, >70% agent-driven volume) — which is the argument for SolEnrich as the neutral cross-venue intelligence layer. We don't win liquidity; we sit above the venues.

**Landscape updates since the May notes:**
- **Pacifica** reportedly overtook Jupiter as #1 Solana perp DEX by daily volume (CLOB; ex-FTX/Binance/Jane St team; >$100B cumulative) — BUT pre-TGE airdrop season, so volume is likely inflated. Jupiter still leads organic/OI/fees.
- **Drift** relaunching before July 2026 (security-first, perps-only, Tether-rescued, audited). Our "don't integrate until relaunch+audits" gate is being met.
- **Adrena** pivoted to RWA/TradFi perps (equities/commodities/forex). **Bullet** (ex-Zeta) live (appchain). **Phoenix Perps** (Ellipsis) private beta. **Percolator** = Anatoly's upcoming SOL-native perp DEX.

**Integration feasibility (most are EASIER than Adrena's hand-Borsh decode — HTTP APIs/SDKs):**
- **Drift** — `@drift-labs/sdk` + Data API + on-chain accounts. Best surface. **Priority #1 (relaunch timing).**
- **Pacifica** — REST + WS + Python SDK (docs.pacifica.fi). **Priority #2 (volume leader, CLOB).**
- **Flash Trade** — REST (indexes on-chain) + Rust SDK, RWA/forex. #3.
- **Phoenix** — **LIVE + public REST** (`perp-api.phoenix.trade/exchange` → 200 JSON, no auth; verified 2026-06-19). Trading waitlisted but data is open. Institutional CLOB. Not beta-blocked — integrable now. #3.
- **Bullet** — appchain, needs its own (non-public) API. #5, blocked.
- Each venue is an additive `VenueQuote` entry; `best_entry`/`arbitrage` recompute automatically. The HL smart-money (3b) work generalizes to cross-venue Solana smart-money once we read per-venue trader positions.

**HIGH PRIORITY — Flash v2 API (2026-06-25):** Flash reached out to Sardius personally. v2 (`docs.flash.trade/.../flash-trade-v2`) serves Anchor-deserialized accounts as clean REST JSON — `/v2/raw/markets` (OI via `collectivePosition.sizeUsd`+`side`), `/v2/raw/custodies` (`borrowRateState.currentRate` + `assets`), `/v2/prices` — closing our v1 OI gap AND simplifying Flash to pure REST. Currently `env:dev` (don't depend on for prod yet). First-mover/launch-partner opportunity + unlocks Flash's RWA/forex/commodity catalog. Plan: Sardius confirms v2 prod timeline w/ Flash; build v2-ready client behind a flag, flip day-one at prod. Detail: `docs/solana-perps-landscape.md` "Flash v2 API".

**Time-sensitive:** be Drift's day-one agent intelligence layer when it relaunches.

### "The Trenches" — memecoin intelligence vertical (open idea, 2026-06-22)

Memecoins are the most agent-driven segment on Solana (>70% of DEX volume on peak launch days is bots) and pure vibe trading (narrative/momentum/speed). A strong NEXT vertical that reuses our existing token/wallet/graph/copy-trade/consensus stack. **Framing: we are the agent-native *intelligence layer* memecoin bots call (pay-per-call verdicts) — NOT a terminal** (that space is crowded: gmgn/photon/bullx/trojan/axiom). Be the research layer, not the sniper bot.

**Standout plays (most defensible, ranked):**
1. **Dev/deployer reputation** — "has this dev rugged before?" Tracks deployer wallet launch history (count, rug rate, outcomes). **Compounding data moat like `consensus-signal`** — improves with every launch we see; incumbents can't replicate without the history. Reuses Helius tx/asset history. Pure demonstrable loss-avoidance ROI.
2. **Insider/sniper/bundle detection** — "is this launch rigged?" % of supply held by block-0 buyers or wallets graph-connected to the dev. Defensible **synthesis** (wallet-graph + token-analyzer + launch-tx timing). Sells the verdict, not holder lists.
3. **Smart-money-in-the-trenches** — "which fresh launches are proven winners aping?" Reuses `copy-trade-analyzer` (winner ID) + `new-tokens` + `whale-watch`. `smart-money-flow` applied to new tokens.
4. **Agent-attention on fresh tokens** — extends `consensus-signal` (attention before price; uniquely ours).

**Orchestration headliner:** `trenches-scan` — fresh launches → filter rugs → insider/sniper check → dev reputation → smart-money + attention overlay → ranked ape-able list w/ reasoning ($0.05–0.10). The trenches `trending-signals`.

**Caveats:** (a) **Latency boundary** — block-0 sniping needs sub-second tx data (Geyser/streams), a different game we don't chase; the *intelligence* plays (dev rep, insider %, smart-money) are seconds-to-minutes "pre-ape research" that fits our request/response model. (b) ROI story is *stronger* than perps — meme outcomes are binary (rug −100% / runner +1000%), so avoiding one rug or catching one 10x pays for thousands of calls. (c) Fast rug-check alone is commoditized (rugcheck.xyz) — only valuable folded into the synthesis above. (d) Dogfoolable by a future "trenches" swarm agent (trickster/chaos deity name — availability-checked later).

**Sequencing:** adjacent vertical, doesn't block perps. Finish Flash on-chain (close out perps venue coverage) first, then open the trenches leading with dev-reputation + insider-detection.
**Status 2026-07-07:** Flash on-chain COMPLETE; trenches opened — `smart-money-trenches` SHIPPED (`ae8ebae`, 32 endpoints, bazaar-cataloged same day). Next trenches builds: Eris bot → `dev-reputation` + `token-x-ray` → `trenches-scan`.
**Status 2026-07-24:** `runner-scan` SHIPPED (`4f9a70b`, $0.04, **34 endpoints**) — the on-chain velocity/"WHAT is the token doing" leg, pairing with `smart-money-trenches` ("WHO is buying"). As-built notes at the top of `docs/runner-detection-scope.md`. Remaining trenches sequence: Eris bot → `attention-momentum` (thin signal-tracker extension) → `trenches-scan` (three-signal orchestrator) → `dev-reputation` + `token-x-ray`.

### Distribution strategy: dual-network accepts + discovery sprint (LOCKED 2026-07-07)

**The finding that set this (full audit in `docs/CHECKPOINT.md` 2026-07-07):** the x402 economy is
**dual-network by default, and SolEnrich is nearly the only single-network service in it.** Full CDP bazaar
scan (24,860 resources): 10,403 accept Base, 4,908 accept Solana — but 4,842 of the Solana-accepting
resources ALSO accept Base. Solana-ONLY resources across the whole economy: ~66, of which **32 are ours**.
Solana x402 is real (solana.com official pages; 35M+ txns/$10M+ volume since summer 2026; PayAI ~90% of
Solana volume) — but Solana-native services universally quote both chains. Adding Base isn't leaving
Solana; it's matching how Solana-native x402 services ship. Consequences of being Solana-only: invisible
to agentic.market (its importer is Base-anchored — verified: all 1,590 cataloged services accept Base),
skipped by Base-wallet agents even inside the CDP bazaar, outside most x402 tooling defaults.

**Facilitator decision: STAY ON CDP.** CDP is multi-network with Base as home turf — Base accepts = a
second scheme (`ExactEvmScheme`) on the SAME resource server; zero migration. PayAI (Solana-first, burned
us with schema drift in May) would be an *addition* someday, never a migration. Being CDP-facilitated on
both networks also strengthens the Coinbase showcase pitch. (Competitive note: `api.nansen.ai` is in the
bazaar now, dual-network — 31 resources.)

**Execution order (next steps, committed):**
1. **Base accepts via CDP — ✅ ACTIVATED 2026-07-09.** `EVM_PAY_TO=0x8EdE9eD2E6ACdd9B2BaFa42ff4078d3F3263607c`
   set on Railway. Verified live: 402 header advertises both networks (Base USDC `0x8335…2913`, EIP-3009
   extra auto-filled by CDP), all discovery surfaces dual-network, full paid re-seed 34/35 (1 = the known
   env-dependent smart-money-flow seed_source check; all 32 endpoints settled + returned 200s), and the
   **CDP bazaar re-indexed dual-network rows within minutes**.
   **✅ SUCCESS SIGNAL MET 2026-07-10 (next day!):** agentic.market's importer picked us up —
   `agentic.market/services/api-solenrich-com`, all 32 endpoints, networks Base+Solana. Confirms the
   Base-anchored-importer diagnosis end-to-end.
   **Follow-up (outreach, Sardius):** our entry is `enriched: false` → domain-as-name, empty category,
   description auto-scraped from one endpoint (perps-trader-profile). Entries with clean name/category/
   copy (e.g. Exa) are `enriched: true` = agentic.market's own curation pass. Ask them to enrich us
   (light-touch now that we're cataloged); suggested copy = our /.well-known/x402 service.description.
   Remaining: optional Base-side paid E2E (test EVM keypair + ~$1 Base USDC; SolScout is Solana-only —
   `--paid-base` mode pending). Base USDC as second
   `accepts` entry on all 32 routes + `ExactEvmScheme` registered on the same CDP resource server;
   all discovery surfaces (402 accepts, /openapi.json x-payment-info, /docs, /.well-known/x402,
   llms.txt) flip together on the `EVM_PAY_TO` env var. Verified flag-off (= prod today, unchanged)
   and flag-on doc surfaces locally; the live 402 accepts array can only be verified with real CDP
   creds → **verify at activation**. `@x402/evm@2.4.0` pinned. Docs standardized to flat request
   bodies (envelope still accepted) in the same change.
   **TO ACTIVATE (Sardius):** set `EVM_PAY_TO=<Base address you control>` on Railway → watch boot log
   for "(Solana + Base accepts)" → confirm live 402 shows both networks → full paid re-seed →
   dual-network bazaar rows. **Success signal:** agentic.market importer picks us up
   (`api.agentic.market/v1/services?limit=100&offset=N`). Base-side paid E2E needs ~$1 Base USDC on
   a test wallet.
2. **MCP directory sprint (parallel, free).** Verified dark 2026-07-07: Glama = NOT indexed, Smithery =
   stale `SE01` stub only, PulseMCP API sunset. Claude does Glama + mcp.so submissions; **Sardius**
   logs into Smithery to claim the namespace + dedupe SE01.
3. **Outreach (Sardius) + integration PRs (Claude).** (a) solana.com/x402 ecosystem showcase (curated, no
   formal process — email pitch; we're arguably the most complete Solana-native x402 data service). (b) CDP
   showcase note — stronger once dual-network. (c) Claude drafts integration/example PRs for the surfaces
   where Solana agents get *built*: **Solana Agent Kit (SendAI)**, **Faremeter** (OSS agentic-payments
   framework), and the official **Solana x402 Templates** repo.
3b. **Identity/trust layer (from the solana.com/x402 ecosystem, assessed 2026-07-07).**
   - **T54 — investigation RESOLVED 2026-07-10, two actions queued (both outreach, no engineering):**
     (1) **Merchant verification (Sardius):** register SolEnrich at portal.t54.ai (KYB flow). Their
     x402-secure buyer-side proxy risk-scores merchants before agents pay (API health, site legitimacy,
     social sentiment, onchain trust) — unverified merchants risk friction-flags at the trust layer
     Solana's own x402 page showcases. Cheap insurance + trust badge.
     (2) **Data-partnership pitch (email, Sardius w/ Claude draft):** their Trustline risk engine scores
     "agent behavior, transaction patterns, network-wide security signals" — our exact product on
     Solana (behavioral bot-detection, wallet risk scoring, tx-pattern analysis, agent-attention).
     Pitch SolEnrich as upstream onchain-signal provider for their "Onchain Trust" dimension. B2B
     recurring shape; positions our future know-your-agent endpoint as complementary, not competitive.
     Contact: support@t54.ai / portal.t54.ai. Ripple-backed ($5M).
     **Explicitly NOT doing:** swapping to their drop-in facilitator (CDP stays — their buyer-side
     proxy works against any standard x402 merchant); Claw Credit needs nothing from us.
   - **✅ Metaplex 014 Agent Registry — REGISTERED 2026-07-10.** Asset:
     `BjJGP6gptvGFmhtNX5rkjq8KwU5n48QB2thpW7ugmoaf` (MPL Core, owner = agent wallet `66Qvhr…`), tx
     `449x4Xx6AzDnBr9CVkVjiMyVH7YDcSkDCpksFoQ2JNGBhL8Rp8ux3yNX6v2qaHFeUMa3iJPbBikVGesjDfwkAH2t`.
     Metadata: `https://www.solenrich.com/agent-metadata.json` (served from `landing/`, www is
     canonical). Script: `identity/register-metaplex.ts` (one-shot, do not re-run).
   - **ERC-8004 on Base**: register the EVM-side identity (we hold 8004-solana + Metaplex 014 already;
     `@lucid-agents/identity` supports ERC-8004). Discovery layers (incl. XGATE when it returns)
     index ERC-8004-registered agents — completes dual-network citizenship: pay on either chain, verify
     on either chain.
   - **Skipped deliberately:** Corbits (competitor rail to Lucid — check once for a marketplace, don't
     pursue), Privy/CDP Wallet/x402Secure (buyer-side infra, wrong side of the market).
   - **Radar (not now):** "MCP with x402" — payment-gating our `/mcp` surface could turn the MCP channel
     from marketing into revenue.
4. **Then Eris (the demand engine).** Directories make us findable; a public bot posting receipted
   `smart-money-trenches` calls makes us *found*. Suite launch tweet drafted 2026-07-07 (in session log)
   — leads with the vetting-funnel story (32 candidates → 15 bots filtered → 14 vetted seeds, live
   re-checked every scan).

**Verification loop:** `/metrics` `unique_callers` weekly (baseline: 0 organic, all dogfood as of
2026-07-07) + agentic.market presence after step 1 + XGATE re-check (xgate.run had no DNS A record
2026-07-07 — Daydreams' index is offline; revisit when it returns).

**June-recap follow-ups (added 2026-07-08, from the Solana x402 June round-up):**
- **pay.sh listing — NEW TOP DISCOVERABILITY ACTION.** pay.sh = the **Solana Foundation's own**
  agent-payments CLI + curated catalog (`github.com/solana-foundation/pay`), surfaced to agents via a
  Pay MCP (`search_catalog`). **Nansen (60 endpoints) and Birdeye (46) are already in its finance
  category; we are not.** Listing is metadata-only for x402-native APIs (no gateway needed): a
  `PAY.md` + committed `openapi.json` snapshot PR'd to `github.com/solana-foundation/pay-skills`.
  **PR SUBMITTED 2026-07-08: `solana-foundation/pay-skills#176`** (`providers/solenrich/data`,
  category finance, awaiting Foundation review). Note: `pay catalog check` v0.20.0 is broken on
  Windows (path-prefix leak into FQN validation — fails on merged providers too); PR CI on Linux is
  the authoritative validator.
- **Metaplex 014 Agent Registry** — register SolEnrich as an onchain agent (`@metaplex-foundation/
  mpl-agent-registry`, one-tx `mintAndSubmitAgent`). June's identity rail on Solana (OpenCovenant ships
  verifiable action history on it); complements 8004-solana + planned ERC-8004-on-Base.
- **BlockRun gateway** (unified discover/route/pay endpoint, 55+ models/APIs, 10M+ txns) + **OKX AI
  marketplace** (agents hire agents) — investigate inclusion; both are aggregator shelves.
- **Context (the tide):** x402 resource registrations hit ~4,000/day in June vs a May peak of 93;
  AWS pays publishers in stablecoins over x402-on-Solana; 0x, Exa, QuickNode all shipped x402-on-Solana
  products. Supply-side land grab is ON — speed matters.
- **Endpoint candidates surfaced by the recap (scoped, not committed):** (1) **know-your-agent
  intelligence** — "should my agent trust/hire/copy this agent?" — enrich an agent wallet with 014/8004
  registry identity + our behavioral/bot flags + tx history + copy-trade win rate (reuses
  wallet-profiler/labeler/copy-trade; rides the OKX-AI/Hyre/T54 agent-hiring wave). (2) **ClawPump
  trenches leg** — $100M vol / 5,500 agents / 1B tokens launched = agent-native launchpad; extend
  dev-reputation/token-x-ray/smart-money-trenches to ClawPump launches + Eris feed source.
  (3) SIWS holder-gated pricing (mpp32 pattern) — radar, monetization knob not discovery.

### What to deprioritize

- **Raw data breadth.** Don't add endpoints just to have them. Can't out-breadth Helius/Nansen. Out-synthesize them.
- **Dashboards.** No UI. Even a pretty one. Dilutes agent-native positioning.
- **Enterprise sales motion.** Doesn't fit product. Let them come to us.

## Post-Launch Upgrade Roadmap

### Quick Wins
- [x] Upstash Redis for prod caching (2026-03-17)
- [x] Richer 402 response body — pricing, payment instructions, endpoint menu (2026-03-17)
- [x] Hardened enrichment — holder concentration, whale-watch rewrite, risk levels (2026-03-17)
- [x] Entity labeling — known wallets (CEX, protocol, bridge) tagged in all enrichment results (2026-03-21)
- [x] Copy-trade PnL fix — average cost basis instead of FIFO (2026-03-21)
- [x] Query endpoint — NL questions routed to enrichers via keyword matching (2026-03-21)
- [x] Custom domain (2026-04-02)
- [ ] MCP directory submissions (Smithery, mcp.run, Glama) — free distribution to Claude/Cursor users
- [ ] x402 bazaar listing — trigger by making a paid request through the facilitator
- [ ] XGATE registration for agent-to-agent discovery

### Feature Upgrades
- [x] `query` endpoint — accepts freeform NL questions, routes via keyword matching to the right enricher (2026-03-21)
- [ ] Webhook/SSE streaming — real-time whale alerts, token movement notifications (`src/realtime/` scaffolded but empty)
- [ ] Portfolio tracker — historical wallet value over time using Helius tx history + price snapshots
- [x] Token & wallet comparison — side-by-side analysis of 2-3 tokens or wallets with rankings + summary picks (2026-03-30)
- [x] Entity labeling — known entities (CEX, protocol, bridge) tagged in wallet-graph, whale-watch, connected wallets (2026-03-21)

### Critical Bug Fixes
- [x] DeFi position values — estimate USD from token balance changes instead of hardcoded 0 (2026-03-21)
- [x] TX signature schema — widened to min(86)/max(90) to accept all valid sigs (2026-03-21)
- [x] Enhanced txs — fetch all sigs in 100-chunk batches instead of truncating at 50 (2026-03-21)
- [x] Copy-trade prices — parallelized with Promise.allSettled (2026-03-21)
- [x] Holder resolution — retry once on failure, mark unresolved with is_token_account flag (2026-03-21)

### High-Value Additions
- [x] Multi-source price aggregation — median of Helius + DexScreener + Jupiter (2026-03-22)
- [x] Holder concentration entropy — Herfindahl-Hirschman Index (HHI) alongside top-N percentages (2026-03-22)
- [x] Price volatility metrics — daily std, 7d range, LOW/MODERATE/HIGH/EXTREME classification (2026-03-22)
- [x] Risk-adjusted returns for copy-trade — Sharpe, Sortino, max drawdown, profit factor (2026-03-22)
- [ ] Liquidity depth analysis — bid/ask depth, slippage estimates

### Infrastructure
- [ ] Rate limiting — protect upstream APIs, per-IP or per-wallet throttling
- [ ] Usage analytics — track endpoint calls, response times, error rates (Axiom or simple logging)
- [ ] Birdeye API integration — see detailed plan below
- [ ] Test suite in CI — wire existing test files into GitHub Actions
- [x] SolScout consumer agent — stress test + demo + paid E2E verification (2026-04-01)
- [x] Full E2E paid verification — 13/13 endpoints passing with real USDC via x402 (2026-04-01)
- [x] Test-endpoints Claude Code subagent — `.claude/agents/test-endpoints.md` (2026-03-29)
- [x] `test/test-all-endpoints.ts` — 55 endpoint verification tests (2026-03-29)
- [x] `test/test-402-production.ts` — production paywall verification (2026-03-29)
- [x] `GET /docs` — agent-readable documentation endpoint with scoring methodology (2026-03-30)

### MPP Integration (Machine Payments Protocol) — FULL ROLLOUT (2026-04-05)

Dual-protocol payments on all 16 endpoints: MPP (Stripe cards + Solana USDC) alongside x402.

**How it works:**
- When `MPP_SECRET_KEY` + `STRIPE_SECRET_KEY` are set, MPP handles all 16 endpoints
- MPP advertises both Stripe (fiat) and Solana USDC (crypto) via `Mppx.compose`-style multi-method
- x402 middleware stays registered but filters to zero routes (safe no-op)
- When MPP keys are missing (local dev), all endpoints fall back to x402
- Fiat agents pay with cards, crypto agents pay with Solana USDC — same endpoints, client chooses

**Packages:** `mppx@0.5.5`, `@solana/mpp@0.2.0`, `stripe@22.0.0`, `@solana/kit@6.7.0`
**Env vars:** `MPP_SECRET_KEY` (HMAC), `STRIPE_SECRET_KEY` (Stripe API key) — both set in .env + Railway

**Discovery:** `GET /openapi.json` — OpenAPI 3.1.0 with `x-payment-info` per route, input schemas, `x-service-info`. Validated by `npx mppx discover validate`. AgentCash discovers all 19 routes.

**Docs:** `docs/mpp_docs.txt` (full llms-full.txt from mpp.dev) | SDK: `mppx` (npm) | GitHub: wevm/mppx

**Completed:**
- [x] MPP Stage 1 — Stripe on 3 endpoints (2026-04-03)
- [x] OpenAPI discovery endpoint — `/openapi.json` validated by mppx CLI (2026-04-05)
- [x] Expanded MPP to all 16 endpoints (2026-04-05)
- [x] `@solana/kit` upgraded 5.5.1 → 6.7.0 — tested in worktree, zero breakage (2026-04-05)
- [x] Solana MPP enabled — `solanaMpp.charge()` with USDC mint, mainnet, Helius RPC (2026-04-05)

**Next steps for MPP:**
1. Test Stripe payment E2E with a real card (~$0.001 via `npx mppx pay`)
2. Register on MPPScan (mppscan.com) — discovery is live
3. Fix minor AgentCash warnings (legacy x-payment-info format, free route auth modes)
4. Add MPP payment info to /docs endpoint and landing page
5. Update SolScout with MPP client mode (`--paid-mpp` flag)
6. Submit to MCP directories (Smithery, mcp.run, Glama)

### Birdeye API Integration (planned)

**Pricing:** https://bds.birdeye.so/pricing | **Docs:** https://docs.birdeye.so
**Client already written:** `src/sources/birdeye.ts` — needs API key in `BIRDEYE_API_KEY` env var.

**Phase 1 — Free tier ($0/mo, 1 rps):**
- Token holder counts via `/defi/v3/token/holder` — fixes holder_count=0 on mega-cap tokens (JUP, USDC, etc.)
- OHLCV price data — improves volatility calculations beyond DexScreener's multi-timeframe estimates
- 1 rps is fine with our caching (60s-300s TTL per token)
- **Endpoints improved:** enrich-token-light, enrich-token-full, due-diligence, compare-tokens, token-trend, new-tokens

**Phase 2 — Lite tier ($39/mo, 15 rps):**
- Token security metadata (`/defi/token_security`) — honeypot detection, trading restrictions. Feeds into risk flags.
- Wallet portfolio (`/v1/wallet/token_list`, beta) — accurate USD values per holding instead of Helius+price estimation
- **Endpoints improved:** enrich-wallet-light, enrich-wallet-full, compare-wallets, wallet-history, copy-trade-signals, whale-watch

**Integration work:** Minimal — Birdeye client exists, enrichers already accept Birdeye data. Main tasks:
1. Add `getTokenHolderCount()` to birdeye.ts, call in token-analyzer parallel fetch
2. Add `getTokenSecurity()` to birdeye.ts, feed flags into risk-scorer
3. Re-enable `getWalletPortfolio()` in wallet-profiler (currently bypassed)
4. Set `BIRDEYE_API_KEY` in .env + Railway

**Not changed by Birdeye:** Transaction parsing, wallet graph, risk scoring logic (pure functions), LLM formatting

### Distribution / Growth
- [ ] Agent-to-agent integrations — partner with trading agents that need enrichment data
- [ ] SDK/client package — `npm install @solenrich/client` for easy integration
- [ ] Social launch — Twitter thread, Farcaster, Solana ecosystem channels

### Considered Expansions (assessed 2026-03-26)

Six features to deepen SolEnrich's core value prop: getting solid Solana data to agents/LLMs.

**Priority 1 — Multi-Entity Comparison** — DONE (2026-03-30)
- [x] `compare-tokens`, `compare-wallets` endpoints shipped
- [x] Side-by-side rankings per metric, summary picks (safest, most liquid, etc.)
- [x] LLM briefing with markdown tables
- [x] $0.006 USDC per comparison, 13 total endpoints now

**Priority 2 — Temporal Context / "What changed?"** — DONE (2026-04-02)
- [x] `token-trend`, `wallet-history` endpoints shipped
- [x] SnapshotStore: daily snapshots captured fire-and-forget on every enrichment call (no cron needed)
- [x] Cache: mget (batch retrieval) + setIfAbsent (NX) methods added
- [x] Direction indicators: improving/declining/stable per metric + overall direction
- [x] Position change tracking for wallets (added/removed holdings)
- [x] 30-day TTL on snapshots, data accumulates over time
- [x] $0.006 USDC per call, 15 total endpoints now

**Priority 3 — New Token Discovery** — DONE (2026-04-02)
- [x] `new-tokens` endpoint shipped
- [x] DexScreener getLatestProfiles() → filter → enrich in parallel batches of 5 → risk score → rank safest first
- [x] Filters: min_liquidity_usd, max_risk_score, limit
- [x] $0.012 USDC per call, 16 total endpoints now

**Priority 4 — Protocol Analytics** — DONE (2026-04-08)
- [x] `protocol-profile` endpoint shipped — TVL, yields, on-chain activity, health signals
- [x] 8 protocols in static registry (Raydium, Orca, marginfi, Drift, Jupiter, Kamino, Marinade, Jito)
- [x] Dynamic DeFi Llama fallback for unlisted protocols
- [x] Helius signature scanning (2 pages, 200 sigs) for activity metrics
- [x] Health signals: TVL tier, yield attractiveness, activity level
- [x] DeFi Llama client activated (was built but unwired)
- [x] Lightweight /tvl/ endpoint + 8s abort fallback for large /protocol/ responses
- [x] $0.008 per call, 30min cache. 17 total endpoints now.

#### Phase 2A — Deepen Intelligence (next 2-3 sessions)

**Priority 5 — Automated Activity Signals / Agentic Behavior Detection** — DONE (2026-04-10)
- [x] Four behavioral flags added to labeler: `regular_intervals` (CV < 0.3), `high_frequency` (20+ tx/hr sustained), `24_7_active` (no 6h gaps over 48h+ window), `repetitive_actions` (>70% same tx type)
- [x] Detection functions exported from `src/enrichers/labeler.ts` as pure functions (`detectRegularIntervals`, `detectHighFrequency`, `detect247Active`)
- [x] `wallet-profiler.ts` passes `tx_timestamps` + `tx_type_counts` to the labeler; flags appear in every wallet enrichment output
- [x] `protocol-analyzer.ts` computes `automated_activity_pct` — % of top signers exhibiting `detectRegularIntervals || detectHighFrequency`. Drift showed 25%, Raydium 0% on initial run — real differentiated signal.
- [x] Commit: `a27edf7` (2026-04-10)
- **Design decision:** Frame as behavioral signals, not bot/human classification. Binary classification ~60-70% accuracy isn't reliable enough. Consumer interprets the flags.
- **Use case:** "Agentic ponzis" thesis — agents/bots driving perpetual DeFi protocol activity. Traders/researchers see what % of protocol volume is agent-driven.
- **Bookkeeping miss 2026-04-22:** Functional layer shipped 12 days ago but LLM formatters, `/docs`, OpenAPI descriptions, and unit tests never got caught up. Remaining polish work tracked as Tasks #19, #22, #23.

**Priority 6 — Slippage Estimates / Liquidity Depth** — DONE
- [x] `getSlippageEstimates(mint)` added to JupiterClient — sequential USDC→token quotes at $100/$1K/$10K/$100K via Jupiter Quote v1 with 50bps slippage tolerance, results cached (jupiterPrice TTL)
- [x] TokenAnalyzer parallel fetch includes slippage, exposed as `slippage_estimates` on TokenEnrichment
- [x] LLM formatter renders price-impact table + worst-case callout in token briefings
- [x] Auto-flows through enrich-token-light, enrich-token-full, due-diligence, compare-tokens, new-tokens, token-trend (anything that uses TokenAnalyzer)
- [x] /docs + OpenAPI + MCP tool descriptions updated to advertise slippage (2026-05-12 polish pass)
- **Bookkeeping note:** Functional layer was shipped in an earlier session but never marked DONE. Same shape as the Priority 5 miss caught 2026-04-22. Closeout polish landed 2026-05-12.
- **Future expansion (Phase 2B+):** Full order book depth via Birdeye Lite ($39/mo) for pool-by-pool breakdown — remains open as the deeper version of this feature.

**Priority 7 — Birdeye Integration (free tier)** — DONE (2026-04-14)
- [x] `getDailyCandles(mint, days)` added to BirdeyeClient — `/defi/ohlcv?type=1D` with time_from/time_to
- [x] BirdeyeClient instantiated in agent.ts (only when `BIRDEYE_API_KEY` set), passed to TokenAnalyzer
- [x] TokenAnalyzer parallel fetch now includes `birdeyeOverview` + `birdeyeCandles`
- [x] `holder_count` uses Birdeye `overview.holder` (real count) — fallback to RPC top-20 length when missing. Verified: BONK 999K, JUP 837K, USDC 6.5M.
- [x] Volatility prefers Birdeye daily candles (real OHLCV) — fallback to DexScreener multi-timeframe estimate
- [x] Price/symbol/name/marketCap/volume/liquidity also fall back to Birdeye if DexScreener fails
- **Endpoints improved (automatic via TokenAnalyzer):** enrich-token-light, enrich-token-full, due-diligence, compare-tokens, token-trend, new-tokens

**Priority 8 — Proprietary Signal Capture** (1 session)
- Request analytics as a data asset: per-endpoint call counts, unique tokens/wallets queried, query frequency per token
- Redis INCR counters per endpoint per day — near-zero overhead (~20 lines middleware)
- Surface via internal `GET /metrics` endpoint (not public initially)
- Enables "consensus signal" detection: N distinct agents querying same token in short window = leading indicator
- **Why now:** Cheap to build, compounds immediately. Every day without it is lost data.
- Feasibility: High

#### Phase 2B — Expand Orchestration (3-5 sessions)

Orchestration = composed endpoints that chain multiple enrichers together. Worth more than the sum of parts because agents get synthesized intelligence instead of raw data they'd have to reconcile themselves. Justifies higher pricing ($0.05-$0.10 per call).

**Priority 9 — Aggregated Intelligence / Smart Money** (2-3 sessions)
- `trending-signals` — orchestrates new-tokens + due-diligence + whale-watch across multiple tokens. "What's worth paying attention to right now?" Scans DexScreener trending as input, enriches top candidates, ranks by composite signal.
- `smart-money-flow` — orchestrates whale-watch + copy-trade-signals + wallet-graph across high-performing wallets. "Where is smart money moving?" Identifies smart wallets (copy-trade win rates), tracks their flows (whale-watch), maps connections (graph).
- Reuses: whale-watch, due-diligence, copy-trade, wallet-graph, DeFi Llama, PriceAggregator
- Blocker: No "scan all tokens" API — needs curated watchlist or DexScreener trending as input
- Feasibility: Medium — builds on temporal + discovery features

**Priority 10b — Perps Cross-Venue Funding** — DONE (2026-05-19)
- [x] `src/sources/adrena.ts` — AdrenaClient reading main-pool custodies (USDC, BONK, jitoSOL, WBTC) via fixed-offset Borsh decoding. Skips Anchor 0.30 IDL conversion (incompatible with our pinned 0.29). Offsets verified against `@adrena/abi v2.1.0-release39` by reading all 4 custodies live — decimals, is_stable, last_update, and OI ratios all matched expected values.
- [x] `src/sources/perp-reference.ts` — PerpReferenceClient for Hyperliquid (`POST /info` metaAndAssetCtxs) + dYdX v4 (`GET /v4/perpetualMarkets`). **Swapped from Binance/Bybit (originally planned)** — both CEXes geoblock US IPs (Binance 451, Bybit CloudFront 403). Hyperliquid + dYdX are open, no geo issues, crypto-native (better thematic match).
- [x] `src/enrichers/perps-cross-venue.ts` — PerpsCrossVenueAnalyzer. Aggregates Jupiter + Adrena + reference into venue quotes, best-entry-per-side, basis vs Hyperliquid (bps), arbitrage opportunities (>5pt APR spread). Symbol mapping: SOL→jitoSOL on Adrena, BTC→WBTC on Adrena, ETH→Adrena unavailable, BONK→Jupiter unavailable.
- [x] Schema (`src/schemas/perps-cross-venue.ts`), formatter (`src/formatters/llm-perps-cross-venue.ts`), entrypoint, MCP tool (`perps_cross_venue_funding`), OpenAPI, /docs all wired.
- [x] Live verified on SOL/BTC/ETH/BONK. Cold 947ms, warm 145-260ms. Real arbitrage surfaced (BTC: Jupiter 11.57% vs Adrena 1.46% = 10.11pt spread).
- **Pricing:** $0.015 per call. **20 total paid endpoints.**
- **Adrena scaling gotchas (logged for future use):**
  - `current_rate` is per-hour, scaled by `RATE_POWER = 1e9` — multiply by 24×365 for APR. **Opposite of Jupiter's annualized scaling.**
  - USD amounts (`size_usd`, `collateral_usd`) use 6-decimal USDC convention.
  - No native SOL/BTC/ETH custodies — wrapped only (jitoSOL, WBTC, BONK). ETH not available on Adrena mainnet at all.
  - Closed positions reaped (unlike Jupiter where filter `size_usd > 0` is required).
- **Cross-venue endpoint design — additive:** each new venue is a `VenueQuote` entry with `available: bool` and `unavailable_reason`. `best_entry`/`arbitrage_opportunities` recompute automatically. Adding Phoenix Perps and Bullet (when they launch publicly) is a one-file change to extend the source client list.
- **Unblocks:** #2 `perps-venue-comparison`, #3 `perps-basis-signal`, #5 `perps-market-trend` (all 1-session adds composing this foundation).
- **Phase 2D status (as of 2026-05-27):** #1 cross-venue-funding DONE 2026-05-19 (`ed4ce1d`), #2 venue-comparison DONE 2026-05-21 (`908d10b`), #3 basis-signal DONE 2026-05-21 (`7a7afa4`), #4 perp position alerts on `check-alerts` DONE 2026-05-25 (`05bdcd0`), #5 perps-market-trend DONE 2026-05-26 (`e999258`), Adrena trader-profile coverage DONE 2026-05-27 (`0c39092`). Only #6 liquidation-risk-map deferred per original plan. Last follow-on closeout: Adrena OI cap decode (~½ session) for `venue-comparison` headroom field.

**Priority 10 — Perps Intelligence / Jupiter Perps Integration** — DONE (2026-04-18)
- [x] `@coral-xyz/anchor@0.29.0` installed (0.32+ uses new IDL format, reference IDLs are v0.29)
- [x] Jupiter Perps + Doves IDLs copied to `src/idl/`
- [x] `src/sources/jupiter-perps.ts` — JupiterPerpsClient reading on-chain Anchor accounts: `getMarketStructure()` (3 custodies, borrow APR via jump-rate curve, OI from `guaranteedUsd`/`globalShortSizes`, Doves oracle mark prices) + `getPositionsForWallet()` (getProgramAccounts memcmp owner filter, PnL from mark - entry)
- [x] `src/enrichers/perps-analyzer.ts` — market risk flags (extreme_skew, high_utilization, near_oi_cap, elevated_borrow_rate), headroom, HEALTHY/TILTED/STRESSED health; trader classification (scalper/swing/position), directional bias, position-level flags (high_leverage, approaching_liquidation, stale)
- [x] `src/formatters/llm-perps.ts` — market structure + trader profile briefings
- [x] `src/entrypoints/perps.ts` — `perps-market-structure` ($0.012) + `perps-trader-profile` ($0.010)
- [x] Registered in agent.ts, MCP tools (`perps_market_structure`, `perps_trader_profile`), OpenAPI spec, /docs
- [x] Live tested: SOL $86 / BTC $75.8K / ETH $2.35K, total OI ~$80M, borrow APRs 10-12%, 19 total endpoints now
- **Scaling gotchas discovered during build:** `targetUtilizationRate` scaled by RATE_POWER (1e9) NOT BPS_POWER. Jump-rate bps values are ANNUALIZED APR (1000=10% APR, 3500=35%, 15000=150%), NOT hourly. Do not multiply by 24×365.
- **Phase 2 expansion (next quarter):** Fold in Adrena, Zeta, Mango for cross-venue perps aggregation
- **Drift:** Do NOT integrate until relaunches with post-mortem + security assurances

**Priority 10 (original plan, archived) — Perps Intelligence / Jupiter Perps Integration** — PIVOT from Drift 2026-04-14
- **Context:** Drift hacked 2026-04-01 for $285M via DPRK durable-nonce exploit. TVL collapsed $550M → <$250M. `data.api.drift.trade` returns 404. Operations paused, no relaunch date. Perps traders/agents rotated to Jupiter Perps, Adrena, Zeta, Mango, bridged Hyperliquid.
- **New venue:** Jupiter Perps is now the dominant Solana perps DEX. Free API (extend existing `src/sources/jupiter.ts`). Smaller market scope than Drift (SOL, ETH, BTC initially) but the buyer segment has moved here.
- **Thesis:** Perps agents remain highest-frequency data consumers. Post-hack, perps *risk* intelligence is more valuable than before — agents need to know which venues are safe, what funding looks like, where liquidations cluster.
- **Scope (start small):**
  - Extend JupiterClient with perps methods (positions API, markets API)
  - `perps-market-structure` endpoint (~$0.012) — funding rate, OI, recent liquidations, basis vs spot oracle
  - `perps-trader-profile` endpoint (~$0.010) — wallet's Jupiter Perps history, PnL, win rate, position sizing
  - Defer `perps-signals` orchestration until market structure + trader profile are validated
- **Phase 2 expansion (next quarter):** Fold in Adrena, Zeta, Mango for cross-venue perps aggregation — arguably more valuable than Drift-only would have been.
- **Drift:** Do NOT integrate until protocol relaunches with post-mortem + security assurances. Keep program ID in known-protocols registry for labeling wallets that historically interacted.
- Reuses: existing JupiterClient, PriceAggregator (for basis), protocol-profile
- Feasibility: High — tighter scope than original Drift plan, one provider, extends existing client

**Jupiter Perps technical notes (research 2026-04-15):**
- **No REST API.** All data lives in on-chain Anchor accounts. Access via `@coral-xyz/anchor` Program + IDL, or raw Borsh decode.
- **Program ID:** `PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu`
- **JLP Pool PDA:** `5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq`
- **Custody PDAs (static constants, not derived):** SOL `7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz`, BTC `5Pv3gM9JrFFH883SWAhvJC9RPYmo8UNxuFtv5bMMALkm`, ETH `AQCGyheWPLeo6Qp9WpYS9m3Qj479t7R636N9ey1rEjEn`, USDC `G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa`, USDT `4vkNeXiYEUizLdrpdPS1eC2mccyM4NUPRtERrk6ZETkk`. Only SOL/BTC/ETH are tradable.
- **Oracle (Doves):** `DoVEsk76QybCEHQGzkvYPWLQu9gzNoZZZt3TPiL597e`
- **IDL source of truth:** https://github.com/julianfssen/jupiter-perps-anchor-idl-parsing — copy `src/idl/jupiter-perpetuals-idl.ts` + constants.
- **No funding rate — uses borrow fees instead.** Hourly compounding. Two mechanisms: Linear (`hourlyFundingDbps`) or Jump (utilization curve with `minRateBps`/`targetRateBps`/`maxRateBps`/`targetUtilizationRate`). `getBorrowApr()` derives annualized rate from custody state.
- **Open interest directly readable:** `custody.assets.guaranteedUsd` = total longs, `custody.assets.globalShortSizes` = total shorts.
- **Positions by wallet:** `connection.getProgramAccounts(PERPS_PROGRAM, { filters: [{ memcmp: { offset: 8, bytes: walletAddress }}, { memcmp: program.coder.accounts.memcmp("position") }] })`. Filter results by `sizeUsd > 0` — closed positions are not reaped.
- **Liquidations are events, not an account.** Requires parsing transaction logs via event authority `37hJBDnntwqhGbK7L6M1bLyvccj4u55CCUiLPdYkiqBN`. Defer to later phase.
- **Scale constants:** `RATE_POWER = 1_000_000_000`, `BPS_POWER = 10_000`, `DBPS_POWER = 100_000`, `USDC_DECIMALS = 6`, `JLP_DECIMALS = 6`.
- **Install:** `bun add @coral-xyz/anchor` (not yet installed). Can share existing Helius RPC URL.

**Priority 11 — Smarter Query Endpoint** (1 session)
- Upgrade `query` to chain multiple enrichers per question
- "Should I buy BONK?" → due-diligence + token-trend + whale-watch, unified answer
- "Where should I put $10K?" → protocol-profile + trending-signals + slippage estimates
- "What's the SOL-PERP funding rate?" → perps-market-structure
- Agent calls one endpoint, SolEnrich orchestrates 3-5 internally. Highest orchestration value.
- Reuses: all existing enrichers via keyword routing
- Feasibility: High — extend existing query router with multi-step chains

**Priority 12 — Portfolio Tracker** (1 session)
- `portfolio-history` endpoint — returns full time series of wallet portfolio value from temporal snapshots
- Input: `{ address, period: "7d" | "14d" | "30d" }`. Output: array of `{ date, portfolio_value_usd, sol_balance, token_count, risk_score }` per snapshot day
- 80% built via existing SnapshotStore + wallet-history infrastructure. This just returns the raw series instead of a two-point comparison.
- Start with raw snapshots (gaps = wallet wasn't queried that day). Density improves as usage grows.
- Pricing: $0.006 (same as wallet-history)
- Feasibility: High — composition of existing temporal infra

#### Phase 2C — Sticky Infrastructure (5-7 sessions)

**Priority 13 — Event-Driven Alerts** (3-4 sessions)
Build order: poll-based → SSE → webhooks. Same underlying detection engine, different delivery.
- **Step 1: `check-alerts` (poll-based)** — DONE 2026-05-13. Spot alerts: price spikes, risk changes, whale flows, concentration shifts, portfolio value changes, position add/remove. **Phase 2D #4 extension DONE 2026-05-25** (`05bdcd0`): added five Jupiter Perps event types per wallet — `perp_position_added`, `perp_position_closed`, `perp_at_risk`, `liquidation_approaching`, `pnl_swing`. Plus three new criteria knobs (`perp_max_leverage`, `perp_min_pnl_swing_pts`, `perp_liquidation_buffer_pct`). Verified live against known perps trader. $0.008/call.
- **Step 2: `subscribe-alerts` (SSE)** — Persistent server-sent events stream. Agent opens connection, receives alerts in real-time. Needs streaming infra in `src/realtime/`. ~$0.01/hour.
- **Step 3: `webhook-register`** — Agent registers a callback URL + alert criteria. SolEnrich POSTs to it when triggered. Needs: webhook registry in Redis, polling loop, HTTP callback client. ~$0.005 to register.
- Reuses: whale-watch, token-analyzer, protocol-profile, jupiter-perps for detection logic
- **Revenue model shift:** One-shot calls → subscriptions. Stickiest feature.

**Priority 14 — Intelligence Feed / Proactive Scanning** (staged V1 → V2)
- Turns SolEnrich from passive tool (agents call us) to signal source (agents listen to us). **Recurring-revenue model**, stickiest feature in the roadmap.
- **Why this matters:** Hardest thing to clone. Requires temporal data + scoring + orchestration that only exists inside SolEnrich. Incumbents can't easily replicate because their data models are dashboard-first, not streaming-first.
- Own agents (Pythia, Tidal, Cardex) are first consumers — proves the model, dogfoods the data.

**V1 — Daily Brief (1-2 sessions, ~$0 marginal/mo)**
- Daily cron scans `new-tokens` top 20, runs `due-diligence` on anything above $10K liquidity
- Stores result in Redis with 24h TTL, served via `GET /feed/latest` (JSON)
- Upstream cost: 300-500 calls/day — fits Helius Pro plan + Birdeye free tier with aggressive caching
- Infra cost: ~0 marginal. Railway background cron adds ~1% CPU. Redis writes well under free tier 10K/day.
- Revenue potential: $0.005/poll or $5-20/mo per subscriber. 3 subscribers = breakeven. 20 = material revenue.
- **Ship this first. Validate demand before committing to V2.**

**V2 — Live Intelligence Feed (3-5 sessions, ~$30-40/mo marginal)**
- Hourly scans (×24 V1 traffic), SSE streaming endpoint, webhook delivery for whale alerts + risk-score changes
- Upstream cost: $0-40/mo (Helius Pro likely covers; Birdeye Lite at $39/mo if we want per-scan Birdeye calls without rate-limits)
- Infra: Railway compute bump $10-20/mo (persistent SSE connections), Upstash upgrade $0-10/mo, bandwidth ~$5/mo
- Revenue potential: $10-50/mo per SSE subscriber, $5 per webhook registration. Much stickier than one-shot calls.
- **Trigger for V2 build:** 10+ agents polling V1 daily within 2 weeks of launch = PMF signal.

- Reuses: new-tokens, due-diligence, protocol-profile, automated activity signals, temporal snapshots, signal capture (consensus detection)
- Feasibility: V1 High (1-2 sessions). V2 Medium (3-5 sessions + infra coordination).

**V1 validation gate — PARKED 2026-05-24, not resolved.** Investigation findings:
- The gate as written ("≥10 distinct pollers/day") requires per-caller tracking. Current `/metrics` middleware (`src/lib/agent.ts:237-284`) counts total calls per endpoint per day — no payer address recorded. Need ~20-line middleware addition to a `metrics:callers:{endpoint}:{date}` set before the gate can resolve.
- `/metrics` was also returning 0 across all endpoints for the 7 days preceding the check despite known stress runs. Either Upstash was cleared or the silent `.catch(() => {})` is masking write failures. See CHECKPOINT.md Known Bugs.
- Only usable external data was Orbis public marketplace API: **19 total paid calls across all 28 endpoints since 2026-04-21** (~0.58/day site-wide). Per-endpoint breakdown locked behind `/api/provider/*` (401 — seller dashboard login required). x402scan public tRPC API only exposes server metadata, no transactions/payers.
- Sardius posted the Feed V1 launch tweet only just before this investigation. Decision was to **park, not kill**, because the gate was designed to falsify *demand* but what's actually been falsified is *distribution timing*.
- **Reopen criteria:** ship caller-tracking middleware + fix /metrics + give the launch tweet 2 weeks to land. Re-run gate with real numbers.

**Priority 15 — SDK/Client Package** (1-2 sessions)
- `npm install @solenrich/client` — typed TypeScript client
- Auto-payment (x402 or MPP), typed responses matching Zod schemas, streaming support for alerts
- Lowers integration friction to near-zero for new agent builders
- Feasibility: High — generate from existing Zod schemas + OpenAPI spec

#### Phase 2D — Distribution (ongoing, parallel to everything)

- [ ] MCP directories (Smithery, mcp.run, Glama) — free distribution to Claude/Cursor users
- [ ] x402 bazaar + MPPScan registration — agent-to-agent discovery
- [ ] Agent framework partnerships — get recommended in Daydreams/Eliza docs
- [ ] Own agents as proof points — Pythia, Tidal, Cardex, Bags agent publicly using SolEnrich
- [ ] Social launch — Twitter thread, Farcaster, Solana ecosystem channels

### Potential Integrations (pending API access / partnerships)

**tokens.xyz — RWA Token Data** (conditional on API access)
- **What:** tokens.xyz aggregates tokenized real-world assets on Solana — 219 stocks, 24 ETFs, 15 treasuries, 14 currencies, 4 metals as SPL tokens
- **Integration value:**
  - Wallet profiler labels RWA holdings properly ("Tokenized Apple Inc. stock") instead of unknown token
  - Risk scorer weights RWA holdings as lower-risk — wallet with 60% treasuries ≠ 60% memecoins
  - New discovery angle: "what tokenized stocks just launched on Solana?" for DeFi/portfolio agents
  - Portfolio categorization: crypto vs RWA vs stablecoin breakdown per wallet
- **First-implementer opportunity:** New platform, no enrichment service integrates their data yet
- **Status:** No public API docs. Tweeted from @solenrichHQ requesting API access (2026-04-10). Waiting for response.
- **Blocker:** Need API documentation and access before scoping work

**@solana-commerce / Solana Developer Platform (SDP)** (watchlist)
- **What:** Official Solana payments toolkit — `@solana-commerce/headless` (payment flow primitives), `@solana-commerce/sdk` (React hooks), `@solana-commerce/solana-pay` (QR/payment links). SDP is the enterprise API (Mastercard, Worldpay, Modern Treasury partners).
- **Opportunity:** SolEnrich as payment risk intelligence — "is this receiving wallet legitimate?", "what's the counterparty risk?" Same endpoints, positioned for payment processors and fintechs building on SDP. No new code needed, just distribution.
- **Status:** Watching. No integration needed yet — evaluate if SDP opens payment flow query APIs.

**Kora — Gasless Transactions** (watchlist)
- **What:** Enables USDC transfers without the sender holding SOL for fees. Sponsor covers ~$0.001 gas.
- **Opportunity:** Lowers friction for new agent consumers who don't have SOL. Cost is negligible against endpoint pricing.
- **Status:** Watching. Evaluate when agent onboarding friction becomes a measurable problem.

### Moonshots
- [ ] Multi-chain expansion — Base/Ethereum enrichment using same architecture (10x TAM)
- [ ] Reputation-gated pricing — cheaper rates for agents with high 8004 reputation scores
- [ ] On-chain analytics dashboard — frontend showing live usage, top queried wallets/tokens
- [ ] Outcome correlation loop — track whether agents that query risk scores make better decisions (partial signals: re-query patterns, whale-watch spikes after DD calls). Feedback loop that improves scoring over time.
- [ ] Full liquidity depth — Birdeye Lite ($39/mo) for pool-by-pool order book depth, bid/ask spread analysis
- [ ] Birdeye Lite tier ($39/mo) — token security metadata (honeypot detection) + wallet portfolio (accurate USD per holding)
