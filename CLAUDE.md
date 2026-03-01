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
- [ ] Still need: Birdeye API key, Upstash Redis credentials (optional for dev)

### Phase 1: Core infrastructure — DONE
- [x] `src/config.ts` — CONFIG (env vars), PRICING (USDC decimal strings), CACHE_TTL (seconds)
- [x] `src/schemas/common.ts` — FormatSchema, DepthSchema, SolanaAddressSchema, TxSignatureSchema, TimestampSchema
- [x] `src/cache/index.ts` — Cache class with Upstash Redis (prod) / in-memory Map (dev), auto-detect, all ops try/catch
- [x] `src/utils/parallel.ts` — parallelFetch() with Promise.allSettled + 10s per-task timeout
- [x] `src/utils/normalize.ts` — shortenAddress, formatUsd, formatNumber, formatPercent, formatTimestamp, lamportsToSol, tokenAmountToDecimal
- [x] `test/test-phase1.ts` — smoke test covering all modules (all passing)

### Phase 2: Data source clients — NOT STARTED
- [ ] `src/sources/helius.ts`
- [ ] `src/sources/birdeye.ts`
- [ ] `src/sources/defi-llama.ts`
- [ ] `src/sources/jupiter.ts`
- [ ] `src/sources/solana-rpc.ts`

### Phase 3: Enrichment engine — NOT STARTED
- [ ] `src/enrichers/labeler.ts`
- [ ] `src/enrichers/risk-scorer.ts`
- [ ] `src/enrichers/wallet-profiler.ts`
- [ ] `src/enrichers/token-analyzer.ts`
- [ ] `src/enrichers/tx-parser.ts`

### Phase 4-6: Formatters, entrypoints, agent assembly — NOT STARTED
### Phase 7: Verification — NOT STARTED
