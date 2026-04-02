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
- [x] `src/lib/agent.ts` — all 15 entrypoints registered (5 core + 5 premium + query + 2 comparison + 2 temporal)
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
- **Remote URL:** `https://solenrich-production.up.railway.app/mcp`
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
- [ ] Birdeye API key — unlocks wallet portfolio endpoint and richer token data
- [ ] Test suite in CI — wire existing test files into GitHub Actions
- [x] SolScout consumer agent — stress test + demo + paid E2E verification (2026-04-01)
- [x] Full E2E paid verification — 13/13 endpoints passing with real USDC via x402 (2026-04-01)
- [x] Test-endpoints Claude Code subagent — `.claude/agents/test-endpoints.md` (2026-03-29)
- [x] `test/test-all-endpoints.ts` — 55 endpoint verification tests (2026-03-29)
- [x] `test/test-402-production.ts` — production paywall verification (2026-03-29)
- [x] `GET /docs` — agent-readable documentation endpoint with scoring methodology (2026-03-30)

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

**Priority 3 — New Token Discovery** (2 sessions)
- `new-launches`, `token-screener` endpoints
- DexScreener recently created pairs → filter by creation time → run due-diligence pipeline → ranked list
- Reuses: due-diligence, token-analyzer, whale-watch, risk-scorer
- Blocker: No direct "new pools" API — DexScreener search or Helius searchAssets with creation filter needed
- Feasibility: Medium-High — killer feature for trading agents

**Priority 4 — Protocol Analytics** (1-2 sessions)
- `protocol-profile` endpoint
- DeFi Llama TVL + yields, Helius signature scanning on program IDs for user/tx counts
- Reuses: DeFi Llama client, Helius, risk-scorer
- Blocker: Rate-heavy on popular programs — needs aggressive caching (30min+ TTL)
- Feasibility: High

**Priority 5 — Aggregated Intelligence / Smart Money** (2-3 sessions)
- `trending-signals`, `smart-money-flow` endpoints
- Scan top holders across multiple tokens, aggregate whale-watch data, rank by activity
- Reuses: whale-watch, due-diligence, DeFi Llama, PriceAggregator
- Blocker: No "scan all tokens" API — needs curated watchlist or DexScreener trending as input
- Feasibility: Medium — builds on temporal + discovery features

**Priority 6 — Event-Driven Data / Alerts** (3-4 sessions)
- `subscribe-alerts` (SSE) or `check-alerts` (poll-based) endpoints
- Build realtime infra in `src/realtime/` (currently empty) — polling loop + threshold detection + SSE streaming
- Reuses: whale-watch, token-analyzer
- Blocker: Realtime infrastructure from scratch. Start with poll-based, upgrade to SSE later.
- Feasibility: Medium — highest effort, stickiest feature, save for after core expansions

### Moonshots
- [ ] Multi-chain expansion — Base/Ethereum enrichment using same architecture
- [ ] Reputation-gated pricing — cheaper rates for agents with high 8004 reputation scores
- [ ] On-chain analytics dashboard — frontend showing live usage, top queried wallets/tokens
