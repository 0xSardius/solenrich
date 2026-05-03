# Session Checkpoint

## Last session date
2026-05-03

## What was completed

### This session (May 3) — DERIVATION ACTIVATED + /DOCS PAGE LIVE + FEED V1 LOCKED IN

**Five tasks closed, four commits shipped, one core feature decision made.**

- **Smart-money derivation activated on production** (`d06c2d7`). Lowered `TRENDING_MIN_LIQUIDITY` 50K → 15K (matches what `new-tokens` typically returns on current pump.fun-class trending) and `TRENDING_TOKEN_LIMIT` 10 → 5 (gentler on Birdeye free-tier rate limits during cold-cache derivation). Paid stress now reports **21/21 with `seed_source === 'derived'`** strict check passing — first production activation. Cold-cache derivation runs ~28s; cached 7d after.
- **`/docs` page shipped at solenrich.com/docs** (`f2ad054`, `b0b3462`). New `landing/docs.html` is design-matched to the landing site and fetches `api.solenrich.com/docs` JSON dynamically. Renders Quick Start, Payment, Output Formats, all 21 endpoint cards (with live filter input), Risk Methodology, Data Sources, Entity Labeling. Sticky sidebar nav with anchors + discovery links (openapi.json, llms.txt, /.well-known/x402, MCP server). Vercel `cleanUrls: true` enables the no-extension URL.
- **Birdeye added to landing data sources card** (5 → 6 sources). Birdeye has been wired in since Apr-14 (Priority 7) but landing claimed 5.
- **`perps-trader-profile` verified against a real Jupiter Perps trader** (`BvgzoCUMgtos1KRsWwLoabt2a35ErqphzAV3xYEJzrRu`, 5 open positions, $35K gross exposure, 1.82x weighted leverage). Output is dramatic: `-61% net_pnl_pct` on collateral, all position flags firing (`losing_collateral`, `approaching_liquidation`, `stale_position`), holding a SOL long opened 209 days ago through ~30% drawdown. **Better demo material than what we used in the original Bags video.** Discovery utility committed at `test/find-perps-trader.ts` for future re-runs.
- **Hackathon May update tweet drafted** at `local/hackathon-bags/tweet-thread/update-may-v1.md`. Three hook options; recommended is "Two weeks after submitting…" infrastructure-led narrative. Don't post until handles + final stat refresh.
- **Next feature locked in: Intelligence Feed V1** — see Key decisions section. Defensibility × leverage scoring chose it over Smarter Query, Portfolio Tracker, Event-driven Alerts. Recurring-revenue model, ~$0 marginal cost, 1-2 sessions to build.

### Previous session (May 1–2) — SMART-MONEY DERIVATION + WHALE-WATCH FALLBACK + STRICTER STRESS

**Three commits, two verified-working fixes, one tuning issue caught by the new stricter stress.**

- **whale-watch Birdeye fallback shipped** (`ae640b8`). Same root cause + same fix shape as the Apr-26 token-analyzer fix, in a parallel code path that wasn't covered then. Helius `getTokenLargestAccounts` returns `[]` for tokens with ~500K+ holders (BONK, JUP, USDC, RAY); whale-watch silently returned an empty whales array. Now falls back to `birdeye.getTokenHolders` with owner+token_account passthrough so downstream signature lookups still work. Adds `holders_source` to `WhaleWatchEnrichment`. **Verified on production** — paid stress shows whale-watch 6/6 with `whale_count > 0` on BONK target.
- **Smart-money-flow programmatic seed derivation shipped** (`7956824`). Replaces the placeholder default seed list with derivation from current trending-token whale activity: discover top trending tokens → fetch top whales for each → pool unique candidates, exclude entity-labeled CEXes/protocols → cap at 50 → cache 7 days. BYO `wallets` path unchanged. New `seed_source: 'user' | 'derived' | 'fallback'` field for data provenance.
- **Solana Foundation wallet removed** from `DEFAULT_SMART_MONEY_SEEDS` (now 19 wallets). Cleanup that ships regardless of derivation path success.
- **Stress suite strengthened** (uncommitted). whale-watch now requires `whale_count > 0` and validates `holders_source`. smart-money-flow now drops the explicit `wallets` arg and asserts `seed_source === 'derived'` — surfaces derivation failures instead of masking them with shape-only checks.
- **Production paid stress: 20/21** (May 2). Single failure is the new strict `seed_source === 'derived'` check on smart-money-flow — derivation is running (~11s latency) but yielding < 5 candidates → falls back. **Most likely cause: TRENDING_MIN_LIQUIDITY=50K is too strict for current trending-token liquidity profile.** Tracked as Task #15.
- **agentic.market check** — still no SolEnrich listing among their 50 indexed services. Watching weekly.

### Previous session (April 26) — BIRDEYE HOLDER FALLBACK + STRESS COVERAGE 21/21 ✅

- **Resolved the `enrich-token-full` top-holders flake** (`48fcca4`). Root cause was clearer than expected: Helius `getTokenLargestAccounts` returns `[]` (not throws) for tokens with too many holders — already handled in `solana-rpc.ts:82` as a non-retryable case. The downstream issue was that `token-analyzer.ts:197` then silently skipped the entire holder block, dropping `top_holders`, `concentration`, and HHI.
- **Birdeye fallback wired in.** When `largestAccounts.length === 0` and Birdeye is configured, fall back to `birdeye.getTokenHolders(mint, 20)` (`/defi/v3/token/holder`, free tier). Birdeye returns owner addresses directly so the `resolveTokenAccountOwners` step is skipped on that path. Concentration recomputed from `uiAmount/supply` regardless of source for math consistency.
- **Latent bug fixed in birdeye client** while there. `getTokenHolders` was never used in production; its response mapping was wrong (Birdeye returns `{ owner, ui_amount, token_account }`, the code treated items as already-shaped Holder objects). Now properly maps `owner→address`, `ui_amount→uiAmount`. Caught only because we became the first consumer.
- **Added `holders_source: 'rpc' | 'birdeye' | 'unavailable'`** field to TokenEnrichment for data-provenance auditability.
- **Stress suite expanded to all 21 endpoints** (`615aebd`). Added `trending-signals` (limit=5, ~$0.05) and `smart-money-flow` (explicit `wallets=[TEST_WALLET]` to bypass the placeholder seed list, ~$0.10) with shape-only checks.
- **Verified end-to-end on production:** **21/21 passed**, avg latency 3804ms (down from 6232ms — Birdeye fallback is faster than the failing RPC retry on flake). `enrich-token-full` against BONK now passes 6/6 (was 2/6 all session).
- **Discovered: BONK / JUP / USDC all route through Birdeye now.** Helius RPC's "Too many accounts" limit kicks in around ~500K holders, not just at multi-million. Concentration math is source-independent, so no behavioral change for consumers — but it means the `rpc` path is reserved for sub-500K-holder tokens.

### Previous session (April 25) — BAGS HACKATHON DELIVERABLES SHIPPED ✅

- **Bags hackathon submission DELIVERED.** Demo video filmed + tweet thread + roadmap doc. All three artifacts in `local/hackathon-bags/` (gitignored).
- **paid-fetch RPC fix shipped** (`938c4d7`). Discovered upstream bug in `@x402/svm`'s `registerExactSvmScheme` helper — accepts a `{ rpcUrl }` config but never forwards it to the scheme constructor, so the scheme silently falls back to `api.mainnet-beta.solana.com`. Under @solana/kit's transport in Bun, that public RPC drops sockets on back-to-back JSON-RPC calls (`fetchMint` + `getLatestBlockhash`), surfacing as "Failed to create payment payload: socket connection closed unexpectedly." Fix: bypass the helper and register `ExactSvmScheme` + `ExactSvmSchemeV1` manually with `{ rpcUrl: heliusRpcUrl }`. **Worth filing upstream against `coinbase/x402` when there's time.** Verified with paid call against production — 6s end-to-end, real USDC settled.
- **Landing page bumped to 21 endpoints + Smart Money Orchestration cards** (`268be18`). Updated meta/OG/Twitter descriptions, hero subhead, section title (was 4 off — said "17 enrichment endpoints" while listing 19 cards). Added `trending-signals` ($0.050) + `smart-money-flow` ($0.100) cards. Bumped Smart Money Orchestration to lead position in the update banner.
- **Demo token scouted + selected.** ETH impersonator from earlier morning crashed too far for filming. Re-ran `new-tokens` + `due-diligence` in afternoon, picked **Barron / "The Insider Trencher"** (`2KXJZAUH3Vvnr1EdFbh97LME7STv7pxQF4Qc1Eefpump`) — 1885% pump in 24h, real whale accumulation data ($60K net flow visible), CAUTION verdict despite the pump. Best demo data we've ever scouted.
- **Demo script + voiceover written** — `local/hackathon-bags/demo/demo-script-v1.md` and `voiceover-v1.md`. Final recorded script used a different shape (first-person founder pitch rather than agent-narrative) — see Sardius's recorded script in chat history.
- **Tweet thread iterated v1 → v2 → v3.** Final v3 in `local/hackathon-bags/tweet-thread/thread-v3.md`. 5 tweets: hook+video / idea / traction / roadmap / CTA. Dropped competitor naming, kept first-person voice. Lead traction stat: **49 paid x402 calls via Orbis** (huge update from "2 within 18h" in v1).
- **Roadmap v1 written** — `local/hackathon-bags/roadmap/roadmap-v1.md`. ~1000 words, structured for technical judges.

### Previous session (April 23) — PRIORITY 9 SHIPPED (Smart Money Orchestration)

- **Two new composed-intelligence endpoints live** (`7665916`):
  - `trending-signals` ($0.050) — ranks trending tokens by composite signal (liquidity 20%, risk 40%, concentration 15%, whale flow 25%). Returns ranked list with per-token reasoning + overall sentiment (accumulation/distribution/mixed).
  - `smart-money-flow` ($0.100) — 3-phase pipeline: score seed wallets via copy-trade → filter to qualifying winners → surface accumulated tokens + wallet clusters. Accepts user-provided `wallets` array; falls back to curated default.
- **21 total endpoints** (was 19). Highest-margin calls in the catalog — 30-60x a basic enrich.
- **Paid E2E verified.** Both endpoints settled real USDC at 200. trending-signals 11.8s, smart-money-flow 10.1s. Full data shape checks passed.
- **Counter-positioning:** these are orchestration plays — 3-5 sub-enrichers composed per call. Raw-data incumbents (Helius/Nansen/Birdeye) structurally can't match this without sabotaging their existing subscription model.
- **Surface parity:** MCP tools, OpenAPI spec, `/docs`, `/llms.txt`, bazaar discovery metadata all updated.
- **Cache TTLs:** trending-signals 5min (trending shifts fast), smart-money-flow 10min (smart money shifts over days).

### ⚠ PINNED — smart-money-flow seed list quality (Priority 9.5)

**The issue:** Paid test returned 0 qualifying wallets on the default seed list. Root cause: the 20-wallet curated list shipped with Priority 9 is placeholder-quality — includes Solana Foundation (which doesn't trade) and 19 plausibly-formatted but unverified addresses. Filter requires ≥5 closed trades + ≥55% win rate; most seeds don't satisfy.

**What's working:** endpoint, payment flow, orchestration chain, graceful empty-state handling with clear LLM briefing explaining the fallback.

**What's broken:** the default seed data is bad, so out-of-the-box output is "no signal" for most callers.

**User's current stance:** pinned for consideration, not fixed yet.

**Three paths to decide between:**
1. **Programmatic derivation (recommended):** derive smart money from `whale-watch` top holders of trending tokens, score via copy-trade, cache winners as rotating seed list. Refreshes weekly. Compounding moat — we generate our own smart-money index from our own query pipeline. ~1-2 sessions to ship.
2. **Proper manual curation:** pull from Birdeye "top traders" leaderboard, public Twitter smart-money lists (Ansem etc.), Jupiter Perps top PnL wallets. Honest provenance per address. Manual maintenance.
3. **Stopgap cosmetic fix:** lower default `min_win_rate` to 0.35 so the endpoint looks populated. Makes the demo look good; doesn't give agents real signal. Last resort.

**Quick wins that apply regardless of path chosen:**
- Remove `vines1...` (Solana Foundation) from seed list — guaranteed-zero-trade wallet has no business in the seed
- Update `/docs` description to explicitly note the curated-list limitation and encourage agents to pass their own `wallets` array
- Endpoint continues to serve callers who BYO wallet list

### Previous session (April 22) — STRATEGIC ALIGNMENT + PRIORITY 5 CLOSEOUT

- **Counter-positioning strategy captured in CLAUDE.md.** Documented incumbents table (Helius/Nansen/Birdeye/Dune/DexScreener), our 5 natural advantages, guerilla warfare heuristics, top-3 moves ranked by defensibility × leverage, and explicit "what to deprioritize" list.
- **Intelligence Feed V1 vs V2 cost breakdown** — V1 ships in 1-2 sessions at ~$0 marginal, V2 triggers if 10+ daily polls within 2 weeks. Full plan in CLAUDE.md Priority 14.
- **Build sequencing decision locked in** — Smart Money Orchestration (Priority 9) ships BEFORE Intelligence Feed V1 because `trending-signals` becomes Feed's primary input. Same 4-5 sessions total, zero throwaway code.
- **Discovered Priority 5 was shipped 12 days ago** (`a27edf7`, 2026-04-10) but never marked DONE in CLAUDE.md. Functional layer live: 4 behavioral flags (regular_intervals, high_frequency, 24_7_active, repetitive_actions) + `automated_activity_pct` on protocol-profile. Drift 25%, Raydium 0% on initial test.
- **Priority 5 polish shipped** (`f78ae65`). Surfaced the flags in LLM briefings (llm-wallet, llm-protocol), added them to `/docs` + OpenAPI descriptions, wrote 5 unit tests covering detection functions. All additive — zero risk to paid flow.
- **Referral code + payment info published** (`9c1c9f9`). `/docs` and `/llms.txt` now include the Orbis referral header (`x-referral-code: 683TDRYV`) hint. Also fixed stale payai.network reference in `/docs` — now correctly advertises CDP facilitator.
- **Orbis traction grew: 2 paid x402 calls landed** within 18h of listing going live. First organic agent traffic through a marketplace channel.
- **Full paid E2E re-verified:** 18/19 passed (one pre-existing flaky failure on enrich-token-full's top-holders branch — not caused by today's changes). Payment settled 200 on all 19.

### Previous session (April 20) — DISTRIBUTION + MARKETPLACE LISTINGS

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
- **Bags hackathon: SUBMITTED 2026-04-25.** Demo + tweet thread + roadmap delivered. Awaiting judging.
- **All 21 paid endpoints serving real USDC on production.** Last paid stress (2026-05-03): **21/21 green**, avg 7902ms. Includes the strict `seed_source === 'derived'` check passing on smart-money-flow.
- **Public docs surface live at `solenrich.com/docs`.** Renders dynamically from `api.solenrich.com/docs` JSON.
- **Stress suite strengthened with data-quality checks** (committed `93fdbb1`). whale-watch requires `whale_count > 0`, smart-money requires `seed_source === 'derived'`. No more shape-only false positives.
- **Traction stat to update before tweet posts:** 49 paid x402 calls via Orbis as of recording day. Will likely be higher by post day — refresh the dashboard before posting Tweet 3.
- **Hackathon rank (pre-submission):** #37 on Bags leaderboard, prize-eligible
- **Live API:** https://api.solenrich.com
- **Landing:** https://solenrich.com (now reflects 21 endpoints + smart-money cards)
- **MCP:** https://api.solenrich.com/mcp
- **Discovery:** https://api.solenrich.com/openapi.json + /.well-known/x402 + /llms.txt
- **x402scan:** https://www.x402scan.com/server/d9814c54-6fa6-4fa7-8b01-43a0ffbc7641
- **Smithery:** Listed, public
- **Payments:** Dual-protocol — x402 (Solana USDC, default) + MPP/Stripe (fiat)
- **Endpoints:** 21 paid + free demo + /docs + /openapi.json + /metrics + /.well-known/x402 + /llms.txt
- **Railway:** Auto-deploying from GitHub main branch
- **paid-fetch:** Uses Helius RPC. Demo recordings reliable; public-RPC socket-close failures resolved.
- **Token holder data:** Auto-falls-back from Helius RPC to Birdeye when Helius hits the "Too many accounts" limit (~500K+ holders). Source visible via `holders_source` field.

## Next session plan (ACTION ITEMS)

### 0. Strategic context (reference, not action)
Session on 2026-04-21 established the counter-positioning thesis: SolEnrich wins as **agent-native first**, not dashboard-with-API. See `CLAUDE.md > Strategic Positioning` for full framework. Top 3 ranked moves by defensibility × leverage:
1. **Intelligence Feed V1** (Priority 14) — recurring-revenue model, hardest to clone
2. **Smart Money Orchestration** (Priority 9) — SHIPPED 2026-04-23 ✅
3. **Data Network Effect** (Priority 8 extension) — only we have agent query history

### 1. BUILD — Intelligence Feed V1 (Priority 14, locked in 2026-05-03)
**Scope (1-2 sessions, ~$0 marginal cost):**
- New endpoint `GET /feed/latest` paywalled at $0.005 (x402 + MPP)
- Daily Railway scheduled job calls `trending-signals` once internally, writes result to Redis under `feed:latest` (24h TTL)
- Endpoint reads cache, returns JSON. Zero upstream calls during agent polls.
- Add MCP tool, OpenAPI entry, /docs entry, /llms.txt entry, stress test
- List on Orbis as "SolEnrich Daily Brief — $0.005"
- Launch tweet announcing recurring-feed shape

**Files to add/modify:**
- `src/realtime/feed-cron.ts` — cron runner (Railway scheduled job entrypoint)
- `src/realtime/feed-store.ts` — Redis SET/GET wrapper
- `src/entrypoints/feed.ts` — paywalled GET handler
- `src/lib/agent.ts` — register `feed-latest` entrypoint
- `src/mcp-tools.ts`, `landing/docs.html` (auto-updates), `agents/solscout/stress.ts`

**Validation gate:** ≥10 daily pollers within 2 weeks of launch → ship V2 (SSE + webhooks). <3 → kill the surface or rethink framing.

**Open Q at session start:** Add `?since=<timestamp>` param to dedupe poll results? Probably yes — saves agents from paying for the same data they already saw.

### 2. POST-BAGS — post tweet threads + monitor
- **Original launch thread** at `local/hackathon-bags/tweet-thread/thread-v3.md` (5 tweets)
- **May update** at `local/hackathon-bags/tweet-thread/update-may-v1.md` — three hook options (recommended: A, infrastructure-led)
- Before posting either: refresh paid-call counts from Orbis dashboard, confirm `@bagsapp` / `@CoinbaseDev` / `@orbisapi` handles, confirm `agentic.commerce` vs `agentic.market` wording
- Consider adding the perps-trader-profile real-data finding (`BvgzoCUMg...`, -61% PnL, 5 positions) to the May update — concrete proof of the endpoint earning its keep

### 3. Intelligence Feed V1 details — see Section 1 above (now lead priority).

**Sequencing call:** Feed V1 can ship independently of smart-money-flow seed-list fix because the Feed only depends on `trending-signals`. So either order works.

**First consumers:** Our own agents (Pythia, Tidal, Cardex) — dogfoods the feed.

### 4. File upstream x402-svm bug
- `coinbase/x402` — the `registerExactSvmScheme` helper in `@x402/svm/exact/client` accepts a config object but doesn't forward `rpcUrl` to the scheme constructor. Helper signature implies it should (per `signer-BMkbhFYE.d.mts` types).
- Reproduction is trivial; one-paragraph issue with a 3-line fix suggestion.
- Low-priority chore — we already worked around it locally — but earns goodwill in the x402 ecosystem.

### 5. agentic.market listing check
- We're queued (per their team, 2026-04-21). Discovery surface fully primed.
- Check back weekly: `https://api.agentic.market/v1/services` — look for "SolEnrich" / Parallax Labs / our domain.
- Already listed on x402scan, Orbis, Smithery.

### 6. Real Jupiter Perps trader verify (deferred from April 18)
- `perps-trader-profile` shape-tested against Solana Foundation wallet (no positions). Need a real-world verification with actual open positions.
- Find a trader via Jupiter Perps leaderboard or on-chain `getProgramAccounts` search. Run paid call, confirm PnL/leverage/flags render with real data.

### 7. Fix `enrich-token-full` top-holders flakiness (LOW PRIORITY)
- See "Known Bugs" section. Add retry/fallback for `getTokenLargestAccounts` timeouts. Maintenance session work — not blocking anything.

### 8. Remaining roadmap (Phase 2B+)
- **Priority 11 — Smarter Query** — Multi-step orchestration. Add perps routing ("SOL-PERP funding rate?") (1 session)
- **Priority 12 — Portfolio Tracker** — From temporal snapshots (1 session)
- **Priority 13 — Event-Driven Alerts** — Build order: poll → SSE → webhooks (3-4 sessions)
- **Priority 15 — SDK Package** — `@solenrich/client` typed TS client with auto-payment (1-2 sessions)
- **Distribution:** mcp.run, Glama, x402 bazaar deepening
- **Multi-chain expansion** — Base + Ethereum (moonshot)

### 9. Perps follow-ups (optional depth)
- Liquidation events — parse tx logs from event authority `37hJBDnntwqhGbK7L6M1bLyvccj4u55CCUiLPdYkiqBN`
- Cross-venue expansion — Adrena, Zeta, Mango next quarter
- Perps-aware orchestration — fold market structure into `due-diligence` when token has perp exposure

### Pending Responses
- **Helius partnership** — Application submitted 2026-04-09, awaiting response
- **tokens.xyz** — Tweeted from @solenrichHQ requesting API access, awaiting response
- **Bags Hackathon** — Submitted, judging pending

## Known Bugs (non-blocking)

### `enrich-token-full` top-holders flakiness — RESOLVED 2026-04-26 ✅
- **Symptom (was):** SolScout paid stress against BONK showed 2/6 checks pass on `enrich-token-full` — `top_holders`, `pct_supply`, `concentration`, `HHI` all missing.
- **Real root cause (found 2026-04-26):** not a timeout. Helius `getTokenLargestAccounts` returns `[]` (handled, non-throwing) when a token has too many holders for the RPC index — happens to BONK / JUP / USDC and any token with ~500K+ holders. `token-analyzer.ts` then silently skipped the entire holder block (gated on `largestAccounts.length > 0`).
- **Fix shipped (`48fcca4`):** Birdeye fallback in `token-analyzer.ts`. When Helius returns `[]`, fall back to `birdeye.getTokenHolders(mint, 20)` (free tier `/defi/v3/token/holder`). Birdeye returns owner addresses directly, so `resolveTokenAccountOwners` is skipped on that path. Concentration math recomputed from `uiAmount/supply` regardless of source. Also fixed a latent response-mapping bug in the Birdeye client (`getTokenHolders` was never used before; mapping was wrong).
- **Verified:** USDC, BONK, JUP all return 20 holders + concentration with `holders_source: birdeye`. Production paid stress 21/21 green.

### `enrich-wallet-light` paid stress-mode hang (2026-04-25)
- **Symptom:** SolScout paid stress run reported `0/0 checks` on `enrich-wallet-light`. In the stress runner that means the request hung past the 30s AbortController limit OR returned a non-200/non-402 status — not a data-quality issue.
- **Root cause (found 2026-04-25):** `@x402/svm`'s `registerExactSvmScheme` helper **has a bug** — it accepts a `{ rpcUrl }` config but never forwards it to the scheme constructor. The scheme silently falls back to `https://api.mainnet-beta.solana.com`. Under @solana/kit's transport in Bun, that public RPC drops sockets on back-to-back JSON-RPC calls (the scheme makes 2: `fetchMint` for the USDC mint, then `getLatestBlockhash`). One drops, payment payload creation throws "socket connection closed unexpectedly."
- **Fix applied (2026-04-25):** `agents/solscout/paid-fetch.ts` now bypasses the broken helper and registers the schemes manually with `{ rpcUrl: heliusRpcUrl }`. Helius is paid, dedicated, doesn't drop sockets.
- **Verified:** paid demo call against production succeeded in ~6s, real USDC settled, full due-diligence briefing returned.
- **Upstream bug:** worth filing against `coinbase/x402` — the helper signature accepts a config (per `signer-BMkbhFYE.d.mts` types) but doesn't propagate `rpcUrl`. Workaround is straightforward (manual scheme registration) but the helper should just forward the option.
- **Stress-mode flakes still possible:** the enrich-token-full top-holders timeout is independent and unfixed (server-side Helius rate limit, separate issue).

## Blockers
- **@solana/kit must stay at 5.5.1** — 6.x causes @solana/errors runtime crash in Bun
- **@coral-xyz/anchor pinned to 0.29.0** — 0.32+ requires new IDL format (address/metadata fields); reference IDLs are v0.29 era. Verified working under Bun 1.2.21.
- **Stripe E2E still untested** — MPP middleware is now correctly gated behind `Authorization: Payment` header. Without a test Stripe card we haven't confirmed end-to-end, but structural routing verified (no-auth requests get x402 challenge, not MPP).

## Key decisions made
- **Next feature: Intelligence Feed V1** (2026-05-03) — chosen over Smarter Query, Portfolio Tracker, Event-driven Alerts on a defensibility × leverage scoring exercise. Wins on three axes: (1) creates a new revenue model (recurring polling) vs. improving existing endpoints; (2) hardest to clone — subscription/feed shape requires synthesis layer + per-call pricing + on-chain rails, three things incumbents structurally compromise to ship; (3) explicitly ranked #1 in CLAUDE.md > Strategic Positioning, sequenced after Smart Money Orchestration which is now shipped. Validation gate: 10+ daily pollers within 2 weeks of launch → ship V2 (SSE + webhooks). Marginal upstream cost ~$0 — fits inside Helius Pro + Birdeye free tier with the 24h Redis cache.
- **Stress checks should include data-quality assertions, not just shape** (2026-05-02) — `Array.isArray(d.whales)` passes for empty arrays. Real data quality (`whale_count > 0`, `seed_source === 'derived'`) catches silent fallbacks. Worth the small risk of stress flakiness because the alternative is bugs landing in prod undetected.
- **Derivation failure ≠ regression** (2026-05-02) — when smart-money-flow falls back to the curated list, agents still get a valid 200 response with the same data they got before today. The stress reports the failure because the new feature didn't activate, not because the endpoint broke. Important framing for future "production smoke test" debates.
- **Birdeye holder fallback fires only on `length === 0`** (2026-04-26) — don't second-guess Helius when it returned data. The "Too many accounts" branch in `solana-rpc.ts:82` is the only natural producer of empty arrays. Keeping the trigger condition narrow avoids accidentally rerouting valid RPC results.
- **`holders_source` field is permanent, not temporary** (2026-04-26) — debug-flavored fields are a category we want to keep adding. `holders_source: 'rpc' | 'birdeye' | 'unavailable'` lets agents audit data provenance and lets us track Birdeye fallback frequency without server logs. Pattern worth replicating elsewhere.
- **Concentration math is source-independent** (2026-04-26) — recompute `pct_supply = uiAmount / supply * 100` regardless of whether holders came from RPC or Birdeye. Don't trust upstream `percentage` fields. Same units, same formula, same answer.
- **paid-fetch must bypass `registerExactSvmScheme` helper** (2026-04-25) — the helper accepts a `{ rpcUrl }` config but doesn't forward it to `ExactSvmScheme`/`ExactSvmSchemeV1` constructors. The schemes silently fall back to public mainnet RPC, which drops sockets in Bun on back-to-back JSON-RPC calls. `agents/solscout/paid-fetch.ts` now registers the schemes manually with Helius RPC. Worth filing upstream against `coinbase/x402`.
- **Demo token sourcing — re-scout same-day** (2026-04-25) — fresh pump.fun tokens shift dramatically between scouting and recording. Original ETH impersonator (morning) crashed too far by afternoon. Re-ran `new-tokens` + `due-diligence` immediately before filming, picked Barron / "Insider Trencher" with real whale accumulation data. Lesson: scout the demo token within a 1-hour window of filming, not the day before.
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
