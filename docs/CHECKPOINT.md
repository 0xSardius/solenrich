# Session Checkpoint

## Last session date
2026-04-15

## What was completed

### This session (April 15)
- **Jupiter Perps research — complete.** No REST API; all on-chain Anchor accounts. Full technical notes logged in CLAUDE.md Priority 10: program ID (`PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu`), 5 custody PDAs, borrow fee math (no funding rate — hourly compounding instead), position query via `getProgramAccounts` with memcmp owner filter, OI from `custody.assets.guaranteedUsd`/`globalShortSizes`. IDL from julianfssen/jupiter-perps-anchor-idl-parsing repo. Needs `@coral-xyz/anchor` install.
- **Listing profile created** — `docs/listing-profile.md` with description, 17 endpoints, pricing table, payment info, MCP config, discovery URLs. Reusable for Orbis, mcp.run, Glama, any marketplace.
- **Orbis API scouted** — orbisapi.com is JS-rendered SPA, no public provider self-serve. Has MCP tools for consumers (`browse_apis`, `subscribe_to_api`). Listing is founder-relationship-driven. User has founder connection.

### Previous sessions
- April 14: Birdeye integration (Priority 7, Phase 2A complete), Drift-to-Jupiter Perps pivot.
- April 12-13: Custom domain, x402scan, Smithery, dual-protocol payments, slippage (Priority 6), 15 MCP tools.
- April 9-10: llms.txt, signal capture (Priority 8), activity detection (Priority 5), strategy.
- April 5-8: Protocol analytics, OpenAPI, MPP rollout, holder_count fix, compare demo.
- April 2-3: Comparison, temporal, discovery endpoints. MPP Stage 1. SolScout E2E.

## Current state
- **Live API:** https://api.solenrich.com
- **Landing:** https://solenrich.com
- **MCP:** https://api.solenrich.com/mcp (15 tools)
- **Discovery:** https://api.solenrich.com/openapi.json + /.well-known/x402
- **x402scan:** https://www.x402scan.com/server/d9814c54-6fa6-4fa7-8b01-43a0ffbc7641
- **Smithery:** Listed, 15 tools, public
- **Payments:** Dual-protocol — x402 (Solana USDC, default) + MPP/Stripe (fiat)
- **Endpoints:** 17 paid + free demo + /docs + /openapi.json + /metrics + /.well-known/x402
- **Railway:** Auto-deploying from GitHub main branch
- **Everything committed, pushed, and deployed**

## Next session plan (ACTION ITEMS)

### 1. Jupiter Perps build — START HERE
Research is done, notes are in CLAUDE.md Priority 10. Build order:
1. `bun add @coral-xyz/anchor` — install Anchor SDK
2. Copy IDL from julianfssen/jupiter-perps-anchor-idl-parsing (`src/idl/jupiter-perpetuals-idl.ts`)
3. New `src/sources/jupiter-perps.ts` — JupiterPerpsClient with:
   - `getMarketStructure()` — fetch 3 custody accounts (SOL/BTC/ETH), compute borrow APR, utilization, OI long/short, oracle mark price
   - `getPositionsForWallet(address)` — getProgramAccounts with owner memcmp, decode positions, compute PnL
4. New `src/enrichers/perps-analyzer.ts` — PerpsAnalyzer enricher
5. New `src/formatters/llm-perps.ts` — LLM briefing
6. New `src/entrypoints/perps.ts` — `perps-market-structure` ($0.012) + `perps-trader-profile` ($0.010)
7. Register in agent.ts, add MCP tools, add to OpenAPI spec, add to /docs
8. Test, commit, push, deploy

### 2. Orbis API listing — FINISH
- Share `docs/listing-profile.md` with Orbis founder (user has relationship)
- Draft outreach message if user wants one
- Submit listing

### Remaining roadmap
- **Priority 9 — Smart Money** — `trending-signals`, `smart-money-flow` (2-3 sessions)
- **Priority 11 — Smarter Query** — Multi-step orchestration (1 session)
- **Priority 12 — Portfolio Tracker** — From temporal snapshots (1 session)
- **Distribution:** mcp.run, Glama, x402 bazaar (community POST + evaluate CDP facilitator switch)

### Pending Responses
- **Helius partnership** — Application submitted 2026-04-09, awaiting response
- **tokens.xyz** — Tweeted from @solenrichHQ requesting API access, awaiting response
- **Bags Hackathon** — Submitted, judging pending

## Blockers
- **@solana/kit must stay at 5.5.1** — 6.x causes @solana/errors runtime crash in Bun
- **@coral-xyz/anchor compatibility** — needs verification with Bun runtime before building perps client
- **Stripe E2E untested** — MPP middleware works but no real card payment yet

## Key decisions made
- **Jupiter Perps via Anchor IDL, not REST** (2026-04-15) — No REST API exists for Jupiter Perps. All data lives in on-chain accounts (Pool, Custody, Position). Access via `@coral-xyz/anchor` Program + IDL. Uses borrow fees instead of funding rates.
- **Perps pivot: Jupiter Perps, not Drift** (2026-04-14) — Drift hacked for $285M, API offline, TVL collapsed. Jupiter Perps is now dominant Solana perps DEX.
- **Birdeye with graceful fallback** (2026-04-14) — supplements but never blocks enrichment
- **x402 as default protocol** — MPP only on explicit `Authorization: Payment` header
- **MCP tool parity** — every endpoint gets a matching MCP tool

## Key values
- **Agent Asset:** 5rsdgYL8mETFm785mXpEMYftjSE3H4JSqFANhJ4BoTHk
- **Operational Wallet:** 5ijYechYmQfQFvWKsX9bgCqDnKV1amiriyt5RLmd877y
- **Agent Wallet:** 66Qvhr1xnwqbCT36KfHfZF1JpoWdmCQ3uFYTN335CGXe
- **SolScout Wallet:** H3UyiWm1YTzSKxXTpyssxxEreq6HzWTwNW5BVYewmmfC
- **Railway project ID:** 4f26f635-bbc8-440c-8539-afd3d7bea0bb
- **Vercel project:** 0xsardius-projects/landing
- **x402scan ID:** d9814c54-6fa6-4fa7-8b01-43a0ffbc7641
- **Jupiter Perps Program:** PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu
- **JLP Pool PDA:** 5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq
