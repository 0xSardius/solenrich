# Session Checkpoint

## Last session date
2026-04-20

## What was completed

### This session (April 20) — DISTRIBUTION + MARKETPLACE LISTINGS

- **Orbis API listing LIVE.** Two tiers: Free Demo (10 req/hr per IP via `/demo/enrich`) and Pay-per-call ($0.001–$0.020 USDC). All 19 endpoints cataloged with descriptions and schemas. Payouts on Base USDC, 90% revenue share to us, 10% Orbis. Base payout wallet: `0x866112E2C9E9F61422Df8b83DC8EcEe9883cF8a5`. Referral code: `683TDRYV` (25% lifetime).
- **Bazaar discovery metadata shipped** (`9f7a0aa`). Declared `extensions.bazaar` on every route using `@x402/extensions/declareDiscoveryExtension`. This was the missing piece for agentic.market auto-cataloging — CDP needs the bazaar extension to be declared on routes, otherwise settlements aren't indexed. Verified paid flow still works after change (19/19 passed).
- **Discovery surface hardened** (`03a863d`). Added `/llms.txt` handler (was 404 — now returns markdown catalog with all 19 endpoints + pricing). Enriched `/.well-known/x402` from barebones resource list to full schema match for agentic.market ingestion (service metadata + per-endpoint pricing/description).
- **Landing page hackathon surface sharpened** (`cad8635`). Update banner now leads with "Jupiter Perps — market structure & trader profiles" and "Live USDC settlements via Coinbase CDP" — the two freshest differentiators.
- **Square logo shipped** (`957af57`). `logo_black_bg.png` copied to `landing/logo.png`, served at `https://www.solenrich.com/logo.png`. Used on Orbis listing.
- **Full paid E2E re-verified at end of session.** 19/19 passed, avg 6673ms. ~$0.146 USDC in revenue this run, ~$0.30 across today's multiple test runs. All CDP settlements confirmed on-chain.
- **Diagnostic logs cleaned up** (`d47ae0d`). Removed `[x402-dbg]` and `[402] middleware body` logs that helped find the MPP-overwrite bug.

### Previous session (April 19) — PAID FLOW FIXED
- **Paid E2E WORKING for the first time in weeks.** 19/19 endpoints returning 200 with real USDC settlements via CDP facilitator. Full SolScout stress run: `TOTAL: 19/19 passed | 0 failed | avg 6034ms`. ~$0.146 USDC revenue landed in agent wallet.
- **Facilitator swap: payai.network → Coinbase CDP** (`https://api.cdp.coinbase.com/platform/v2/x402`). Uses `@coinbase/x402@2.1.0` package; reads `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET` from env.
- **Root cause of broken paid flow (found today):** MPP middleware was registered unconditionally on every invoke route. It ran AFTER our x402 wrapper in the Hono chain and overwrote x402's response with its own 402 challenge (paymentauth.org RFC 7807 format). Clients saw a 402 even for successful x402 payments.
- **Fix:** gated MPP's `chargeHandler` behind `Authorization: Payment` header check. MPP only runs when an MPP credential is genuinely present. Preserves dual-protocol behavior (x402 default, MPP opt-in via explicit header).
- **Stability win:** added graceful fallback around x402ResourceServer.initialize(). If CDP auth fails (bad key, down facilitator), the server logs clearly and keeps MPP + free endpoints running instead of crash-looping Railway.
- **CDP API key scopes required:** Trade + Transfer + Receive + View (empirically — docs are silent). View-only returns 401.
- **CDP facilitator rotates fee payer per request** — no cache issue since challenge and verify use the same snapshot.
- **Automatic bazaar listing:** should appear on x402 bazaar within ~24h now that CDP sees real settlements from us.

### Previous session (April 18)
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
- **Early traction (2026-04-21):** 2 Orbis-routed x402 calls already landed within ~18h of listing going live. Agents discovering us through new channels.
- **Hackathon rank:** #37 on Bags leaderboard, prize-eligible
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

### 1. Check agentic.market listing — did we appear?
- First settlement with bazaar metadata was last night (2026-04-20 evening). CDP's indexer should have cataloged us within hours.
- Query `https://api.agentic.market/v1/services` — look for "SolEnrich" / Parallax Labs / our domain
- If still not listed after ~24h: DM the Orbis / CDP x402 team. Our discovery surface is primed (`/llms.txt`, enriched `/.well-known/x402`, bazaar metadata on routes), so any blocker is on their side.

### 2. Check x402 bazaar listing appeared
- Same ~24h window as agentic.market. Check bazaar.x402.org or CDP's bazaar listing page.

### 3. Orbis follow-ups
- Confirm Orbis listing is live (check orbisapi.com directory)
- Watch Orbis dashboard for first x402 settlement routed through them
- Consider publishing our referral code (`683TDRYV`) in `/docs` and `/llms.txt` — earns 25% lifetime on any x402 call that includes `x-referral-code: 683TDRYV` header
- If Orbis sends GET to our POST-only endpoints (we saw 404 on their preview), flag it to their founder

### 4. Real Jupiter Perps trader verify (deferred from April 18)
- `perps-trader-profile` tested against Solana Foundation wallet (no positions) — shape checks pass but we never verified with actual open positions
- Find a trader via Jupiter Perps leaderboard or on-chain `getProgramAccounts` search
- Run paid call, confirm PnL/leverage/flags render correctly with real data

### 5. Social / hackathon surface
- Landing page banner now leads with Jupiter Perps + live CDP settlements (`cad8635`). Hackathon judges probably check.
- Consider a Twitter thread: "shipped Jupiter Perps intelligence + first Solana-native x402 on Coinbase CDP + listed on Orbis" — three concrete proof points in one session
- Bags hackathon submission could use an update reflecting today's distribution wins

### 6. Side-quest — Bags hackathon demo video

**Status:** Requested by Bags team. Currently ranked #37 on hackathon leaderboard. Prize-eligible. Deadline: TBD (confirm when user has date).

**Constraint:** SolEnrich has no UI — it's a B2B API. Need a visceral "holy shit" moment in the first 15 seconds to keep scroll-weary judges.

**Judging criteria to hit:**
- Product traction (MRR, DAU, GitHub stars) — ✅ we have: 2 Orbis calls already, real x402 settlements
- Onchain performance (volume, active traders, revenue) — ✅ we have: CDP settlements visible on x402scan
- Uniqueness — ✅ we have: Jupiter Perps intelligence (no other Solana enrichment API offers this)

**Three demo shapes to choose from:**

#### Option A — Agent-making-a-real-decision (highest impact)
- 60s narrative: Claude Desktop with SolEnrich MCP. User asks "Should I long BONK?" Claude calls `enrich-token-full`, `due-diligence`, `perps-market-structure` live. Real USDC settles. Returns synthesized answer.
- Strengths: Hits agent-native workflow, shows Jupiter Perps, showcases MCP + x402 together
- Production: 30min record + 30min edit. Need Claude Desktop + MCP configured + SolScout wallet funded
- Risk: Claude's answer might not be impressive if endpoints return boring data — would want to cherry-pick a token with interesting risk signals

#### Option B — Proof-of-traction terminal montage
- Terminal split-screen: SolScout paid stress test + Orbis dashboard + x402scan
- Watch all 19 endpoints settle in real time
- End on Jupiter Perps market structure output
- Strengths: Literally shows the judging criteria happening (traction + onchain performance)
- Production: Very low — one clean recording of a stress run + dashboards
- Risk: Less narrative, more technical — might not resonate with non-dev judges

#### Option C — Raw-vs-enriched side-by-side
- Split screen: Solana Explorer (hex wall) vs SolEnrich parse-transaction briefing ("Swapped 100 USDC for 50 JUP on Jupiter at $2.00")
- Strengths: Most visceral "holy shit" moment, no agent/x402 context needed
- Production: Lowest — one side-by-side screen capture
- Risk: Doesn't showcase agents/payments/Jupiter Perps — underplays our moats

#### Recommended composite (90s total)
- **0-30s:** Option A (agent making a decision, includes Jupiter Perps)
- **30-60s:** Option B (payment trail, x402scan + Orbis dashboard, real USDC moving)
- **60-75s:** Stats overlay — "19 endpoints, 2 marketplace listings, real revenue in 2 days"
- **75-90s:** Logo + CTA (api.solenrich.com + Orbis link)

**Needs from user:**
- Pick shape (A, B, C, or composite)
- Confirm submission deadline
- Decide: record in one take vs edit multiple clips
- Pick the token to demo against (needs interesting risk signals for Option A to land)

**Asset checklist if we go ahead:**
- Claude Desktop with `@solenrich` MCP configured
- SolScout wallet topped up (currently ~$3.88 USDC — enough for ~150 paid calls)
- Clean terminal theme + one test token ready
- Logo intro/outro cards (logo_black_bg.png already shipped)
- Demo music (optional) — royalty-free

### 7. Remaining roadmap
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
- **Stripe E2E still untested** — MPP middleware is now correctly gated behind `Authorization: Payment` header. Without a test Stripe card we haven't confirmed end-to-end, but structural routing verified (no-auth requests get x402 challenge, not MPP).

## Key decisions made
- **MPP must be gated behind `Authorization: Payment` header** (2026-04-19) — Hono continues middleware chain after x402 returns a response. MPP registered as unconditional `app.use()` would overwrite x402's result. Always wrap MPP's chargeHandler in a check that calls `next()` when there's no MPP credential.
- **CDP API keys require Trade + Transfer + Receive + View scopes** (2026-04-19) — View-only returns 401 from the facilitator. Docs don't document which scope gates x402 specifically; enabling all four is the safe path.
- **Facilitator: Coinbase CDP, not payai** (2026-04-19) — payai.network's v2 schema drifted from @x402/core 2.6 (expects `accepted` nested in `paymentPayload` vs the SDK's top-level `paymentRequirements`). CDP speaks the current schema and supports Solana mainnet. Bonus: bazaar auto-listing.
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
