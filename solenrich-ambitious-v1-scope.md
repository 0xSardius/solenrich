# Solana Data Enrichment Agent — Ambitious v1 Scope

**Codename:** `SolEnrich` *(name TBD — shipping under codename)*
**Tagline:** Crisp, AI-readable Solana data. Pay per query. JSON for agents, natural language for LLMs.
**Stack:** Lucid Agents SDK · Daydreams Router · x402 · Hono · 8004-solana · Helius · Birdeye · DeFi Llama
**Target ship:** 1 week (Claude Code + lucid-agent-creator skill)
**Revenue model:** $0.002–$0.05 USDC per query via x402 micropayments

---

## 0. Product Vision — Two Audiences, One Pipe

SolEnrich serves two distinct consumers that both need the same underlying data:

**1. Autonomous x402 agents** (original value prop)
Agents that need structured JSON to programmatically act on — trading bots checking wallet profiles before copying trades, DeFi agents scanning token risk before entering positions, portfolio agents doing bulk wallet analysis. They pay via x402, get back typed JSON, and feed it directly into their decision logic.

**2. LLMs and AI applications** (expanded market)
Language models that need to *reason* about onchain data inside a context window — MCP servers, ChatGPT plugins, Claude tool calls, Cursor/Copilot integrations, or any AI app where a user asks "tell me about this token." Raw RPC responses are unreadable to models. SolEnrich returns natural language briefings that any LLM can immediately understand and reason with.

**How it works:** Every entrypoint accepts a `format` parameter:
- `format: "json"` → Structured data for programmatic consumption (default)
- `format: "llm"` → Natural language briefing optimized for LLM context windows
- `format: "both"` → JSON payload + `llm_summary` field appended

The enrichment engine runs identically for both formats. The LLM formatter is a lightweight post-processing step that transforms the structured output into a concise, information-dense briefing. No extra API calls, no extra cost — just a different serialization of the same data.

**Why this matters:** The agent-to-agent x402 market is growing fast, but the number of AI applications that need onchain data is 100x larger. MCP alone means every Claude, ChatGPT, and local model user becomes a potential customer. Dual format means SolEnrich captures both markets from day one without splitting focus.

**Distribution flywheel:** Built with Lucid → Distribute through XGATE → Get paid on x402. This is the Daydreams ecosystem's core loop, and SolEnrich is purpose-built for it.

---

## 1. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Calling Agent / Client                   │
│      x402 agents · MCP servers · ChatGPT plugins · apps     │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP request + x402 payment header
                           ▼
┌─────────────────────────────────────────────────────────────┐
│               SolEnrich — Lucid Agent (Hono)                 │
│                                                              │
│  ┌──────────────┐  ┌─────────────┐  ┌────────────────────┐  │
│  │ x402 Paywall │  │ Entrypoint  │  │ Agent Card /       │  │
│  │ (Lucid native│→ │ Router      │  │ .well-known        │  │
│  │  + Daydreams │  │             │  │ (XGATE optimized)  │  │
│  │  Facilitator)│  │             │  │                    │  │
│  └──────────────┘  └──────┬──────┘  └────────────────────┘  │
│                           │                                  │
│  ┌────────────────────────▼────────────────────────────────┐ │
│  │                 Enrichment Engine                        │ │
│  │  ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌──────────┐  │ │
│  │  │ Wallet   │ │ Token    │ │ Protocol  │ │ Graph    │  │ │
│  │  │ Profiler │ │ Analyzer │ │ Scanner   │ │ Mapper   │  │ │
│  │  └────┬─────┘ └────┬─────┘ └─────┬─────┘ └────┬─────┘  │ │
│  │       │             │             │             │        │ │
│  │  ┌────▼─────────────▼─────────────▼─────────────▼────┐  │ │
│  │  │              Data Source Layer                      │  │ │
│  │  │  Helius · Birdeye · DeFi Llama · Jupiter           │  │ │
│  │  │  Solana RPC · Flipside · Dune                      │  │ │
│  │  └──────────────────────┬─────────────────────────────┘  │ │
│  └─────────────────────────┼───────────────────────────────┘ │
│                            │                                  │
│  ┌─────────────────────────▼───────────────────────────────┐ │
│  │                   Format Router                          │ │
│  │  ┌──────────────┐  ┌──────────────────────────────────┐ │ │
│  │  │ format: json │  │ format: llm                      │ │ │
│  │  │ (structured) │  │ (natural language briefing)       │ │ │
│  │  └──────────────┘  └──────────────────────────────────┘ │ │
│  │              format: both → JSON + llm_summary           │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌───────────────┐ ┌──────────────┐ ┌─────────────────────┐ │
│  │ Cache Layer   │ │ 8004-solana  │ │ Daydreams Router    │ │
│  │ (Upstash KV)  │ │ Identity     │ │ (LLM inference for  │ │
│  │               │ │              │ │  /query endpoint)   │ │
│  └───────────────┘ └──────────────┘ └─────────────────────┘ │
│                                                              │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │              Webhook / Streaming Engine                   │ │
│  │  SSE streams · Condition-based alerts · Push delivery    │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                           │
                           ▼
                XGATE Discovery / x402 Bazaar
         (machine-readable Agent Card, rich capability tags,
          ERC-8004 registered, reputation-seeded)
```

---

## 2. Daydreams Ecosystem Integration

This agent is designed to sit natively inside the Daydreams ecosystem, not just use pieces of it.

### 2a. Lucid Agents SDK — The Foundation

**Scaffold:** Use `create-lucid-agent` CLI with the Hono adapter. Do NOT hand-roll the x402 middleware — Lucid's entrypoint pattern handles payment gating natively:

```typescript
agent.entrypoint({
  name: 'enrich-wallet',
  input: z.object({
    address: z.string(),
    depth: z.enum(["light", "full"]).default("light"),
    format: z.enum(["json", "llm", "both"]).default("json"),
  }),
  output: WalletEnrichmentSchema,
  price: { amount: '0.005', currency: 'USDC' },
  handler: async ({ input }) => {
    const data = await walletProfiler.enrich(input.address, input.depth);
    return formatResponse(data, input.format, formatWalletBriefing);
  }
})
```

**Packages:**
- `@lucid-agents/core` — entrypoints, adapters, agent lifecycle
- `@lucid-agents/payments` — x402 paywall, bi-directional payment tracking, payment policies, persistent storage (SQLite for dev, Postgres for prod)
- `@lucid-agents/identity` — ERC-8004 toolkit, domain verification, trust signals
- `@lucid-agents/a2a` — A2A protocol client for agent-to-agent communication
- `@lucid-agents/analytics` — payment analytics, CSV/JSON export

**Claude Code skill:** Install the `lucid-agent-creator` skill for maximum velocity:
```bash
mkdir -p .claude/skills/lucid-agent-creator && \
curl -fsSL https://raw.githubusercontent.com/daydreamsai/skills-market/main/plugins/lucid-agent-creator/skills/SKILL.md \
  -o .claude/skills/lucid-agent-creator/SKILL.md
```
This lets Claude Code generate handlers and schemas from natural language prompts, iterate by updating prompts instead of hand-writing boilerplate, and ship production agents with `create_lucid_agent`.

### 2b. Daydreams Router — LLM Inference Layer

The `/query` natural language endpoint and any AI-powered analysis (smart labeling, risk narrative generation) routes LLM calls through Daydreams Router instead of direct API keys.

**Why:**
- Single USDC payment abstraction for all model providers (GPT, Claude, Gemini, Groq)
- No individual API key management — pay-per-use via x402
- We become a consumer in the Daydreams ecosystem, which builds our reputation on XGATE
- OpenAI-compatible API — drop-in replacement

```typescript
import { dreamsRouter, createDreamsRouterAuth } from "@daydreamsai/ai-sdk-provider";

const { dreamsRouter: router } = await createDreamsRouterAuth(agentWallet, {
  payments: { amount: "100000", network: "base" }, // $0.10 per inference
});

// Use for the /query natural language endpoint
const model = router("anthropic/claude-sonnet-4-20250514");
```

**Usage within SolEnrich:**
- `/query` endpoint: parse user intent → route to enrichers → generate LLM briefing
- Smart labeling: when heuristic labels are ambiguous, use a model call to classify
- Risk narrative: for premium endpoints, generate a 2-sentence risk summary via Router
- Cost: ~$0.001-0.01 per model call depending on complexity. Baked into endpoint pricing.

### 2c. Daydreams as x402 Facilitator

Use Daydreams' facilitator service for payment verification and settlement instead of running our own:
- **Supports:** Solana, Base, Abstract
- **Settlement:** Verifies cryptographic payment signatures and settles on-chain
- **Endpoint:** `https://facilitator.daydreams.systems`

This means zero facilitator infrastructure on our side. Lucid's payment middleware points to the Daydreams facilitator out of the box.

### 2d. XGATE — Discovery Optimization

XGATE is how other agents find us. Optimizing for XGATE is as important as the product itself.

**Agent Card** (`/.well-known/agent-card.json`):
Lucid auto-generates this, but we need to enrich it with machine-readable metadata:

```json
{
  "name": "SolEnrich",
  "description": "Solana onchain data enrichment. Wallet profiling, token analysis, DeFi positions, whale tracking, risk scoring. JSON for agents, natural language for LLMs.",
  "capabilities": [
    "wallet-enrichment",
    "token-analysis",
    "transaction-parsing",
    "defi-position-scanning",
    "whale-detection",
    "risk-scoring",
    "natural-language-query",
    "llm-optimized-data",
    "real-time-streaming",
    "webhook-alerts"
  ],
  "chains": ["solana"],
  "formats": ["json", "llm", "both"],
  "pricing": {
    "currency": "USDC",
    "min": "0.002",
    "max": "0.05",
    "model": "per-request"
  },
  "identity": {
    "erc8004": "8oo48pya1SZD23ZhzoNMhxR2UGb8BRa41Su4qP9EuaWm",
    "type": "8004-solana"
  },
  "entrypoints": [
    {
      "name": "enrich-wallet",
      "path": "/enrich/wallet",
      "price": "0.005",
      "input_schema": "...",
      "description": "Full wallet profile with holdings, DeFi positions, labels, and risk score"
    }
  ]
}
```

**XGATE ranking factors** (based on ecosystem docs):
1. **Reputation score** — from 8004-solana feedback. Seed by having Parallax (our own agent) call SolEnrich and leave positive feedback on-chain.
2. **Volume** — more transactions = higher visibility. Seed by dogfooding from our other projects (Tidal, Polymarket app).
3. **Capability richness** — more entrypoints with clear descriptions = more discoverable for diverse queries.
4. **Uptime and response time** — agents prefer fast, reliable endpoints. Cloudflare Workers gives us edge deployment.
5. **Agent Card completeness** — filled-out metadata, clear pricing, format options.

**Seeding strategy:**
- Have Parallax and Tidal call SolEnrich endpoints as part of their workflows
- Submit feedback via 8004-solana SDK after each successful call
- Cross-promote in x402 Bazaar listing
- Target Daydreams bounty program for visibility within the ecosystem

---

## 3. Entrypoints (API Endpoints)

Every entrypoint is a Lucid `agent.entrypoint()` with Zod-validated input/output schemas,
a native `price` field, and `format` parameter support. Grouped by phase.

### Phase 1 — Core Enrichment (Days 1-3)

#### `POST /enrich/wallet`
**Price:** $0.005 USDC
**Input:** `{ address: string, depth?: "light" | "full", format?: "json" | "llm" | "both" }`

**JSON response** (`format: "json"`):
```json
{
  "address": "7xK9...3nFp",
  "sol_balance": 12.45,
  "portfolio_value_usd": 4250.00,
  "token_count": 23,
  "top_holdings": [
    { "mint": "...", "symbol": "BONK", "balance": 1000000, "usd_value": 45.00 }
  ],
  "nft_count": 7,
  "defi_positions": [
    { "protocol": "Marinade", "type": "staking", "value_usd": 500.00 }
  ],
  "tx_count_30d": 142,
  "first_tx_date": "2022-03-15",
  "labels": ["active_trader", "defi_user", "nft_collector"],
  "risk_score": 0.15,
  "connected_wallets": ["4kR2...8xVp", "9mN3...2qLw"],
  "last_updated": "2026-02-18T12:00:00Z"
}
```

**LLM response** (`format: "llm"`):
```text
## Wallet Profile: 7xK9...3nFp

Active Solana wallet since March 2022. Holds 12.45 SOL ($2,800) and 23 SPL tokens.
Portfolio value: ~$4,250 across tokens, NFTs, and DeFi positions.

Top holdings: BONK ($45), JUP ($120), PYTH ($88). Holds 7 NFTs across 3 collections.

DeFi activity: $500 staked via Marinade. Classified as active_trader (142 transactions
in 30 days), defi_user, and nft_collector.

Risk score: 0.15/1.0 (low). Diversified holdings, consistent activity, no flagged
associations. 2 connected wallets identified via transfer patterns.

Data as of: 2026-02-18T12:00:00Z
```

**Data sources:** Helius `getAssetsByOwner` + `getTokenAccounts`, Birdeye token prices, Solana RPC for SOL balance, parsed transaction history for labels

#### `POST /enrich/token`
**Price:** $0.003 USDC
**Input:** `{ mint: string, include_holders?: boolean, holder_limit?: number, format?: "json" | "llm" | "both" }`

**JSON response** (`format: "json"`):
```json
{
  "mint": "...",
  "symbol": "BONK",
  "name": "Bonk",
  "decimals": 5,
  "supply": 100000000000,
  "holder_count": 450000,
  "price_usd": 0.0000245,
  "market_cap": 2450000,
  "volume_24h": 180000,
  "price_change_24h": -3.2,
  "top_holders": [
    { "address": "...", "balance": 5000000, "pct_supply": 0.005 }
  ],
  "liquidity_pools": [
    { "dex": "Raydium", "pair": "BONK/SOL", "tvl": 120000 }
  ],
  "risk_flags": ["high_concentration", "low_liquidity"],
  "last_updated": "2026-02-18T12:00:00Z"
}
```

**LLM response** (`format: "llm"`):
```text
## Token: BONK (Bonk)

Solana SPL token. Price: $0.0000245 (down 3.2% 24h). Market cap: $2.45M.
24h volume: $180K. 450,000 holders.

Liquidity: Primary pool on Raydium (BONK/SOL, $120K TVL). Thin relative to
market cap — large orders will experience significant slippage.

Top holder controls 0.5% of supply. No single entity dominates.

Risk flags: high_concentration, low_liquidity.

Data as of: 2026-02-18T12:00:00Z
```

**Data sources:** Helius `getTokenAccounts`, Birdeye price/volume, Jupiter pool data, DeFi Llama TVL

#### `POST /enrich/transaction`
**Price:** $0.002 USDC
**Input:** `{ signature: string, format?: "json" | "llm" | "both" }`
**Returns:** Parsed transaction with type, protocol, tokens involved, amounts, fees, success status.
**Data sources:** Helius enhanced transaction API

### Phase 2 — Premium Intelligence (Days 3-5)

#### `POST /enrich/wallet/defi`
**Price:** $0.008 USDC
**Input:** `{ address: string, format?: "json" | "llm" | "both" }`
**Returns:** Full DeFi position breakdown — lending, borrowing, LPs, staking, rewards pending across all major Solana protocols (Marinade, Jito, Raydium, Orca, Kamino, Drift, marginfi, Jupiter). Includes unrealized PnL on LP positions and pending yield.
**Data sources:** Protocol-specific account parsing, DeFi Llama yields API

#### `POST /enrich/whale-watch`
**Price:** $0.01 USDC
**Input:** `{ mint: string, threshold_usd?: number, lookback_hours?: number, format?: "json" | "llm" | "both" }`
**Returns:** Recent large transactions for a token (default threshold: $10K), whale wallet labels, accumulation/distribution patterns, net flow direction.
**Data sources:** Helius transaction history, Birdeye

#### `POST /enrich/batch`
**Price:** $0.003 per address (volume discount)
**Input:** `{ addresses: string[], type: "wallet" | "token", depth?: "light" | "full", format?: "json" | "llm" | "both" }`
**Returns:** Array of enrichment results — parallel fetching, optimized for agents doing bulk analysis.
**Data sources:** Parallel calls to all relevant sources

### Phase 3 — Ambitious Features (Days 5-7)

#### `POST /enrich/graph`
**Price:** $0.015 USDC
**Input:** `{ address: string, depth?: 1 | 2, min_interactions?: number, format?: "json" | "llm" | "both" }`
**Returns:** Cross-reference graph of wallet relationships. Maps frequently interacted wallets, labels known entities (protocols, exchanges, whales), identifies clusters, and flags suspicious patterns (e.g., wash trading rings, sybil clusters).
```json
{
  "center": "7xK9...3nFp",
  "depth": 1,
  "nodes": [
    { "address": "4kR2...8xVp", "labels": ["whale", "defi_user"], "interaction_count": 34 },
    { "address": "Rayd...Pool", "labels": ["raydium_pool"], "interaction_count": 89 }
  ],
  "edges": [
    { "from": "7xK9...3nFp", "to": "4kR2...8xVp", "type": "transfer", "volume_usd": 12500, "count": 34 }
  ],
  "clusters": [
    { "id": "cluster_1", "members": ["7xK9...3nFp", "4kR2...8xVp"], "pattern": "frequent_bidirectional" }
  ]
}
```
**Data sources:** Helius transaction history (deep scan), entity labeling database

#### `POST /enrich/copy-trade-check`
**Price:** $0.02 USDC
**Input:** `{ address: string, lookback_days?: number, format?: "json" | "llm" | "both" }`
**Returns:** Everything a copy-trade agent needs in one call — recent trades with entry/exit prices, estimated win rate, average hold time, PnL estimate, token concentration, risk profile, consistency score.
```json
{
  "address": "...",
  "trade_count_30d": 87,
  "win_rate": 0.62,
  "avg_hold_time_hours": 4.2,
  "estimated_pnl_30d_usd": 3400,
  "largest_win_usd": 1200,
  "largest_loss_usd": -450,
  "preferred_dexs": ["Jupiter", "Raydium"],
  "token_diversity": 0.73,
  "consistency_score": 0.68,
  "risk_profile": "moderate_aggressive",
  "last_trade": "2026-02-18T09:15:00Z"
}
```
**Data sources:** Helius transaction history, Birdeye token prices (historical), Jupiter

#### `POST /enrich/token-due-diligence`
**Price:** $0.025 USDC
**Input:** `{ mint: string, format?: "json" | "llm" | "both" }`
**Returns:** Full investment memo — token fundamentals, holder distribution analysis, liquidity depth, whale activity, social signals, contract risk flags, comparable tokens. The LLM format for this is a structured 400-word research briefing.
**Data sources:** All sources combined

#### `POST /query`
**Price:** $0.01–0.03 USDC (dynamic based on complexity)
**Input:** `{ question: string, context?: { wallets?: string[], tokens?: string[] } }`
**Returns:** Natural language answer to any Solana data question. The agent parses intent, routes to the appropriate enrichers, and generates a response.

Example: `"What's the riskiest token in wallet 7xK9...3nFp?"` → enriches the wallet, scores each holding's risk, returns a briefing.

**LLM inference:** Routed through **Daydreams Router** (Claude or Gemini for reasoning, cheaper models for parsing). This is the only endpoint that requires model inference — all others use deterministic templates.

### Phase 3b — Real-Time Features (Days 5-7)

#### `GET /stream/wallet`
**Price:** $0.01 USDC per hour (SSE subscription)
**Input:** `{ address: string, events?: ["swap", "transfer", "defi", "nft", "all"], format?: "json" | "llm" }`
**Returns:** Server-Sent Events stream. Every time the wallet does something on-chain, SolEnrich pushes an enriched event through the stream. Not raw transaction data — fully parsed, labeled, and contextualized.
**Implementation:** Helius webhooks → internal event bus → SSE to subscriber
**Data sources:** Helius webhook subscriptions

#### `POST /webhook/register`
**Price:** $0.005 USDC per registration + $0.002 per triggered alert
**Input:**
```json
{
  "target": { "type": "wallet" | "token", "address": "..." },
  "condition": {
    "type": "transfer_above" | "holder_drop" | "price_change" | "whale_move" | "custom",
    "params": { "threshold_usd": 50000 }
  },
  "callback_url": "https://agent-b.example.com/alerts",
  "format": "json" | "llm",
  "expires_hours": 168
}
```
**Returns:** Webhook ID. When condition triggers, SolEnrich POSTs enriched alert data to the callback URL. Agents pay the registration fee upfront, then per-alert on trigger.
**Implementation:** Helius webhooks → condition evaluator → callback dispatcher

---

## 4. Tech Stack Breakdown

### Framework & Runtime
- **Lucid Agents SDK** — full package suite (core, payments, identity, a2a, analytics)
- **Hono adapter** — lightweight, Cloudflare Workers native
- **Bun runtime** — fast startup, native TypeScript
- **Zod** — input/output validation on every entrypoint
- **lucid-agent-creator Claude Code skill** — for rapid handler generation

### Payment Layer
- **@lucid-agents/payments** — native x402 paywall on every entrypoint via `price` field
- **Facilitator:** Daydreams facilitator (`https://facilitator.daydreams.systems`)
- **Settlement:** USDC on Solana (primary), Base (secondary)
- **Payment policies:** per-request limits, time-windowed totals, per-sender rate limiting
- **Payment tracking:** bi-directional (incoming from customers + outgoing to Daydreams Router for inference)
- **Analytics:** built-in with CSV/JSON export via `@lucid-agents/analytics`

### LLM Inference (for /query endpoint only)
- **Daydreams Router** (`router.daydreams.systems`) — OpenAI-compatible
- **Provider:** `@daydreamsai/ai-sdk-provider` — Vercel AI SDK compatible
- **Models:** Claude Sonnet for reasoning, Gemini Flash for lightweight parsing
- **Payment:** USDC micropayments per inference via x402 (pass-through cost baked into /query pricing)

### Identity & Discovery
- **8004-solana SDK** (`npm i 8004-solana`) — register agent NFT on Solana with reputation tracking
- **Agent Card** at `/.well-known/agent-card.json` — auto-generated by Lucid, enriched with XGATE-optimized metadata
- **XGATE listing** — machine-readable capability tags, pricing info, chain support
- **x402 Bazaar** — secondary discovery surface

### Data Sources (upstream APIs)
| Source | What it provides | Cost | Priority |
|--------|-----------------|------|----------|
| **Helius** | Token accounts, DAS, parsed txs, webhooks, gRPC streams | $49/mo Pro | Critical |
| **Birdeye** | Token prices, market data, volume, historical | $99/mo Pro | Critical |
| **DeFi Llama** | Protocol TVL, yield data, pool info | Free | High |
| **Jupiter** | Swap routing, pool data, price API | Free | High |
| **Solana RPC** | SOL balances, raw account data, signatures | Via Helius | Critical |
| **Flipside** | Historical analytics, SQL queries | Free tier | Nice-to-have |

### Caching
- **Upstash Redis** (works natively with Cloudflare Workers)
- Hot data (token prices, metadata): 60s TTL
- Warm data (wallet profiles, holder snapshots): 5min TTL
- Graph data (wallet relationships): 30min TTL
- Cache keys: `wallet:{address}:{depth}`, `token:{mint}`, `tx:{sig}`, `graph:{address}:{depth}`

### Real-Time Infrastructure
- **Helius webhooks** — push notifications for wallet/token events
- **SSE (Server-Sent Events)** — Lucid native SSE support for streaming endpoints
- **Internal event bus** — webhook events → enrichment → fan-out to subscribers
- **Condition engine** — evaluates registered webhook conditions against incoming events

### Deployment
- **Primary:** Cloudflare Workers (edge, global, stateless endpoints)
- **Streaming/Webhooks:** Railway or Fly.io (persistent connections needed for SSE + webhook receiver)
- **Database:** Upstash Redis (cache) + Turso/Planetscale (webhook registrations, payment history)
- **Monitoring:** Lucid analytics + Cloudflare analytics + simple `/health` endpoint

---

## 5. x402 Payment Flow

```
Agent A wants wallet data for address XYZ

1. Agent A → POST /enrich/wallet { address: "XYZ", format: "llm" }

2. Lucid entrypoint middleware checks for x402 payment header
   → No payment? Return HTTP 402 with payment instructions:
   {
     "price": "0.005",
     "asset": "USDC",
     "network": "solana",
     "recipient": "<solenrich-wallet>",
     "facilitator": "https://facilitator.daydreams.systems"
   }

3. Agent A signs USDC transfer authorization
   → Retries request with x402 payment header attached

4. Daydreams facilitator verifies + settles payment on Solana
   → Payment confirmed → Lucid routes to handler

5. Enrichment engine:
   → Check Upstash cache for fresh data
   → Cache miss: fan out to Helius + Birdeye + Solana RPC in parallel
   → Normalize → label → risk score
   → Cache result (always structured data)
   → Route through Format Router:
     - format=json → return structured JSON
     - format=llm → pipe through LLM Formatter → return briefing
     - format=both → return JSON + llm_summary field

6. Agent A receives enriched data.
   → Lucid records incoming payment in bi-directional tracker.
   → Total time: < 2 seconds.
```

---

## 6. Project Structure

```
solenrich/
├── package.json
├── tsconfig.json
├── bun.lockb
├── .env.example
├── .claude/
│   └── skills/
│       └── lucid-agent-creator/
│           └── SKILL.md              # Daydreams Claude Code skill
│
├── src/
│   ├── index.ts                      # Hono app + Lucid adapter setup
│   ├── config.ts                     # Env vars, pricing table, feature flags
│   ├── agent.ts                      # Lucid agent definition + all entrypoints
│   │
│   ├── entrypoints/
│   │   ├── wallet.ts                 # /enrich/wallet
│   │   ├── token.ts                  # /enrich/token
│   │   ├── transaction.ts            # /enrich/transaction
│   │   ├── wallet-defi.ts            # /enrich/wallet/defi
│   │   ├── whale-watch.ts            # /enrich/whale-watch
│   │   ├── batch.ts                  # /enrich/batch
│   │   ├── graph.ts                  # /enrich/graph
│   │   ├── copy-trade-check.ts       # /enrich/copy-trade-check
│   │   ├── token-due-diligence.ts    # /enrich/token-due-diligence
│   │   ├── query.ts                  # /query (NL endpoint, uses Daydreams Router)
│   │   ├── stream-wallet.ts          # /stream/wallet (SSE)
│   │   └── webhook.ts               # /webhook/register + /webhook/unregister
│   │
│   ├── enrichers/
│   │   ├── wallet-profiler.ts        # Wallet enrichment logic
│   │   ├── token-analyzer.ts         # Token enrichment logic
│   │   ├── tx-parser.ts              # Transaction parsing
│   │   ├── defi-scanner.ts           # DeFi position scanner
│   │   ├── graph-mapper.ts           # Wallet relationship graph
│   │   ├── copy-trade-analyzer.ts    # Trade history analysis
│   │   ├── due-diligence.ts          # Token research compilation
│   │   ├── labeler.ts                # Wallet labeling engine
│   │   └── risk-scorer.ts            # Risk scoring algorithms
│   │
│   ├── formatters/
│   │   ├── index.ts                  # Format router (json | llm | both)
│   │   ├── llm-wallet.ts             # Wallet → briefing
│   │   ├── llm-token.ts              # Token → briefing
│   │   ├── llm-transaction.ts        # Transaction → briefing
│   │   ├── llm-defi.ts               # DeFi positions → briefing
│   │   ├── llm-graph.ts              # Relationship graph → briefing
│   │   ├── llm-copy-trade.ts         # Copy-trade analysis → briefing
│   │   ├── llm-due-diligence.ts      # Due diligence → research memo
│   │   └── templates.ts              # Shared helpers, formatCompact, etc.
│   │
│   ├── sources/
│   │   ├── helius.ts                 # Helius API client
│   │   ├── birdeye.ts                # Birdeye API client
│   │   ├── defi-llama.ts             # DeFi Llama API client
│   │   ├── jupiter.ts                # Jupiter API client
│   │   ├── solana-rpc.ts             # Direct Solana RPC calls
│   │   └── dreams-router.ts          # Daydreams Router client (for /query)
│   │
│   ├── realtime/
│   │   ├── webhook-receiver.ts       # Receives Helius webhook events
│   │   ├── event-bus.ts              # Internal pub/sub for event distribution
│   │   ├── condition-engine.ts       # Evaluates registered alert conditions
│   │   ├── sse-manager.ts            # Manages SSE connections + fan-out
│   │   └── callback-dispatcher.ts    # POSTs alerts to registered webhook URLs
│   │
│   ├── cache/
│   │   ├── index.ts                  # Cache interface
│   │   ├── upstash.ts                # Upstash Redis adapter
│   │   └── memory.ts                 # In-memory LRU fallback for dev
│   │
│   ├── schemas/
│   │   ├── wallet.ts                 # Zod schemas for wallet endpoints
│   │   ├── token.ts                  # Zod schemas for token endpoints
│   │   ├── graph.ts                  # Zod schemas for graph endpoints
│   │   ├── realtime.ts               # Zod schemas for streaming/webhook
│   │   └── common.ts                 # Shared types (Format, Depth, etc.)
│   │
│   └── utils/
│       ├── parallel.ts               # Parallel fetching with timeouts + fallbacks
│       ├── normalize.ts              # Data normalization helpers
│       └── rate-limit.ts             # Per-source rate limiting
│
├── identity/
│   └── register.ts                   # 8004-solana agent NFT registration script
│
├── mcp/
│   ├── server.ts                     # MCP server wrapper (thin client)
│   └── tools.ts                      # MCP tool definitions (enrich_wallet, etc.)
│
└── deploy/
    ├── wrangler.toml                 # Cloudflare Workers (stateless endpoints)
    ├── railway.toml                  # Railway (streaming + webhook infra)
    └── seed-reputation.ts            # Script to seed 8004-solana reputation
```

---

## 7. Labeling Engine

Labels are derived from transaction patterns and holdings. This is the core moat — keep proprietary.

| Label | Logic |
|-------|-------|
| `whale` | Holdings > $100K in any single token |
| `active_trader` | > 50 swap transactions in 30 days |
| `defi_user` | Active positions in 2+ DeFi protocols |
| `nft_collector` | Holds 10+ NFTs across collections |
| `new_wallet` | First transaction < 30 days ago |
| `dormant` | No transactions in 90+ days |
| `airdrop_farmer` | Interacted with 5+ unverified protocols in 30d |
| `bot_suspect` | > 500 tx/day or repetitive timing patterns |
| `stablecoin_heavy` | > 60% portfolio in stablecoins |
| `lp_provider` | Active LP positions on 2+ DEXs |
| `sniper` | Buys tokens within 60s of pool creation |
| `smart_money` | > 65% win rate over 50+ trades, PnL positive |
| `copy_worthy` | smart_money + consistency_score > 0.6 |
| `wash_trader` | Bidirectional transfers with same set of wallets |
| `exchange_wallet` | Known exchange deposit/withdrawal patterns |

Risk score (0.0 – 1.0) factors: wallet age, transaction diversity, protocol interaction breadth, concentration, known association with flagged addresses, wash trading signals.

---

## 8. LLM Formatter — Design Principles

The LLM formatter transforms structured enrichment data into natural language briefings
optimized for consumption inside an LLM context window. Deterministic template-based
formatting — no LLM calls needed (except `/query` endpoint which uses Daydreams Router).

### Design Rules

1. **Information density over readability.** Every sentence contains a fact or judgment. No filler.
2. **Structured markdown.** `##` headers, line breaks, consistent formatting. Models parse markdown well.
3. **Lead with identity, then numbers, then risk.** Who/what → key metrics → patterns → risk → timestamp.
4. **Explicit units and context.** Always USD values, percentages, time ranges. "$120K TVL" not "120000".
5. **Risk flags in plain language.** "high_concentration — top 10 holders control 40% of supply."
6. **Compact.** Target 150-300 tokens per briefing. Cheap context. Room for multi-enrichment reasoning.
7. **Timestamp everything.** "Data as of: [ISO timestamp]" — LLMs have no sense of time.

### Implementation

```typescript
// formatters/index.ts
type Format = "json" | "llm" | "both";

function formatResponse<T>(data: T, format: Format, formatter: (d: T) => string): any {
  switch (format) {
    case "json":
      return data;
    case "llm":
      return { briefing: formatter(data), content_type: "text/markdown" };
    case "both":
      return { ...data, llm_summary: formatter(data) };
  }
}
```

### MCP Server (ships in same week)

Thin wrapper in `/mcp/` directory. Exposes SolEnrich endpoints as MCP tools:
- `enrich_wallet` → calls `/enrich/wallet?format=llm`
- `enrich_token` → calls `/enrich/token?format=llm`
- `query_solana` → calls `/query`

The MCP server handles MCP protocol. x402 payment happens under the hood.
This turns every Claude/ChatGPT user into a paying customer without them knowing about x402.
List on MCP server directories for additional discovery surface.

---

## 9. Pricing Strategy

| Endpoint | Price (USDC) | Category |
|----------|-------------|----------|
| `/enrich/wallet` (light) | $0.003 | Core |
| `/enrich/wallet` (full) | $0.005 | Core |
| `/enrich/token` | $0.003 | Core |
| `/enrich/transaction` | $0.002 | Core |
| `/enrich/wallet/defi` | $0.008 | Premium |
| `/enrich/whale-watch` | $0.01 | Premium |
| `/enrich/batch` | $0.003/addr | Premium |
| `/enrich/graph` | $0.015 | Ambitious |
| `/enrich/copy-trade-check` | $0.02 | Ambitious |
| `/enrich/token-due-diligence` | $0.025 | Ambitious |
| `/query` | $0.01–0.03 | Ambitious |
| `/stream/wallet` | $0.01/hour | Real-time |
| `/webhook/register` | $0.005 + $0.002/alert | Real-time |

**Same price for JSON and LLM formats.** Formatter adds <1ms compute. Value is in enrichment, not serialization.

**Cost basis:**
- Helius Pro: $49/mo
- Birdeye Pro: $99/mo
- Daydreams Router inference (for /query): ~$0.001-0.01 per call (pass-through)
- Upstash Redis: ~$10/mo
- Cloudflare Workers: Free tier covers initial volume, $5/mo for paid
- **Total fixed costs: ~$165/mo**

**Break-even:** ~8K queries/month at average $0.02/query = $160. At 500 queries/day (conservative once on XGATE), that's $300/mo revenue = profitable in month 1.

**Scale math:** 5K queries/day × $0.01 avg = $1,500/month. 50K queries/day = $15,000/month. The x402 agent economy is doing 400K+ transactions/day already — capturing even 1% of data enrichment demand is significant.

---

## 10. Ship Checklist (7 Days)

### Day 1: Foundation
- [ ] Install lucid-agent-creator skill into Claude Code
- [ ] Scaffold with `create-lucid-agent` CLI (Hono adapter)
- [ ] Configure x402 payment middleware (USDC on Solana, Daydreams facilitator)
- [ ] Set up Upstash Redis for caching
- [ ] Build Helius client wrapper with caching + rate limiting
- [ ] Build Birdeye client wrapper with caching + rate limiting
- [ ] Register agent identity via 8004-solana SDK

### Day 2: Core Endpoints
- [ ] Implement `/enrich/wallet` (light + full)
- [ ] Implement `/enrich/token`
- [ ] Implement `/enrich/transaction`
- [ ] Implement labeling engine (core 10 labels)
- [ ] Implement risk scorer (v1)
- [ ] Build format router + LLM formatter templates (wallet, token, tx)

### Day 3: Premium Endpoints
- [ ] Implement `/enrich/wallet/defi` (multi-protocol parsing)
- [ ] Implement `/enrich/whale-watch`
- [ ] Implement `/enrich/batch` (parallel fetching)
- [ ] LLM formatter templates for premium endpoints
- [ ] Deploy v0.1 to Cloudflare Workers
- [ ] Test end-to-end with curl (both JSON and LLM formats)

### Day 4: Ambitious Endpoints
- [ ] Implement `/enrich/graph` (wallet relationship mapping)
- [ ] Implement `/enrich/copy-trade-check`
- [ ] Implement `/enrich/token-due-diligence`
- [ ] Expand labeling engine (sniper, smart_money, wash_trader)
- [ ] LLM formatter templates for ambitious endpoints

### Day 5: Intelligence Layer + Real-time
- [ ] Set up Daydreams Router integration
- [ ] Implement `/query` natural language endpoint
- [ ] Implement `/stream/wallet` SSE endpoint (deploy streaming infra to Railway)
- [ ] Set up Helius webhook receiver
- [ ] Implement internal event bus

### Day 6: Webhooks + MCP + Discovery
- [ ] Implement `/webhook/register` + condition engine + callback dispatcher
- [ ] Build MCP server wrapper (`/mcp/`)
- [ ] Optimize Agent Card metadata for XGATE
- [ ] List on XGATE
- [ ] List on x402 Bazaar
- [ ] Run seed-reputation script (Parallax + Tidal calling SolEnrich)

### Day 7: Polish + Launch
- [ ] Load testing and response time optimization
- [ ] Payment analytics verification (Lucid built-in)
- [ ] Rate limiting per sender wallet
- [ ] Error handling and graceful degradation (source failures)
- [ ] README + API documentation
- [ ] Announce on Farcaster / X / Daydreams community
- [ ] Submit to MCP server directories

---

## 11. Key Decisions

1. **Name:** TBD. Shipping under codename `SolEnrich`. Decide before public launch on Day 7. Leaning chain-agnostic (Distill, Clarion) for future multi-chain expansion.

2. **Solana-only v1:** Yes. Add Base/EVM in v2. Focus beats breadth.

3. **Daydreams facilitator vs self-hosted:** Daydreams. Zero infra overhead, supports Solana + Base + Abstract.

4. **8004-solana vs SATI:** 8004-solana SDK. Production-ready on npm. Migrate to SATI if it becomes standard.

5. **Open source strategy:** Open-source the agent skeleton, entrypoint structure, LLM formatter templates, and MCP server. Keep enrichment engine (labeler, risk scorer, graph mapper) proprietary — that's the moat.

6. **Streaming infra:** Cloudflare Workers for stateless endpoints. Railway for SSE streams + webhook receiver. Split deployment is fine — Lucid supports it.

7. **Daydreams Router for /query only:** Don't route all LLM formatting through Router — deterministic templates are free and instant. Only use Router for actual inference tasks (/query, smart labeling edge cases).

8. **Pricing floor:** $0.002 minimum per request. x402 settlement on Solana costs $0.00025 — anything above that is margin.
