# Session Checkpoint

## Last session date
2026-04-14

## What was completed

### This session (April 14)
- **Priority 7 — Birdeye integration shipped** — Phase 2A complete.
  - `getDailyCandles(mint, days)` added to BirdeyeClient (`/defi/ohlcv?type=1D` with time_from/time_to).
  - BirdeyeClient instantiated in `agent.ts` (only when `BIRDEYE_API_KEY` set), passed into TokenAnalyzer.
  - `holder_count` now uses `birdeyeOverview.holder` — verified BONK 999K, JUP 837K, USDC 6.5M (was capped at 20 from RPC).
  - Volatility prefers Birdeye daily candles (real OHLCV) — falls back to DexScreener multi-timeframe estimate.
  - Price/symbol/name/marketCap/volume/liquidity also fall back to Birdeye if DexScreener fails.
  - Improves: enrich-token-light, enrich-token-full, due-diligence, compare-tokens, token-trend, new-tokens (automatic).
- `test/test-birdeye.ts` — smoke test for BONK/JUP/USDC.

### Previous sessions
- April 12-13: Custom domain (api.solenrich.com), x402scan listing, Smithery listing, dual-protocol payments, slippage estimates (Priority 6), 15 MCP tools.
- April 9-10: llms.txt, signal capture (Priority 8), activity detection (Priority 5), Drift scoped, strategy workshopped.
- April 5-8: Protocol analytics, OpenAPI discovery, MPP full rollout, holder_count fix, compare demo.
- April 2-3: Comparison, temporal, discovery endpoints. MPP Stage 1. SolScout E2E.
- March 26-29: Demo, OG tags, test suite, Railway reconnect.

## Current state
- **Live API:** https://api.solenrich.com
- **Landing:** https://solenrich.com
- **MCP:** https://api.solenrich.com/mcp (15 tools)
- **Discovery:** https://api.solenrich.com/openapi.json + /.well-known/x402
- **x402scan:** https://www.x402scan.com/server/d9814c54-6fa6-4fa7-8b01-43a0ffbc7641
- **Smithery:** Listed, 15 tools, public
- **Payments:** Dual-protocol — x402 (Solana USDC, default) + MPP/Stripe (fiat, on Authorization: Payment header)
- **Endpoints:** 17 paid + free demo + /docs + /openapi.json + /metrics + /.well-known/x402
- **New this session:** Birdeye integration — real holder counts + OHLCV-derived volatility on all token endpoints
- **Railway:** Auto-deploying from GitHub main branch
- **Everything committed, pushed, and deployed**

## Next steps (prioritized)

### Phase 2A — Deepen Intelligence — COMPLETE
- All 4 priorities shipped (5: activity, 6: slippage, 7: Birdeye, 8: signal capture)

### Distribution (parallel, low effort)
2. **Orbis API listing** — Submit to orbisapi.com (founder connection, fellow hackathon participant)
3. **MCP directories** — mcp.run, Glama (Smithery done)
4. **Social launch** — Tweet thread on x402scan listing, slippage estimates, dual-protocol payments

### Phase 2B — Expand Orchestration
5. **Priority 10 — Perps Intelligence (PIVOT to Jupiter Perps)** — START TOMORROW. Drift hacked 2026-04-01 for $285M (DPRK, durable-nonce exploit), `data.api.drift.trade` offline, TVL collapsed. Pivot to Jupiter Perps (now dominant Solana perps DEX). Extend existing JupiterClient. Ship `perps-market-structure` + `perps-trader-profile` first (1-2 sessions). Defer orchestrated `perps-signals`. See CLAUDE.md Priority 10 for full scope. (1-2 sessions)
6. **Priority 9 — Smart Money** — `trending-signals`, `smart-money-flow` endpoints (2-3 sessions)
7. **Priority 11 — Smarter Query** — Multi-step orchestration (1 session)
8. **Priority 12 — Portfolio Tracker** — From temporal snapshots (1 session)

### Phase 2C — Sticky Infrastructure
9. Event-driven alerts (3-4 sessions)
10. Intelligence feed / proactive scanning (3-4 sessions)
11. SDK/client package (1-2 sessions)

### Phase 2D — Distribution (ongoing)
- Agent framework partnerships (Daydreams/Eliza docs)
- Own agents as proof points (Pythia, Tidal, Cardex)

### Pending Responses
- **Helius partnership** — Application submitted 2026-04-09, awaiting response
- **tokens.xyz** — Tweeted from @solenrichHQ requesting API access, awaiting response
- **Bags Hackathon** — Submitted, judging pending

## Blockers
- **@solana/kit must stay at 5.5.1** — 6.x causes @solana/errors runtime crash in Bun. Solana MPP blocked.
- **Stripe E2E untested** — MPP middleware works but no real card payment processed yet
- **MPPScan warnings** — Input schema warnings remain (mppx library limitation). Not blocking registration but not clean.

## Key decisions made
- **x402 as default protocol** — When no payment credential is present, x402 returns its 402 challenge. MPP only activates on explicit `Authorization: Payment` header. x402 is preferred, Stripe is fallback.
- **All endpoints on both protocols** — No splitting routes between x402 and MPP. Every endpoint accepts both.
- **Custom domain before registry listings** — Registered api.solenrich.com before submitting to x402scan/Smithery so the URL is portable.
- **MCP tool parity** — Every endpoint gets a matching MCP tool. Added to CLAUDE.md as a checklist item for new endpoints.
- **Slippage at 4 sizes** — $100, $1K, $10K, $100K gives agents full picture from retail to institutional.

## Key values
- **Agent Asset:** 5rsdgYL8mETFm785mXpEMYftjSE3H4JSqFANhJ4BoTHk
- **Operational Wallet:** 5ijYechYmQfQFvWKsX9bgCqDnKV1amiriyt5RLmd877y
- **Agent Wallet:** 66Qvhr1xnwqbCT36KfHfZF1JpoWdmCQ3uFYTN335CGXe
- **SolScout Wallet:** H3UyiWm1YTzSKxXTpyssxxEreq6HzWTwNW5BVYewmmfC
- **Railway project ID:** 4f26f635-bbc8-440c-8539-afd3d7bea0bb
- **Vercel project:** 0xsardius-projects/landing
- **x402scan ID:** d9814c54-6fa6-4fa7-8b01-43a0ffbc7641
