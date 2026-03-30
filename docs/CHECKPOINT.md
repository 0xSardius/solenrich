# Session Checkpoint

## Last session date
2026-03-29

## What was completed

### This session (March 26-29)
- **Interactive demo endpoint** — `POST /demo/enrich` with auto wallet/token detection, IP-based rate limiting (10/hr), CORS for Vercel
- **Landing page demo section** — search bar, example buttons (JUP, BONK, Solana Foundation), formatted/JSON toggle, rate limit counter
- **OG meta tags + image** — Open Graph + Twitter Card for rich link previews, OG image template + PNG
- **Test-endpoints subagent** — `.claude/agents/test-endpoints.md` for QA verification of all 11 endpoints
- **Full endpoint test suite** — `test/test-all-endpoints.ts` (55 tests, all passing) + `test/test-402-production.ts` (production paywall verification)
- **Token enrichment fix** — DexScreener retry on failure, increased timeout to 15s, don't cache failed enrichments (price=0)
- **Token detection fix** — corrected SPL Token Program ID for wallet-vs-token auto-detection
- **Railway reconnected to GitHub** — auto-deploy was disconnected, 2 weeks of updates were not deployed. Now connected and auto-deploying on push.
- **Considered expansions roadmap** — 6 prioritized features added to CLAUDE.md (comparison, temporal, discovery, protocol, aggregated intel, alerts)
- **Bags hackathon updates** — crafted 3 update texts (endpoints, data quality, demo)

### Previous sessions (March 22-24)
- Multi-source price aggregation (median of Helius + DexScreener + Jupiter)
- HHI holder concentration index
- Price volatility metrics (daily std, 7d range, severity classification)
- Risk-adjusted returns (Sharpe, Sortino, max drawdown, profit factor)
- 138 unit tests across 17 pure functions
- Landing page updated with all features

### Earlier sessions (March 17-21)
- Upstash Redis in production
- Enriched 402 response bodies
- Hardened endpoints (holder concentration, whale-watch rewrite, risk levels)
- Entity labeling (20+ known Solana addresses)
- Copy-trade PnL fix, query endpoint, 5 critical bug fixes
- MCP HTTP transport, social launch, Bags hackathon submitted

## Current state
- **Live API:** https://solenrich-production.up.railway.app/
- **MCP endpoint:** https://solenrich-production.up.railway.app/mcp
- **Landing page:** https://landing-rho-six.vercel.app
- **Demo endpoint:** https://solenrich-production.up.railway.app/demo/enrich
- **Payments:** ENABLED — all 11 endpoints return 402 with correct pricing
- **Cache:** Upstash Redis (production), don't-cache-failures logic on token enrichment
- **8004 identity:** Registered on mainnet
- **Endpoints:** 11 paid + 1 free demo
- **Tests:** 138 unit + 55 endpoint + production 402 verification
- **Railway:** Auto-deploying from GitHub main branch
- **Everything is committed, pushed, and deployed**

## Next steps (prioritized)

### Considered Expansions (new features)
1. **Multi-Entity Comparison** — `compare-tokens`, `compare-wallets` (1 session, no blockers, highest ROI)
2. **New Token Discovery** — `new-launches`, `token-screener` (2 sessions, killer for trading agents)
3. **Temporal Context** — `wallet-history`, `token-trend` (2-3 sessions, needs snapshot cron)
4. **Protocol Analytics** — `protocol-profile` (1-2 sessions)
5. **Aggregated Intelligence** — `trending-signals`, `smart-money-flow` (2-3 sessions)
6. **Event-Driven Alerts** — `subscribe-alerts` SSE streaming (3-4 sessions)

### SolScout consumer agent
- Standalone agent that uses SolEnrich as its data source
- Takes NL questions, calls SolEnrich, interprets results
- Proves agent-to-agent value prop for hackathon
- Lives in `agents/solscout/` directory

### Infrastructure
- CI pipeline — GitHub Actions for tsc + bun test on push
- MCP directory submissions (Smithery, mcp.run, Glama)
- Usage analytics — Upstash counters per endpoint per day
- Rate limiting — @upstash/ratelimit on invoke endpoints

## Blockers
- **Birdeye API** — still no key. Would unlock wallet portfolio endpoint.
- **DexScreener on Railway** — intermittently fails, fixed with retry logic but root cause may be Railway IP reputation.

## Key decisions made this session
- **Railway was disconnected from GitHub for ~2 weeks** — all post-March-17 updates were only in code, not deployed. Fixed by reconnecting repo.
- **Don't cache failed enrichments** — price=0 results no longer persist in Upstash
- **DexScreener gets one retry** — price data is too critical to skip on first failure
- **Demo uses light depth only** — minimizes API cost per free query
- **Rate limit: 10/hr per IP** — server-enforced + client-side localStorage counter
- **OG image hosted on GitHub raw** — Vercel wasn't serving static PNGs, GitHub raw works reliably
- **Subagent for QA** — test locally first to avoid burning production API calls

## Key values
- **Agent Asset:** 5rsdgYL8mETFm785mXpEMYftjSE3H4JSqFANhJ4BoTHk
- **Operational Wallet:** 5ijYechYmQfQFvWKsX9bgCqDnKV1amiriyt5RLmd877y
- **Agent Wallet:** 66Qvhr1xnwqbCT36KfHfZF1JpoWdmCQ3uFYTN335CGXe
- **Railway project ID:** 4f26f635-bbc8-440c-8539-afd3d7bea0bb
- **Vercel project:** 0xsardius-projects/landing
