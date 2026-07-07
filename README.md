# SolEnrich

Solana onchain data enrichment agent. Accepts USDC micropayments via x402 and returns enriched wallet, token, and transaction data — structured JSON for agents or natural language briefings for LLMs.

**Live API:** https://api.solenrich.com/
**Landing Page:** https://solenrich.com
**Docs (agent-readable):** https://api.solenrich.com/docs

## Quick Start

```bash
# Health check
curl https://api.solenrich.com/health

# Agent card (A2A discovery)
curl https://api.solenrich.com/.well-known/agent.json

# List all 32 endpoints
curl https://api.solenrich.com/entrypoints

# Full API documentation (agent-readable JSON)
curl https://api.solenrich.com/docs

# Free demo (no payment required, 10 queries/hr)
curl -X POST https://api.solenrich.com/demo/enrich \
  -H "Content-Type: application/json" \
  -d '{"address":"DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"}'
```

## Endpoints

All paid endpoints accept POST requests to `/entrypoints/{key}/invoke` with a JSON body containing an `input` object. Without a valid x402 payment header, endpoints return HTTP 402 with payment instructions.

### Core (5 endpoints)

| Endpoint | Price | Input | Description |
|----------|-------|-------|-------------|
| `enrich-wallet-light` | $0.002 | `address`, `format` | SOL balance, token holdings, labels, risk score |
| `enrich-wallet-full` | $0.005 | `address`, `format` | + DeFi positions, connected wallets, enhanced tx history |
| `enrich-token-light` | $0.002 | `mint`, `format` | Price (median of 3 sources), market cap, volume, liquidity, risk flags |
| `enrich-token-full` | $0.004 | `mint`, `format` | + Top 20 holders, HHI concentration, volatility metrics |
| `parse-transaction` | $0.001 | `signature`, `format` | Type detection, protocol identification, transfer breakdown |

### Premium (5 endpoints)

| Endpoint | Price | Input | Description |
|----------|-------|-------|-------------|
| `whale-watch` | $0.008 | `mint`, `format` | Top holders with accumulation/distribution tracking |
| `batch-enrich` | $0.015 | `addresses[]`, `type`, `depth`, `format` | Parallel enrichment of up to 25 wallets or tokens |
| `wallet-graph` | $0.010 | `address`, `depth`, `format` | Transaction connection mapping and cluster detection |
| `copy-trade-signals` | $0.010 | `address`, `format` | PnL, win rate, Sharpe/Sortino ratios, max drawdown |
| `due-diligence` | $0.020 | `mint`, `format` | Composite risk report with SAFE / CAUTION / RISKY verdict |

### Comparison (2 endpoints)

| Endpoint | Price | Input | Description |
|----------|-------|-------|-------------|
| `compare-tokens` | $0.006 | `mints[]` (2-3), `format` | Side-by-side: price, liquidity, volatility, HHI, risk. Rankings + summary |
| `compare-wallets` | $0.006 | `addresses[]` (2-3), `depth`, `format` | Side-by-side: portfolio, activity, risk, labels. Rankings + summary |

### Temporal (3 endpoints)

| Endpoint | Price | Input | Description |
|----------|-------|-------|-------------|
| `token-trend` | $0.006 | `mint`, `lookback`, `format` | Token metrics over time — daily snapshots with improving/declining/stable direction per metric |
| `wallet-history` | $0.006 | `address`, `lookback`, `format` | Portfolio value, SOL balance, risk score deltas + position changes across daily snapshots |
| `portfolio-history` | $0.006 | `address`, `period`, `format` | Full portfolio time-series (7/14/30d) with peak, trough, max drawdown, change vs start |

### Discovery & Protocol (2 endpoints)

| Endpoint | Price | Input | Description |
|----------|-------|-------|-------------|
| `new-tokens` | $0.012 | `min_liquidity_usd`, `max_risk_score`, `limit`, `format` | Recently launched tokens, enriched + risk-scored, safest first |
| `protocol-profile` | $0.008 | `protocol`, `include_yields`, `format` | Protocol TVL, yields, on-chain activity, health signals, automated-activity % |

### Perps Intelligence (8 endpoints)

| Endpoint | Price | Input | Description |
|----------|-------|-------|-------------|
| `perps-market-structure` | $0.012 | `format` | Jupiter Perps OI, utilization, borrow APR, skew, health flags for SOL/BTC/ETH |
| `perps-trader-profile` | $0.010 | `address`, `format` | Multi-venue (Jupiter + Adrena) open positions, leverage, PnL, trader classification |
| `perps-cross-venue-funding` | $0.015 | `market`, `include_reference`, `format` | Funding/borrow APR + OI across Jupiter, Adrena, Hyperliquid, dYdX — best entry per side, arbitrage spreads |
| `perps-venue-comparison` | $0.020 | `market`, `side`, `size_usd`, `format` | Where to trade at this size: slippage, fees, OI headroom, total entry cost, recommendation |
| `perps-basis-signal` | $0.015 | `asset`, `min_yield_apr_pct`, `format` | Net-yield-after-borrow basis trade scanner — actually-earnable yield per venue |
| `perps-market-trend` | $0.008 | `lookback`, `format` | Per-market deltas (price, OI, skew, utilization, borrow APR) over 7/14/30d — regime detection |
| `hyperliquid-trader-profile` | $0.012 | `address` (0x), `format` | Hyperliquid live positions, leverage, liquidation distance, risk flags, week/month/all-time PnL |
| `hyperliquid-smart-money` | $0.05 | `market`, `top_traders`, `format` | Leaderboard funnel → consistency-gated traders → per-coin positioning consensus + top-trader drill-down |

### Orchestration (2 endpoints)

| Endpoint | Price | Input | Description |
|----------|-------|-------|-------------|
| `trending-signals` | $0.050 | `min_liquidity_usd`, `max_risk_score`, `limit`, `format` | Composite ranking of trending tokens: discovery + whale-watch + risk scoring, with reasoning |
| `smart-money-flow` | $0.100 | `wallets[]`, `min_win_rate`, `lookback_days`, `format` | Scores seed wallets, filters to winners, surfaces tokens they're accumulating + clusters |

### Trenches — Memecoin Intelligence (1 endpoint)

| Endpoint | Price | Input | Description |
|----------|-------|-------|-------------|
| `smart-money-trenches` | $0.05 | `hours_back`, `max_token_age_hours`, `min_buyers`, `limit`, `format` | Which proven-winner wallets are aping fresh (<6h) launches right now — vetted realized-PnL seed set, bot-guarded, ranked by distinct smart buyers + recency |

### Intelligence Feed & Signals (3 endpoints)

| Endpoint | Price | Input | Description |
|----------|-------|-------|-------------|
| `feed-latest` | $0.005 | `since`, `format` | Daily intelligence brief — pre-computed trending ranking, cached 24h, built for recurring polling |
| `consensus-signal` | $0.005 | `address`/`type` or `limit`, `window`, `format` | What other agents are querying right now — proprietary attention signal from our request stream |
| `check-alerts` | $0.008 | `tokens[]`, `wallets[]`, `since`, `criteria`, `format` | Poll-based alerts: price spikes, whale flows, risk changes + perps events (position add/close, liquidation approaching, PnL swings) |

### Natural Language (1 endpoint)

| Endpoint | Price | Input | Description |
|----------|-------|-------|-------------|
| `query` | $0.003 | `question`, `format` | Plain English questions routed to the right enricher |

### Example Request

```bash
curl -X POST https://api.solenrich.com/entrypoints/compare-tokens/invoke \
  -H "Content-Type: application/json" \
  -d '{"input":{"mints":["JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN","DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"],"format":"both"}}'
```

## Output Formats

Every endpoint accepts a `format` parameter:

- **`json`** — Structured data for agent-to-agent consumption
- **`llm`** — Natural language briefing (markdown) for LLM context windows
- **`both`** — JSON data with an additional `llm_summary` field

## Scoring Methodology

All scoring is **deterministic on-chain logic** — no LLM inference anywhere in the pipeline.

### Wallet Risk Score (0.0 - 1.0)

Seven additive factors from on-chain activity:

| Factor | Weight |
|--------|--------|
| High transaction concentration (few counterparties) | +0.15 |
| Low transaction diversity | +0.10 |
| New wallet (< 30 days old) | +0.15 |
| Bot-like patterns (high frequency, repetitive) | +0.20 |
| Interactions with known risky programs | +0.15 |
| Airdrop farming signals (many small token accounts) | +0.10 |
| Low protocol diversity (< 2 protocols) | +0.10 |

**Risk Levels:** LOW (< 0.25) | MODERATE (0.25-0.50) | ELEVATED (0.50-0.65) | HIGH (0.65-0.80) | CRITICAL (> 0.80)

### HHI (Herfindahl-Hirschman Index)

Holder concentration metric from top 20 on-chain holders:
- **< 1500** — Well distributed
- **1500-2500** — Moderately concentrated
- **> 2500** — Highly concentrated

### Price Volatility

Computed from DexScreener multi-timeframe data (zero extra API calls):
- **LOW** — daily std < 3%
- **MODERATE** — 3-8%
- **HIGH** — 8-15%
- **EXTREME** — > 15%

### Token Pricing

Median of up to 3 sources (Helius DAS, DexScreener, Jupiter). Median resists outliers from any single DEX.

## Architecture

```
Client → x402 Paywall → Entrypoint Router → Enrichment Engine → Format Router → Response
```

### Data Sources

| Source | Usage |
|--------|-------|
| [Helius](https://helius.dev) | DAS API (assets, token accounts), enhanced transaction parsing, RPC |
| [DexScreener](https://dexscreener.com) | Token prices, market data, liquidity, OHLCV |
| [DeFi Llama](https://defillama.com) | Protocol TVL, yield data |
| [Jupiter](https://jup.ag) | Token prices (cross-reference), metadata, verification status, perps quotes |
| [Birdeye](https://birdeye.so) | Real holder counts, daily OHLCV for volatility |
| Solana RPC | SOL balances, mint info, top 20 holders, Jupiter Perps + Adrena on-chain accounts |
| Hyperliquid + dYdX v4 | Cross-chain perps reference (funding rates, basis) |

### Entity Labeling

20+ known Solana addresses auto-tagged across all enrichment results: CEX wallets (Binance, Coinbase), protocol addresses (Raydium, Orca, Jupiter), bridges, and foundations.

## MCP Server

SolEnrich exposes an MCP endpoint for Claude Desktop, Claude Code, and Cursor. **No install required:**

```json
{
  "mcpServers": {
    "solenrich": {
      "type": "streamable-http",
      "url": "https://api.solenrich.com/mcp"
    }
  }
}
```

27 tools — every endpoint is exposed as an MCP tool (wallet/token light+full variants fold into `depth`/`include_holders` toggles). Highlights: `enrich_wallet`, `enrich_token`, `due_diligence`, `whale_watch`, `perps_cross_venue_funding`, `trending_signals`, `smart_money_flow`, `check_alerts`.

## Free Demo

Try SolEnrich without payment — paste any Solana wallet address or token mint:

```bash
curl -X POST https://api.solenrich.com/demo/enrich \
  -H "Content-Type: application/json" \
  -d '{"address":"JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN"}'
```

10 free queries per IP per hour. Auto-detects wallet vs token. Returns `format: "both"` (JSON + LLM summary).

Interactive demo on the landing page: https://solenrich.com

## Development

```bash
# Install dependencies
bun install

# Start dev server (port 3000)
bun run dev

# Type check
bunx tsc --noEmit

# Run tests
bun test test/unit.test.ts                # 138 unit tests
bun run test/test-all-endpoints.ts        # 55 endpoint tests (requires local server)
bun run test/test-402-production.ts       # Production paywall verification
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HELIUS_API_KEY` | Yes | Helius API key (helius.dev) |
| `AGENT_WALLET_ADDRESS` | Yes | Solana wallet address for payments |
| `PAYMENTS_ENABLED` | No | Set to `"true"` to enable x402 paywall |
| `FACILITATOR_URL` | If payments | x402 facilitator URL |
| `UPSTASH_REDIS_REST_URL` | No | Upstash Redis for caching (falls back to in-memory) |
| `UPSTASH_REDIS_REST_TOKEN` | No | Upstash Redis token |
| `JUPITER_API_KEY` | No | Jupiter API key (optional, free tier works) |
| `BIRDEYE_API_KEY` | No | Birdeye API key — real holder counts + daily OHLCV for volatility |
| `METRICS_TOKEN` | No | Bearer token for `GET /metrics`; without it metrics are locked in production |

## Deployment

Deployed on [Railway](https://railway.app) with Docker (Bun runtime). Auto-deploys from `main` branch.

## License

MIT

## Built by

[Parallax Labs](https://github.com/0xSardius)
