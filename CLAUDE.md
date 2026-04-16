# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Workflow Rules

- **Commit and push after each feature or modular change.** Don't let work accumulate uncommitted — each phase, feature, or logical unit of work should be committed and pushed before moving on.

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

## Bags Hackathon Submission

- **Hackathon:** [The Bags Hackathon](https://bags.fm/hackathon) — $4M funding, $1M in grants to 100 winners ($10K-$100K each)
- **Track:** AI Agents (also relevant: Payments, DeFi, Claude Skills)
- **Status:** SUBMITTED
- **Requirements:** Working product with real users/transactions, uses Bags token/API/fee-sharing, or is a verified onchain project
- **Judging:** Product traction (MRR, DAU, GitHub stars) + onchain performance (volume, active traders, revenue)
- **Partners/Judges:** Solana, Helius, Meteora, Privy, DFlow, Birdeye
- **Submit at:** https://bags.fm/apply | Questions: apps@bags.fm

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

**Priority 5 — Automated Activity Signals / Agentic Behavior Detection** (1-2 sessions)
- Add behavioral flags to wallet labeler: `regular_intervals`, `high_frequency`, `24_7_active`, `repetitive_actions`
- Detection logic: analyze tx timestamps from enhanced transactions for regularity (std deviation of intervals), frequency (tx/hr), sleep gaps (>6hr breaks), and action repetition (same type+amount patterns)
- Surface flags in: wallet-profiler labels, copy-trade-signals, wallet-graph nodes, protocol-profile unique_signers
- New protocol-level metric: `automated_activity_pct` — % of unique signers exhibiting automated behavior flags
- No new endpoints needed — enriches existing endpoints with richer behavioral data
- Reuses: existing Helius enhanced tx parsing, labeler (pure function addition), wallet-profiler
- **Use case:** "Agentic ponzis" thesis — agents/bots driving perpetual DeFi protocol activity. Traders/researchers want to know what % of a protocol's volume is agent-driven, and whether specific wallets are bots or humans.
- **Design decision:** Frame as behavioral signals, not bot/human classification. ~60-70% accuracy on binary classification isn't reliable enough to label definitively. Let consumers interpret the flags.
- Feasibility: High — 3-4 new labeler rules + protocol-analyzer metric. No new data sources needed.

**Priority 6 — Slippage Estimates / Liquidity Depth** (1 session)
- Add `slippage_estimate` field to token-light, token-full, due-diligence, compare-tokens responses
- Use Jupiter Quote API (`GET /quote`) — already routes across all Solana DEX pools, returns expected output for given input
- Query at 4 position sizes ($100, $1K, $10K, $100K), report price impact at each
- Add `getQuote(inputMint, outputMint, amount)` method to existing Jupiter client in `src/sources/jupiter.ts`
- **Value:** Trading agents need "what's my slippage at this size?" before entering positions. No other enrichment API provides this.
- **Future expansion (Phase 2B+):** Full order book depth via Birdeye Lite ($39/mo) for pool-by-pool breakdown
- Feasibility: High — one new Jupiter client method + add to token-analyzer parallel fetch

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

**Priority 10 — Perps Intelligence / Jupiter Perps Integration** (1-2 sessions) — PIVOT from Drift 2026-04-14
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
- **Step 1: `check-alerts` (poll-based)** — Agent calls periodically, gets alerts since last check. No persistent connections, no infra overhead. Alerts: whale movements, price spikes >X%, risk score changes, new token launches matching criteria. Store alerts in Redis with TTL. ~$0.003/call.
- **Step 2: `subscribe-alerts` (SSE)** — Persistent server-sent events stream. Agent opens connection, receives alerts in real-time. Needs streaming infra in `src/realtime/`. ~$0.01/hour.
- **Step 3: `webhook-register`** — Agent registers a callback URL + alert criteria. SolEnrich POSTs to it when triggered. Needs: webhook registry in Redis, polling loop, HTTP callback client. ~$0.005 to register.
- Reuses: whale-watch, token-analyzer, protocol-profile for detection logic
- **Revenue model shift:** One-shot calls → subscriptions. Stickiest feature.

**Priority 14 — Intelligence Feed / Proactive Scanning** (3-4 sessions)
- SolEnrich scans `new-tokens` on a schedule, runs due-diligence on anything above liquidity threshold
- Publishes daily "SolEnrich Intelligence Brief" — scored tokens, flagged protocols, behavioral anomalies
- Feed endpoint: `GET /feed/latest` (JSON) or SSE stream for real-time subscribers
- Own agents (Pythia, Tidal, Cardex) are first consumers — proves the model, dogfoods the data
- Turns SolEnrich from a passive tool agents call into a signal source agents listen to
- Reuses: new-tokens, due-diligence, protocol-profile, automated activity signals, temporal snapshots, signal capture (consensus detection)
- **Why this matters:** Hardest thing to clone. Requires temporal data + scoring + orchestration that only exists inside SolEnrich.
- Feasibility: Medium — scheduling infra + feed format + first-consumer integration

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
