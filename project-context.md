# SolEnrich — Project Context

> This document is for brainstorming, strategy iteration, and product planning. Upload it to a Claude project to work on SolEnrich ideas outside of the codebase.

## What SolEnrich Is

SolEnrich is a **Solana onchain data enrichment API** built for agents and LLMs. It aggregates data from 5+ sources (Helius, DexScreener, Jupiter, DeFi Llama, Solana RPC), runs proprietary risk scoring and labeling, and returns structured JSON or natural-language briefings.

Every endpoint is pay-per-call via USDC micropayments (x402) or credit card (MPP/Stripe). Prices range from $0.001 to $0.020 per call. No subscriptions, no API keys — just pay and get data.

**Built by Parallax Labs.** Deployed on Railway (Bun + Docker). Landing page on Vercel.

## Current State (April 2026)

- **17 paid endpoints** + free demo + MCP server
- **Dual-protocol payments**: MPP/Stripe (fiat) on all endpoints, x402 (Solana USDC) as fallback
- **8004-solana identity** registered on Solana mainnet
- **OpenAPI 3.1.0** discovery at `/openapi.json` (validated by mppx CLI + AgentCash)
- **MCP server** working on production at `/mcp` (7 tools, Streamable HTTP transport)
- **Full E2E testing**: SolScout consumer agent, 13/13 endpoints passing with real USDC

### Endpoint Categories

| Category | Endpoints | Price Range |
|----------|-----------|-------------|
| Core enrichment | wallet-light, wallet-full, token-light, token-full, parse-transaction | $0.001–$0.005 |
| Premium analytics | whale-watch, wallet-graph, copy-trade-signals, due-diligence, batch-enrich | $0.008–$0.020 |
| Comparison | compare-tokens, compare-wallets | $0.006 |
| Temporal | token-trend, wallet-history | $0.006 |
| Discovery | new-tokens, protocol-profile | $0.008–$0.012 |
| Natural language | query | $0.003 |

## What Makes SolEnrich Different

1. **Agent-native**: JSON for machines, markdown for LLMs, same data pipeline. No scraping, no screenshots.
2. **Pay-per-call**: No API keys, no rate limits, no subscriptions. Agents pay with USDC or credit cards per request.
3. **Multi-source aggregation**: Median pricing from 3 sources, cross-referenced holder data, protocol-aware transaction parsing.
4. **Proprietary scoring**: 7-factor wallet risk, HHI concentration, volatility classification, copy-trade Sharpe/Sortino — pure functions, no ML black boxes.
5. **Dual payments**: First Solana enrichment service with both x402 (crypto) and MPP/Stripe (fiat). Agents choose their payment method.

## Target Users & Integration Products

### 1. Telegram Research Agent (collaborator)
- **Uses**: due-diligence, token analysis, whale-watch
- **Needs next**: Real-time alerts (token price spikes, whale movements)
- **Value**: Validates due-diligence as the "killer endpoint" for research bots

### 2. Prediction Market / Autonomous Agent (own product, Solana)
- **Uses**: market signals, trend data, smart money flow
- **Needs next**: trending-signals, smart-money-flow aggregation endpoints
- **Value**: Proves SolEnrich can feed autonomous decision-making

### 3. Tidal (own product, consumer DeFi on Solana)
- **What it is**: Autonomous agent that finds the best yield opportunities for users
- **Uses**: protocol-profile (TVL, yields, health), risk scoring for auto-positioning
- **Needs next**: Deeper protocol analytics, pool-level risk scoring, auto-rebalancing signals
- **Value**: Consumer-facing product that dogfoods SolEnrich

### 4. Bags Trading Agent (Daydreams-based)
- **What it is**: Trades Bags tokens autonomously
- **Uses**: token discovery (new-tokens), copy-trade-signals, whale-watch
- **Needs next**: Faster data refresh, integration with Bags API for execution
- **Value**: High-frequency consumer of enrichment data, validates latency requirements

## Expansion Roadmap (Prioritized)

### Ready to Build

**Smart Money / Aggregated Intelligence** (2-3 sessions)
- `trending-signals`: Scan top holders across multiple tokens, aggregate activity
- `smart-money-flow`: Track where smart money is moving, rank by conviction
- Reuses: whale-watch, due-diligence, DeFi Llama, PriceAggregator
- Blocker: No "scan all tokens" API — needs curated watchlist or DexScreener trending as input
- **Serves**: Prediction market agent, Bags trading agent

**Event-Driven Alerts** (3-4 sessions)
- `subscribe-alerts` (SSE) or `check-alerts` (poll-based)
- Whale movements, price spikes, risk score changes, new token launches
- Build realtime infra in `src/realtime/` (currently empty scaffold)
- Start with poll-based, upgrade to SSE later
- **Serves**: Telegram research agent, all trading agents (stickiest feature)

### Infrastructure Priorities

- **Birdeye API integration**: Key is set on Railway. Free tier gets holder counts + OHLCV. $39/mo Lite gets token security + wallet portfolio. Client already written.
- **Rate limiting**: @upstash/ratelimit to protect upstream APIs
- **CI pipeline**: GitHub Actions for tsc + bun test
- **MCP directory submissions**: Smithery, mcp.run, Glama — free distribution to Claude/Cursor users
- **x402 bazaar listing**: Trigger by making a paid request through the facilitator
- **MPPScan registration**: Discovery is live, just need to register

### Distribution & Growth

- **Agent-to-agent partnerships**: Trading agents, portfolio managers, research bots that need enrichment
- **SDK/client package**: `npm install @solenrich/client` — typed client with built-in payment handling
- **Social launch**: Twitter thread, Farcaster, Solana ecosystem channels
- **Bags Hackathon**: Submitted to the $4M Bags Hackathon (AI Agents track, $10K-$100K grants)

### Moonshot Ideas

- **Multi-chain expansion**: Base/Ethereum enrichment using same architecture
- **Reputation-gated pricing**: Cheaper rates for agents with high 8004 reputation scores
- **On-chain analytics dashboard**: Frontend showing live usage, top queried wallets/tokens
- **Proprietary signal layer**: Usage patterns (most-queried tokens, whale recurrence, risk-price correlations) are natural signal. Not building yet, but worth tracking as data accumulates.

## Proprietary Data Opportunity

Over time, SolEnrich accumulates valuable meta-data:
- **Most-queried tokens** — early indicator of agent/community interest
- **Whale recurrence patterns** — which whales are most tracked, which wallets appear across queries
- **Risk-price correlations** — do agents that query risk before buying get better outcomes?
- **Temporal snapshots** — daily snapshots of every enriched token/wallet, building a unique historical dataset

This data is a moat. No one else has "what are agents asking about on Solana?" signal. Worth thinking about how to productize.

## Technical Constraints & Known Issues

- **@solana/kit must stay at 5.5.1** — 6.x causes @solana/errors runtime crash in Bun. tsc passes but runtime breaks. Solana MPP (USDC on-chain payments) is blocked until resolved.
- **DeFi Llama /protocol/ endpoint** can return massive payloads for popular protocols. Mitigated with lightweight /tvl/ fallback + 8s abort.
- **Stripe E2E untested** — MPP middleware works but no real card payment has been processed yet.
- **Birdeye free tier = 1 rps** — fine with caching (60-300s TTL), but can't handle burst traffic.
- **No rate limiting** on SolEnrich itself — upstream API limits are the constraint.

## Key URLs

| Resource | URL |
|----------|-----|
| Production API | https://solenrich-production.up.railway.app |
| Landing Page | https://landing-rho-six.vercel.app |
| API Docs (JSON) | https://solenrich-production.up.railway.app/docs |
| OpenAPI Spec | https://solenrich-production.up.railway.app/openapi.json |
| MCP Server | https://solenrich-production.up.railway.app/mcp |
| Agent Card | https://solenrich-production.up.railway.app/.well-known/agent.json |
| Free Demo | https://solenrich-production.up.railway.app/demo/enrich |
| GitHub | https://github.com/0xSardius/solenrich |

## Questions to Explore

These are open questions worth brainstorming:

1. **Pricing optimization**: Are the current prices right? Should high-value endpoints like due-diligence ($0.02) be higher? Should we offer volume discounts?
2. **SDK design**: What should `@solenrich/client` look like? Auto-payment? Typed responses? Streaming?
3. **Alert design**: Push (SSE/webhooks) vs pull (poll endpoint)? What alert types matter most to trading agents?
4. **Smart money definition**: What makes a wallet "smart money"? Win rate? Portfolio size? Early entry? How do we score this?
5. **Multi-chain strategy**: Same enrichment quality on Base/Ethereum, or Solana-only and go deep?
6. **Tidal product design**: How should an autonomous yield agent present opportunities to users? What trust signals matter?
7. **Agent marketplace positioning**: How to stand out on x402 bazaar, MCP directories, and AgentCash?
