# SolEnrich — API Listing Profile

Use this for marketplace submissions (Orbis, mcp.run, Glama, etc.).

## Overview

**Name:** SolEnrich
**Tagline:** Solana onchain data enrichment for agents and LLMs
**Category:** Blockchain / DeFi / Data Intelligence
**Base URL:** https://api.solenrich.com
**MCP URL:** https://api.solenrich.com/mcp
**Logo:** https://solenrich.com/logo.png
**Landing Page:** https://solenrich.com
**Builder:** Parallax Labs (@solenrichHQ)

## Description (short)

Solana wallet profiling, token analysis, risk scoring, and DeFi intelligence. Returns structured JSON (for agents) or natural language briefings (for LLMs). Pay-per-call with USDC micropayments via x402.

## Description (long)

SolEnrich is a Solana onchain data enrichment API that turns raw blockchain data into actionable intelligence. It cross-references Helius, Birdeye, DexScreener, Jupiter, DeFi Llama, and Solana RPC to deliver wallet profiles, token analysis, risk scores, holder concentration metrics, slippage estimates, whale tracking, copy-trade signals, and due diligence reports.

Every endpoint supports dual output formats: structured JSON for agent-to-agent pipelines, or natural language briefings sized for LLM context windows. Agents choose their format with a single parameter.

Payment is pay-per-call via x402 protocol (Solana USDC). No API keys, no subscriptions, no accounts. Send a USDC micropayment with your request, get enriched data back.

## Endpoints & Pricing

| Endpoint | Price (USDC) | Description |
|----------|-------------|-------------|
| enrich-wallet-light | $0.002 | Quick wallet snapshot — SOL balance, top holdings, labels |
| enrich-wallet-full | $0.005 | Full profile — DeFi positions, activity signals, risk score |
| enrich-token-light | $0.002 | Token basics — price, market cap, holder count, risk flags |
| enrich-token-full | $0.004 | Deep token analysis — holders, concentration, volatility, slippage |
| parse-transaction | $0.001 | Transaction parsing — type detection, protocol labeling, transfers |
| whale-watch | $0.008 | Top holders, buy/sell activity, balance tracking |
| wallet-graph | $0.010 | Connection mapping — related wallets, clusters, depth-1/2 hops |
| copy-trade-signals | $0.010 | Trade history PnL, win rate, Sharpe/Sortino, smart money signals |
| due-diligence | $0.020 | Composite report — token + whales + holders + risk levels |
| batch-enrich | $0.015 | Batch up to 10 wallets or tokens in one call |
| compare-tokens | $0.006 | Side-by-side token comparison with rankings |
| compare-wallets | $0.006 | Side-by-side wallet comparison with rankings |
| token-trend | $0.006 | Token metrics over time — direction indicators |
| wallet-history | $0.006 | Wallet changes over time — position adds/removes |
| new-tokens | $0.012 | Discover recently launched tokens, filtered and risk-ranked |
| protocol-profile | $0.008 | DeFi protocol health — TVL, yields, activity metrics |
| query | $0.003 | Natural language question routed to the right enricher |

## Payment

- **Protocol:** x402 (HTTP 402 Payment Required)
- **Currency:** USDC on Solana
- **Facilitator:** PayAI Network
- **How it works:** Call any endpoint without payment → get 402 response with payment instructions → include `X-Payment` header with signed USDC payment → get enriched data back
- **No API keys or accounts required**

## Integration

### Direct HTTP
```bash
# Without payment (returns 402 with instructions)
curl https://api.solenrich.com/entrypoints/enrich-token-light/invoke \
  -X POST -H "Content-Type: application/json" \
  -d '{"input":{"mint":"DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263","format":"json"}}'

# Free endpoints
curl https://api.solenrich.com/health
curl https://api.solenrich.com/docs
curl https://api.solenrich.com/openapi.json
```

### MCP (Claude Desktop / Cursor)
Add to MCP settings:
```json
{
  "mcpServers": {
    "solenrich": {
      "url": "https://api.solenrich.com/mcp"
    }
  }
}
```

15 tools available: enrich_wallet, enrich_token, parse_transaction, whale_watch, due_diligence, wallet_graph, copy_trade_signals, batch_enrich, compare_tokens, compare_wallets, token_trend, wallet_history, new_tokens, protocol_profile, query.

## Data Sources

Helius (DAS API + enhanced transactions), Birdeye (holder counts, OHLCV), DexScreener (price, liquidity, market data), Jupiter (prices, token metadata, slippage quotes), DeFi Llama (protocol TVL, yields), Solana RPC (balances, account data).

## Discovery

- **OpenAPI 3.1:** https://api.solenrich.com/openapi.json
- **x402 well-known:** https://api.solenrich.com/.well-known/x402
- **Agent card:** https://api.solenrich.com/.well-known/agent.json
- **x402scan:** https://www.x402scan.com/server/d9814c54-6fa6-4fa7-8b01-43a0ffbc7641
- **Smithery:** Listed with 15 MCP tools
- **Docs (agent-readable):** https://api.solenrich.com/docs

## Tags

solana, defi, blockchain, wallet, token, risk-score, enrichment, onchain-data, x402, micropayments, agent-to-agent, llm, mcp
