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

# List all 45 endpoints (44 paid + 1 free)
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
| `enrich-wallet-light` | $0.002 | `address`, `format` | SOL balance, token holdings, NFT breakdown, labels, risk score |
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

### Trenches — Memecoin Intelligence (5 endpoints)

| Endpoint | Price | Input | Description |
|----------|-------|-------|-------------|
| `smart-money-trenches` | $0.05 | `hours_back`, `max_token_age_hours`, `min_buyers`, `limit`, `format` | Which proven-winner wallets are aping fresh (<6h) launches right now — vetted realized-PnL seed set, bot-guarded, ranked by distinct smart buyers + recency |
| `runner-scan` | $0.04 | `max_token_age_hours`, `min_liquidity_usd`, `min_volume_h1_usd`, `limit`, `format` | Which fresh tokens are *accelerating* right now — buy-rate acceleration (5m vs 1h, 1h vs 6h), buy pressure, volume/price velocity, holder growth, liquidity trend. Stages RUNNING / IGNITING / PARABOLIC_LATE / FADING with a 0–1 score. Flags already-ran tokens as entry risk and LP pulls as rugs |
| `trenches-scan` | $0.08 | `max_token_age_hours`, `min_liquidity_usd`, `limit`, `format` | All three trenches signals in one call — on-chain velocity × proven-winner buys × agent attention, composited into a ranked list with confluence counts, per-token reasoning, and HIGH_CONFLUENCE / MODERATE / SINGLE_SIGNAL verdicts |
| `trenches-check` | $0.03 | `mint`, `format` | The suite pointed at ONE token — before you ape, run the check. Same three legs as trenches-scan but targeted at your candidate: verdict + reasoning + per-leg detail. Pairs with due-diligence for a full pre-entry read |
| `exit-signal` | $0.04 | `mint`, `entry_price_usd`, `format` | The sell-side verdict for a token you hold — EXIT / DERISK / HOLD with a 0–1 exit score. Sell pressure, buy-rate deceleration, volume fade, distribution-into-strength, top-holder flow (distributing vs accumulating whales), liquidity trend, holder churn. Rug triggers (LP pull, active dump) override everything. Works on tokens of any age |

### Collectibles / RWA (1 endpoint)

| Endpoint | Price | Input | Description |
|----------|-------|-------|-------------|
| `gacha-ev-scan` | $0.02 | `machine`, `franchise`, `exit_strategy`, `min_edge_pct`, `format` | Jupiter Gacha (Collector Crypt) pack EV scan — gross insured EV vs the guaranteed instant-buyback floor (85–93%, ≤72h) vs a marketplace sale (−2% fee, fill-risk). POSITIVE_EV / HOUSE_EDGE / NEGATIVE_EV verdict per machine — the realizable EV the platform hides behind its gross-EV headline |

### StonkFun — Quote-Paired & Reward Coins (5 endpoints, 1 free)

Coins launched on [stonkfun.xyz](https://www.stonkfun.xyz) are priced against a quote asset (xStocks such as NVDAX/SPYX/TSLAX, Backpack pre-stocks, currencies, custom mints). Reward-mode coins carry a Token-2022 transfer tax (100 or 300 bps) paid to holders in the quote token. These endpoints read the tax config from the chain, score whether it reaches holders, compute holder yield, screen the whole reward-coin set, and preflight a self-built LaunchLab launch before it is broadcast.

| Endpoint | Price | Input | Description |
|----------|-------|-------|-------------|
| `stonk-pairs` | free | `category`, `launchable_only`, `format` | Quote assets a launch can be paired against, normalized categories, `is_agent_launchable` flag (launchable + LaunchLab-ready + allowed category). Call first: a launch `quoteMint` must be one of these |
| `stonk-reward-risk` | $0.005 | `mint`, `format` | Payout status — `PAYING` (holders paid in the last 24h), `STALE`, `NEVER`, `NOT_REWARD` — plus `trading_cost` (tax bps, round-trip %) and a 0–100 health score read from the chain: fee bps + cap, withdraw authority (must be StonkFun's distributor), fee mutability, distributions + recency, flywheel, holders + concentration, quote category, age |
| `stonk-yield` | $0.005 | `mint`, `format` | Trailing 7d / 30d / lifetime holder yield — rewards in the quote asset, priced in USD, over average market cap; annualized with a caution flag under 7 days. Plus quote exposure: the holder is long the coin *and* its quote asset |
| `stonk-screener` | $0.01 | `quote_mint`, `category`, `min_holders`, `min_age_days`, `max_age_days`, `min_volume_24h_usd`, `max_market_cap_usd`, `paying_only`, `live_only`, `sort`, `limit`, `format` | Every reward coin from a 10-minute ingest, served from memory. Per row: `payout_status`, hours since last payout, `live` (traded AND paid in 24h), `round_trip_pct` tax cost, holders, yields, volume, mcap. Sort by `volume24h` (default), `lastPayout`, `holders`, `priceChange24h`, `yield7d`, `yield30d`, `rewardsUsd` |
| `stonk-gems` | $0.03 | `quote_mint`, `category`, `max_age_days`, `min_holders`, `max_market_cap_usd`, `limit`, `format` | Gem finder: ranks reward coins 0–100 on recent holder payout, holders, mcap headroom, 24h turnover, age, momentum, quote strength, flywheel. Stages `GEM` / `WATCH` / `NOISE` / `DEAD` with reasons and warnings per coin. "What should I look at on StonkFun right now?" |
| `stonk-launch-intel` | $0.02 | `category`, `min_coins`, `sort`, `limit`, `format` | What to launch and against what. Per quote asset: launches (24h/7d), share trading today, share paying today, survival past day 3, median holders + mcap, 100 vs 300 bps tax mix with trading/paying rates, crowding, 0–100 demand score, plus overall stats and plain recommendations |
| `stonk-launch-preflight` | $0.25 | `unsigned_transaction`, `quote_mint`, `mode`, `launch_params`, `format` | Decodes the LaunchLab initialize instruction and diffs every parameter against StonkFun's `/launchlab/pricing` — GlobalConfig, platform id per mode, curve, supply, totalSellA, raise, 6-decimal Token-2022 base mint, quote token program, curve-rule account last, and the reward-mode transfer fee (catches Raydium's `transferFeeBasePoints` / `maxinumFee` spelling). Returns `ok`, `mismatches[{field, expected, actual, fix}]`, `warnings`. A mismatched pool is never adopted: the tax goes to nobody |

### Intelligence Feed & Signals (4 endpoints)

| Endpoint | Price | Input | Description |
|----------|-------|-------|-------------|
| `feed-latest` | $0.005 | `since`, `format` | Daily intelligence brief — pre-computed trending ranking, cached 24h, built for recurring polling |
| `consensus-signal` | $0.005 | `address`/`type` or `limit`, `window`, `format` | What other agents are querying right now — proprietary attention signal from our request stream |
| `attention-momentum` | $0.02 | `window`, `limit`, `format` | Tokens ranked by *acceleration* of agent attention, with price divergence: early_signal (attention up, price flat) / distribution_risk (attention cooling, price pumping) |
| `check-alerts` | $0.008 | `tokens[]`, `wallets[]`, `since`, `criteria`, `format` | Poll-based alerts: price spikes, whale flows, risk changes + perps events (position add/close, liquidation approaching, PnL swings) |

### Natural Language (1 endpoint)

| Endpoint | Price | Input | Description |
|----------|-------|-------|-------------|
| `query` | $0.003 | `question`, `format` | Plain English questions routed to the right enricher |

### Example Request

```bash
curl -X POST https://api.solenrich.com/entrypoints/compare-tokens/invoke \
  -H "Content-Type: application/json" \
  -d '{"mints":["JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN","DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263"],"format":"both"}'
```

Request bodies are flat JSON matching each endpoint's schema in [`/openapi.json`](https://api.solenrich.com/openapi.json). A `{"input": {...}}` envelope is also accepted.

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

### NFT Classification

Most non-fungible assets on a Solana wallet are unsolicited compressed drops, so a raw NFT count overstates collecting activity. One measured wallet held 118 non-fungibles: 15 were real holdings and 103 were airdrops, several of them drainer bait.

Wallet enrichment returns `nft_summary` with three buckets that sum to `nft_count`:

| Bucket | Meaning |
|--------|---------|
| `collected` | Uncompressed and not spam-flagged. Minting these costs rent per asset, so they are usually bought or minted deliberately. |
| `airdropped` | Compressed and not spam-flagged. Cheap to mint in bulk, so usually sent unsolicited. |
| `suspected_spam` | Name or description matches claim bait, an embedded domain, or invisible filter-evasion characters. |

`nft_collections` lists the largest collections, real holdings first. `distinct_collections` counts only collected holdings in a named collection.

Spam detection is pattern matching on names and descriptions, applied to compressed assets only. Treat it as a signal, not a verdict — a legitimate compressed drop with promotional wording can be flagged. The `nft_collector` label requires 10 or more `collected` NFTs, so it no longer fires on airdrop volume.

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

32 tools — every endpoint is exposed as an MCP tool (wallet/token light+full variants fold into `depth`/`include_holders` toggles). Highlights: `enrich_wallet`, `enrich_token`, `due_diligence`, `whale_watch`, `perps_cross_venue_funding`, `trending_signals`, `smart_money_flow`, `check_alerts`.

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
