# Session Checkpoint

## Last session date
2026-03-21

## What was completed
- **Entity labeling** — static map of 20+ known Solana addresses (Binance, Coinbase, OKX, Jupiter, Raydium, Orca, Wormhole, etc.) tagged in wallet connected_wallets, whale-watch holders, and graph nodes
- **Copy-trade PnL fix** — replaced broken FIFO matching with average cost basis. Tracks per-token position cost and computes PnL on each sell against the running average
- **Query endpoint** — `/entrypoints/query/invoke` accepts freeform NL questions ("is X safe?", "wallet profile for X", "whales for X"), parses intent via keyword/regex matching, routes to the correct enricher. Returns helpful error with examples if intent unclear. Price: $0.003
- Social launch: DONE
- XGATE: not picking up Solana agents yet

## Current state
- **Live API:** https://solenrich-production.up.railway.app/
- **MCP endpoint:** https://solenrich-production.up.railway.app/mcp
- **Landing page:** https://landing-rho-six.vercel.app
- **Payments:** ENABLED — enriched 402 responses with pricing info
- **Cache:** Upstash Redis (production), in-memory (dev)
- **8004 identity:** Registered on mainnet
- **Endpoints:** 11 total (10 original + query)
- **All 12 phases COMPLETE + post-launch hardening done**

## Post-launch todo
- ~~Upstash Redis~~ DONE
- ~~Enriched 402 responses~~ DONE
- ~~Hardened endpoints~~ DONE
- ~~Entity labeling~~ DONE
- ~~Copy-trade FIFO fix~~ DONE
- ~~Query endpoint~~ DONE
- ~~Social launch~~ DONE
- MCP directory submissions (Smithery had connection issues, try again)
- XGATE registration (not picking up Solana yet)
- Webhook/SSE streaming — real-time whale alerts
- Rate limiting
- Usage analytics
- Test suite in CI (GitHub Actions)

## Key values
- **Agent Asset:** 5rsdgYL8mETFm785mXpEMYftjSE3H4JSqFANhJ4BoTHk
- **Operational Wallet:** 5ijYechYmQfQFvWKsX9bgCqDnKV1amiriyt5RLmd877y
- **Agent Wallet:** 66Qvhr1xnwqbCT36KfHfZF1JpoWdmCQ3uFYTN335CGXe
- **Railway project ID:** 4f26f635-bbc8-440c-8539-afd3d7bea0bb
- **Vercel project:** 0xsardius-projects/landing
