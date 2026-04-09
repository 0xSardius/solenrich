# Helius Partnership / Upgraded Tier Application

## Project: SolEnrich

**One-liner:** Solana onchain data enrichment API for agents and LLMs — wallet profiling, token risk scoring, whale tracking, and DeFi protocol analytics, powered by Helius.

**Built by:** Parallax Labs
**Live API:** https://solenrich-production.up.railway.app
**GitHub:** https://github.com/0xSardius/solenrich
**Landing:** https://landing-rho-six.vercel.app

---

## What SolEnrich Does

SolEnrich is a pay-per-call enrichment API that turns raw Solana onchain data into structured intelligence. Agents and LLMs send a wallet address, token mint, or transaction signature and get back risk scores, labels, holder analysis, whale tracking, and natural-language briefings.

**17 paid endpoints** covering:
- Wallet profiling (holdings, DeFi positions, risk scoring, entity labeling)
- Token analysis (price aggregation, holder concentration, volatility, risk flags)
- Transaction parsing (type detection, protocol identification, transfer mapping)
- Whale tracking (top holders, accumulation/distribution patterns)
- Due diligence (composite token research with safety recommendations)
- Copy-trade signals (PnL, Sharpe/Sortino ratios, win rate)
- Wallet graph mapping (connection networks, cluster detection)
- DeFi protocol analytics (TVL, yield pools, on-chain activity)
- Token/wallet comparison, temporal trends, new token discovery

Every endpoint returns JSON (for agent consumption) or natural-language markdown (for LLM context windows).

---

## How We Use Helius

Helius is our **primary data source**. We use 4 Helius APIs across 7 enrichment engines:

### DAS API (JSON-RPC)
- **`getAssetsByOwner`** — Core of wallet profiling. Returns fungible tokens, NFTs, compressed assets, and native SOL balance with price info. Every wallet enrichment starts here.
- **`getTokenAccountsByOwner`** — Token account resolution for holder analysis and wallet graph mapping.
- **`searchAssets`** — Flexible asset discovery for token metadata and cross-referencing.

### Enhanced Transactions API (REST)
- **Batch parsing** — We fetch up to 200 signatures per wallet, then batch-parse in 100-signature chunks via the enhanced transactions endpoint. This is the backbone of:
  - Transaction type detection (SWAP, TRANSFER, NFT_SALE, etc.)
  - Protocol identification (Jupiter, Raydium, Orca, Marinade, etc.)
  - Copy-trade PnL calculation
  - Wallet graph edge construction
  - DeFi position detection

### RPC (via Helius URL)
- **`getSignaturesForAddress`** — With pagination (`before` param) for multi-page scanning. Used by wallet-profiler, copy-trade-analyzer, graph-mapper, and protocol-analyzer.

### Where Helius fits in each enricher

| Enricher | Helius APIs Used | What it powers |
|----------|-----------------|----------------|
| Wallet Profiler | getAssetsByOwner, getSignaturesForAddress, getEnhancedTransactions | Holdings, DeFi detection, labels, risk scoring |
| Token Analyzer | searchAssets | Token metadata, mint/freeze authority checks |
| Transaction Parser | getEnhancedTransaction | Type detection, protocol ID, transfer mapping |
| Copy-Trade Analyzer | getSignaturesForAddress, getEnhancedTransactions | Trade history, PnL, win rate, Sharpe ratio |
| Graph Mapper | getSignaturesForAddress, getEnhancedTransactions (2-hop) | Wallet connections, cluster detection |
| Protocol Analyzer | getSignaturesForAddress (2 pages), getEnhancedTransactions | On-chain activity metrics, tx type breakdown |
| Whale Watcher | (via Solana RPC + Helius URL) | Top holder resolution |

**Estimated Helius calls per enrichment:**
- Wallet-light: 2-3 calls (assets + signatures)
- Wallet-full: 4-6 calls (assets + signatures + enhanced txs in batches)
- Copy-trade: 3-5 calls (signatures + enhanced txs)
- Graph (depth 2): 10-20+ calls (multi-hop signature + tx fetching)
- Protocol profile: 4-6 calls (signatures x2 pages + enhanced tx batches)

---

## Traction & Usage

- **Live since:** March 2026
- **65 unique tokens** and **11 unique wallets** enriched in first week of production
- **3,881 Redis commands** processed (implies ~10,000+ upstream API calls including Helius)
- **Dual-protocol payments**: x402 (Solana USDC) and MPP/Stripe (credit card) on all endpoints
- **MCP server** live at `/mcp` — 7 tools accessible from Claude Desktop, Cursor, and other MCP clients
- **8004-solana agent** registered on Solana mainnet
- **Full E2E verification**: SolScout consumer agent, 13/13 paid endpoints passing with real USDC
- **OpenAPI 3.1.0** discovery validated by mppx CLI and AgentCash

### Active Integration Targets
1. **Telegram research bot** (collaborator) — uses due-diligence and token analysis endpoints
2. **Autonomous DeFi agent** (own product, "Tidal") — protocol analytics and risk scoring for auto-yield
3. **Prediction market agent** (own product) — trend data, smart money signals
4. **Bags trading agent** — token discovery, copy-trade signals, whale tracking

### Hackathon
Submitted to the **Bags Hackathon** ($4M funding pool, AI Agents track). Helius is a listed partner/judge.

---

## Why an Upgraded Tier Helps

We're currently on the free/starter Helius tier. As our agent-to-agent usage grows, we'll need:

1. **Higher RPS** — Each enrichment fires 3-20 Helius calls. A single batch-enrich request (10 items) can generate 30-50 Helius calls. The graph endpoint at depth 2 can hit 20+ calls per request. Current rate limits are the primary bottleneck for response times.

2. **Priority endpoints** — Our users are agents making real-time decisions. Sub-second Helius response times directly improve our product quality. Wallet profiling currently takes 3-5 seconds end-to-end, with most of that time in Helius API calls.

3. **Enhanced transaction volume** — Copy-trade and graph endpoints need to parse hundreds of transactions per request. Higher batch limits or priority access would unlock deeper analysis windows.

**What we give back:**
- SolEnrich is a **distribution channel for Helius data**. Every agent that uses SolEnrich is indirectly consuming Helius APIs — without needing to integrate Helius directly. We make Helius data accessible to the entire agent ecosystem.
- We attribute Helius prominently in our `/docs` endpoint, landing page, and agent card.
- We're building the reference implementation for how agents consume onchain data on Solana.

---

## Technical Details

- **Stack:** Bun + Hono + Lucid Agents SDK
- **Deployment:** Railway (Docker, auto-deploy from GitHub main)
- **Caching:** Upstash Redis (60s-300s TTL per data type, prevents redundant Helius calls)
- **Parallel fetching:** `Promise.allSettled` with 10s per-task timeout — one slow API never blocks the pipeline
- **Rate limit handling:** Built-in retry with 1s backoff on 429s from Helius

---

## Links

| Resource | URL |
|----------|-----|
| Live API | https://solenrich-production.up.railway.app |
| API Docs | https://solenrich-production.up.railway.app/docs |
| OpenAPI Spec | https://solenrich-production.up.railway.app/openapi.json |
| Free Demo | https://solenrich-production.up.railway.app/demo/enrich |
| MCP Server | https://solenrich-production.up.railway.app/mcp |
| Agent Card | https://solenrich-production.up.railway.app/.well-known/agent.json |
| GitHub | https://github.com/0xSardius/solenrich |
| Landing Page | https://landing-rho-six.vercel.app |
| llms.txt | https://github.com/0xSardius/solenrich/blob/main/llms.txt |
