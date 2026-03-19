# SolEnrich

Solana onchain data enrichment agent. Accepts USDC micropayments via x402 and returns enriched wallet, token, and transaction data — structured JSON for agents or natural language briefings for LLMs.

**Live:** https://solenrich-production.up.railway.app/

**CA:** 677CpPEoKVo9tyCyBHqtiXZivUPdPXEigd3FspWuBAGS

## Quick Start

```bash
# Health check
curl https://solenrich-production.up.railway.app/health

# Agent card (A2A discovery)
curl https://solenrich-production.up.railway.app/.well-known/agent.json

# List all endpoints
curl https://solenrich-production.up.railway.app/entrypoints
```

## Endpoints

All endpoints accept POST requests to `/entrypoints/{key}/invoke` with a JSON body containing an `input` object.

### Core Endpoints

#### `enrich-wallet-light` — $0.002
Light wallet profile: SOL balance, token holdings, labels, risk score.

```bash
curl -X POST https://solenrich-production.up.railway.app/entrypoints/enrich-wallet-light/invoke \
  -H "Content-Type: application/json" \
  -d '{"input":{"address":"vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg","format":"json","depth":"light"}}'
```

#### `enrich-wallet-full` — $0.005
Full wallet profile: holdings, DeFi positions, connected wallets, labels, risk score.

```bash
curl -X POST https://solenrich-production.up.railway.app/entrypoints/enrich-wallet-full/invoke \
  -H "Content-Type: application/json" \
  -d '{"input":{"address":"vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg","format":"json","depth":"full"}}'
```

#### `enrich-token-light` — $0.002
Token analysis: price, market data, liquidity assessment, risk flags.

```bash
curl -X POST https://solenrich-production.up.railway.app/entrypoints/enrich-token-light/invoke \
  -H "Content-Type: application/json" \
  -d '{"input":{"mint":"DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263","format":"json","depth":"light"}}'
```

#### `enrich-token-full` — $0.004
Full token analysis: price, market data, liquidity, risk flags, top holders.

```bash
curl -X POST https://solenrich-production.up.railway.app/entrypoints/enrich-token-full/invoke \
  -H "Content-Type: application/json" \
  -d '{"input":{"mint":"DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263","format":"json","depth":"full"}}'
```

#### `parse-transaction` — $0.001
Parse a Solana transaction: type detection, protocol identification, transfer details.

```bash
curl -X POST https://solenrich-production.up.railway.app/entrypoints/parse-transaction/invoke \
  -H "Content-Type: application/json" \
  -d '{"input":{"signature":"<tx-signature>","format":"json"}}'
```

### Premium Endpoints

#### `whale-watch` — $0.008
Track large token holders, accumulation/distribution patterns.

```bash
curl -X POST https://solenrich-production.up.railway.app/entrypoints/whale-watch/invoke \
  -H "Content-Type: application/json" \
  -d '{"input":{"mint":"DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263","format":"json"}}'
```

#### `batch-enrich` — $0.015
Enrich multiple wallets or tokens in a single request (max concurrency: 5).

```bash
curl -X POST https://solenrich-production.up.railway.app/entrypoints/batch-enrich/invoke \
  -H "Content-Type: application/json" \
  -d '{"input":{"type":"wallet","addresses":["vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg"],"format":"json","depth":"light"}}'
```

#### `wallet-graph` — $0.010
Map wallet transaction connections and detect suspicious clusters.

```bash
curl -X POST https://solenrich-production.up.railway.app/entrypoints/wallet-graph/invoke \
  -H "Content-Type: application/json" \
  -d '{"input":{"address":"vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg","format":"json"}}'
```

#### `copy-trade-signals` — $0.010
Analyze wallet trading performance: PnL, win rate, consistency, smart money labeling.

```bash
curl -X POST https://solenrich-production.up.railway.app/entrypoints/copy-trade-signals/invoke \
  -H "Content-Type: application/json" \
  -d '{"input":{"address":"vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg","format":"json"}}'
```

#### `due-diligence` — $0.020
Comprehensive token research: security analysis, whale tracking, holder distribution, risk verdict (SAFE/CAUTION/RISKY).

```bash
curl -X POST https://solenrich-production.up.railway.app/entrypoints/due-diligence/invoke \
  -H "Content-Type: application/json" \
  -d '{"input":{"mint":"DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263","format":"json"}}'
```

## Pricing

| Endpoint | Price (USDC) | Description |
|----------|-------------|-------------|
| `enrich-wallet-light` | $0.002 | Light wallet profile |
| `enrich-wallet-full` | $0.005 | Full wallet profile with DeFi positions |
| `enrich-token-light` | $0.002 | Token price, market data, risk flags |
| `enrich-token-full` | $0.004 | Full token analysis with holders |
| `parse-transaction` | $0.001 | Transaction parsing and enrichment |
| `whale-watch` | $0.008 | Large holder tracking |
| `batch-enrich` | $0.015 | Batch wallet/token enrichment |
| `wallet-graph` | $0.010 | Wallet connection mapping |
| `copy-trade-signals` | $0.010 | Trading performance analysis |
| `due-diligence` | $0.020 | Comprehensive token research |

Payments are in USDC on Solana via the [x402 protocol](https://x402.org). When payments are enabled, requests without a valid x402 payment header return HTTP 402 with payment instructions.

## Output Formats

Every endpoint accepts a `format` parameter:

- **`json`** — Structured data for agent-to-agent consumption
- **`llm`** — Natural language briefing optimized for LLM context windows
- **`both`** — JSON data with an additional `llm_summary` field

## Architecture

```
Client → x402 Paywall → Entrypoint Router → Enrichment Engine → Format Router → Response
```

### Data Sources

| Source | Usage |
|--------|-------|
| [Helius](https://helius.dev) | DAS API (assets, token accounts), enhanced transaction parsing, RPC |
| [DexScreener](https://dexscreener.com) | Token prices, market data, liquidity |
| [DeFi Llama](https://defillama.com) | Protocol TVL, yield data |
| [Jupiter](https://jup.ag) | Token prices (cross-reference), metadata, verified status |
| Solana RPC | SOL balances, raw account data |

### MCP Server

SolEnrich exposes an MCP endpoint for Claude Desktop, Claude Code, and Cursor integration. **No install required** — just add the remote URL:

```json
{
  "mcpServers": {
    "solenrich": {
      "type": "streamable-http",
      "url": "https://solenrich-production.up.railway.app/mcp"
    }
  }
}
```

7 tools: `enrich_wallet`, `enrich_token`, `parse_transaction`, `whale_watch`, `due_diligence`, `wallet_graph`, `copy_trade_signals`.

See [`mcp/README.md`](mcp/README.md) for local setup and full tool descriptions.

## Development

```bash
# Install dependencies
bun install

# Start dev server (port 3000)
bun run dev

# Type check
bunx tsc --noEmit

# Run tests
bun run test/test-enrichment.ts
bun run test/test-server.ts
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `HELIUS_API_KEY` | Yes | Helius API key (helius.dev) |
| `AGENT_WALLET_ADDRESS` | Yes | Solana wallet address for payments |
| `PAYMENTS_ENABLED` | No | Set to `"true"` to enable x402 paywall |
| `PAYMENTS_RECEIVABLE_ADDRESS` | If payments | Wallet to receive USDC payments |
| `FACILITATOR_URL` | If payments | x402 facilitator URL |
| `NETWORK` | If payments | `solana:mainnet` |
| `JUPITER_API_KEY` | No | Jupiter API key (optional, free tier works) |
| `UPSTASH_REDIS_REST_URL` | No | Upstash Redis for caching (falls back to in-memory) |
| `UPSTASH_REDIS_REST_TOKEN` | No | Upstash Redis token |

## Deployment

Deployed on [Railway](https://railway.app) with Docker (Bun runtime).

```bash
# Deploy to Railway
railway up --service solenrich
```

## License

MIT

## Built by

[Parallax Labs](https://github.com/0xSardius)
