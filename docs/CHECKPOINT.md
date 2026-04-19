# Session Checkpoint

## Last session date
2026-04-18

## What was completed

### This session (April 18)
- **Jupiter Perps shipped — DONE.** Priority 10 complete. Two new paid endpoints live: `perps-market-structure` ($0.012) + `perps-trader-profile` ($0.010). 19 total endpoints now.
  - `@coral-xyz/anchor@0.29.0` installed (downgraded from 0.32; 0.32 expects new IDL format, reference IDLs are 0.29-era)
  - Jupiter Perps + Doves oracle IDLs in `src/idl/`
  - `src/sources/jupiter-perps.ts` — on-chain Anchor account reader: 3 tradable custodies (SOL/BTC/ETH), borrow APR via jump-rate curve, OI from `guaranteedUsd`+`globalShortSizes`, Doves oracle mark prices, positions via `getProgramAccounts` memcmp filter
  - `src/enrichers/perps-analyzer.ts` — market risk flags, headroom, HEALTHY/TILTED/STRESSED; trader classification (scalper/swing/position), PnL totals, leverage/liquidation flags
  - `src/formatters/llm-perps.ts` — readable market + trader briefings
  - `src/entrypoints/perps.ts`, registered in agent.ts + MCP tools + OpenAPI spec + /docs
  - Live tested: SOL $86 / BTC $75.8K / ETH $2.35K, total OI ~$80M, 10-12% APR, json + llm both work
  - **Scaling gotchas** (logged in CLAUDE.md): `targetUtilizationRate` uses RATE_POWER (1e9) NOT BPS_POWER; jump-rate bps values are ANNUALIZED APR, NOT hourly
- **Orbis API listing — 500-char summary drafted** (in chat history, ready to send to founder)

### Previous sessions
- April 15: Jupiter Perps research + listing profile + Orbis scouting.
- April 14: Birdeye integration (Priority 7, Phase 2A complete), Drift-to-Jupiter Perps pivot.
- April 12-13: Custom domain, x402scan, Smithery, dual-protocol payments, slippage (Priority 6), 15 MCP tools.
- April 9-10: llms.txt, signal capture (Priority 8), activity detection (Priority 5), strategy.

- April 5-8: Protocol analytics, OpenAPI, MPP rollout, holder_count fix, compare demo.
- April 2-3: Comparison, temporal, discovery endpoints. MPP Stage 1. SolScout E2E.

## Current state
- **Live API:** https://api.solenrich.com
- **Landing:** https://solenrich.com
- **MCP:** https://api.solenrich.com/mcp (17 tools after this session's deploy)
- **Discovery:** https://api.solenrich.com/openapi.json + /.well-known/x402
- **x402scan:** https://www.x402scan.com/server/d9814c54-6fa6-4fa7-8b01-43a0ffbc7641
- **Smithery:** Listed, public (will update to 17 tools on next deploy)
- **Payments:** Dual-protocol — x402 (Solana USDC, default) + MPP/Stripe (fiat)
- **Endpoints:** 19 paid + free demo + /docs + /openapi.json + /metrics + /.well-known/x402
- **Railway:** Auto-deploying from GitHub main branch

## Next session plan (ACTION ITEMS)

### 1. Verify perps endpoints on production
- After push, confirm Railway redeploys cleanly (@coral-xyz/anchor 0.29 is a new dep)
- Hit `https://api.solenrich.com/entrypoints/perps-market-structure/invoke` — expect 402
- Update test-endpoints agent + `test/test-all-endpoints.ts` to cover perps routes
- Find a real Jupiter Perps trader wallet (via on-chain search or Jupiter leaderboard) and test `perps-trader-profile` with real positions

### 2. Coinbase facilitator swap (payai.network → CDP) — FIXES PAID FLOW
- **This is now the recommended fix for the broken paid E2E.** See action #4 for the root-cause debug.
- **CDP facilitator URL:** `https://api.cdp.coinbase.com/platform/v2/x402`
- **Supports:** Solana mainnet `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (confirmed 2026-04-18 via docs.cdp.coinbase.com/x402/network-support)
- **Auth:** Requires CDP API keys. Free tier 1000 tx/mo, then $0.001/tx.
- **Bonus:** Automatic x402 bazaar listing = free distribution channel.
- **Why this fixes the paid flow:** CDP speaks the current @x402/core 2.6 request schema. payai.network's v2 schema has drifted — it expects `accepted` nested inside `paymentPayload`, while @x402/core sends `paymentRequirements` as a top-level field. That mismatch is why every paid request gets 400-rejected by payai and falls back to 402.
- **Swap steps:**
  1. Create CDP project at portal.cdp.coinbase.com, generate API keys
  2. Set `FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402` on Railway
  3. Wire CDP auth headers into `HTTPFacilitatorClient` construction in `src/lib/agent.ts` (currently passes only `{url}` — need to add auth header callback)
  4. Test a single paid request with SolScout
  5. Verify x402scan listing still shows us, confirm bazaar listing appears
- **Risk:** Low. `FACILITATOR_URL` is already an env var. If CDP auth headers aren't wired correctly, middleware falls back to returning plain 402 (same failure mode we have now, doesn't break anything further).

### 3. Orbis API listing
- 500-char summary drafted in last chat — ready to send to founder
- Share `docs/listing-profile.md`
- Submit listing

### 4. Paid E2E broken — DIAGNOSED 2026-04-18
- **Root cause:** payai.network's v2 facilitator schema has drifted from @x402/core 2.6. payai expects `accepted` nested inside `paymentPayload`; @x402/core sends `paymentRequirements` as a top-level field. Every verify request gets 400 "invalid_payload: accepted expected object, received undefined" and our server falls back to 402.
- **Proof:** Replaying a captured payment with `accepted` nested in `paymentPayload` returned `{isValid: false, invalidReason: "transaction_simulation_failed", invalidMessage: "BlockhashNotFound"}` — a real validation pass that only failed on stale blockhash. Fresh request would settle.
- **Client side is clean:** SolScout signs correctly. Transaction structure verified: account[0]=feePayer (empty sig, correct), account[1]=SolScout (valid ed25519 signature). @x402/fetch pinned to 2.6.0.
- **Stress test `19/19 passed` was a false positive** — harness (stress.ts:366) treats 402 as pass. 482ms avg latency was the tell (never-enriched).
- **Fix path:** Action #2 above (swap to CDP facilitator). Single env var + auth wire-up. Low risk.
- **Do NOT** downgrade @x402 stack to 2.4, upgrade @solana/kit to 6.x, or reorder server middleware — all can break production, and none of them are the actual fix.

### 5. Remaining roadmap
- **Priority 9 — Smart Money** — `trending-signals`, `smart-money-flow` (2-3 sessions)
- **Priority 11 — Smarter Query** — Multi-step orchestration. Add perps routing ("SOL-PERP funding rate?") (1 session)
- **Priority 12 — Portfolio Tracker** — From temporal snapshots (1 session)
- **Distribution:** mcp.run, Glama, x402 bazaar (community POST + evaluate CDP facilitator switch)

### 4. Perps follow-ups (optional depth)
- Liquidation events — parse tx logs from event authority `37hJBDnntwqhGbK7L6M1bLyvccj4u55CCUiLPdYkiqBN`
- Cross-venue expansion — Adrena, Zeta, Mango next quarter
- Perps-aware orchestration — fold market structure into `due-diligence` when token has perp exposure

### Pending Responses
- **Helius partnership** — Application submitted 2026-04-09, awaiting response
- **tokens.xyz** — Tweeted from @solenrichHQ requesting API access, awaiting response
- **Bags Hackathon** — Submitted, judging pending

## Blockers
- **@solana/kit must stay at 5.5.1** — 6.x causes @solana/errors runtime crash in Bun
- **@coral-xyz/anchor pinned to 0.29.0** — 0.32+ requires new IDL format (address/metadata fields); reference IDLs are v0.29 era. Verified working under Bun 1.2.21.
- **Stripe E2E untested** — MPP middleware works but no real card payment yet

## Key decisions made
- **Anchor pinned to 0.29.0** (2026-04-18) — reference Jupiter Perps IDL format predates Anchor 0.30's new IDL schema. Staying on 0.29 until we're ready to regenerate IDLs (not urgent).
- **Annualized APR interpretation of jump-rate bps** (2026-04-18) — empirically verified: raw `targetRateBps=3500` at 7% utilization produces 12% APR, matching observed Jupiter Perps rates. Rates are annualized, not hourly.
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
