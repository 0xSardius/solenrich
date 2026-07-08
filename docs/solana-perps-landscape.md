# Solana Perps Landscape + Integration Feasibility (2026-06-19)

> Research brief: the state of the Solana perps scene and how feasible each venue is to integrate, in
> service of SolEnrich becoming the **first-class agent intelligence layer for Solana perps**. Pairs
> market research with an engineering feasibility matrix so venue-coverage work can be sequenced.

## The thesis (why this matters for SolEnrich)

The Solana perps scene is **accelerating and fragmenting at the same time** — 6+ live venues, a mix of
pool/AMM and orderbook/CLOB designs, no single venue at Hyperliquid scale, and a flood of agent-driven
volume. The analyst consensus names the gap precisely: *"no unified venue"* and *"fragmentation across
six competing platforms undermines collective competitiveness."* That's a **liquidity** problem the venues
must solve — but the **information** version of the same fragmentation is SolEnrich's opportunity. An agent
trading Solana perps must reconcile funding, basis, OI, slippage, and smart-money flow across many venues
with different data models. **Nobody is the normalization/intelligence layer across all of them** — which
is exactly what the `perps-cross-venue-*` spine already is. We don't need to win liquidity; we sit *above*
the venues as the single agent-callable intelligence surface.

## Scene state (macro)

- DEX perps now do **>$1T/month, ~25% of the global futures market**; DEX-derivatives share rose from ~2%
  (early 2024) to >10% (early 2026). ([ainvest](https://www.ainvest.com/news/solana-surging-perpetual-dex-volume-implications-blockchain-infrastructure-stocks-2601/))
- On Solana, **automated agents already drive >70% of DEX volume on peak days**; a Solana Foundation exec
  predicts ~99% of on-chain txns will be agent-driven within two years. Solana placed a machine-readable
  agent skill file at its site root; venues (Flash Trade, Clawpump) shipped MCP "prompt-to-transaction"
  execution. **The agent-native trading thesis is validating in real time.** ([bitget](https://www.bitget.com/news/detail/12560605189520), [cryptobriefing](https://cryptobriefing.com/autonomous-blockchain-transactions-growth/))
- Hyperliquid still owns **66–73% of all DEX perp flow, ~$7B/day** — the cross-chain benchmark (and why the
  `hyperliquid-*` endpoints matter).

## Venue map — June 2026

| Venue | Model | Status / note |
|---|---|---|
| **Pacifica** | Orderbook (CLOB) | ⚡ **Reportedly overtook Jupiter as Solana's #1 perp DEX by daily volume.** Founded Jan 2025 by ex-FTX COO + Binance/Coinbase/Jane St/OpenAI/DeepMind vets; mainnet Jun 2025; >$100B cumulative. Funding recalcs every 5s, hourly settle. **Caveat: pre-TGE airdrop season → volume rankings are likely inflated/wash-heavy; treat skeptically.** ([cryptorank](https://cryptorank.io/news/feed/be0df-pacifica-takes-the-top-spot-on-solana), [solanafloor — "flawed metric?"](https://solanafloor.com/news/pacifica-leads-solana-perps-volume-flawed-metric)) |
| **Jupiter Perps** | Pool (JLP) | Still the **organic leader** by OI / fees / sustained share (~$486B cumulative, ~$86M OI, JLP ~$1.6B). Don't over-index on the daily-volume "flippening." |
| **Drift** | Orderbook (DLOB) | ⚠️ **Relaunching before July 2026** — "security-first," perps-only, $148M Tether-led rescue, Ottersec+Asymmetric audits, USDT settlement. Historically the largest Solana orderbook perp. ([coindesk](https://www.coindesk.com/business/2026/05/05/drift-outlines-a-recovery-plan-for-users-after-usd295-million-dprk-linked-exploit)) |
| **Adrena** | Pool | #3-ish (~$3.87B cumulative). **Pivoted Mar 2026 to a Traditional-Markets / RWA perps DEX** — equities/commodities/forex, 100x, Autonom oracle. Ties to the RWA thread. (we already integrate Adrena) ([medium](https://medium.com/@r_15629/what-are-rwa-perps-e4c65f84211c)) |
| **Phoenix Perps** (Ellipsis) | Orderbook (CLOB) | **LIVE** (announced Breakpoint Dec 2025; multiple "launch" articles + live mobile trading by Jun 2026). Trading access waitlisted, but **market-data API is fully public** (`perp-api.phoenix.trade/exchange` → 200 JSON, no auth). Aims −⅔ trading cost; same team as the $1B+ Phoenix spot CLOB. ([ellipsislabs](https://www.ellipsislabs.xyz/blog-posts/introducing-phoenix-perpetuals)) |
| **Bullet** (ex-Zeta) | CLOB / appchain | Live since late Sep 2025, 1.2ms latency, "Hyperliquid of Solana," $ZEX→$BULLET. Purpose-built trading network (appchain/L2). ([mexc](https://www.mexc.com/news/1094009)) |
| **Flash Trade** | Pool-to-peer | Declined to <1% share, but agent-native (MCP), 500x forex/inverse RWA pairs. Open-source reference impl. |
| **GMTrade, Bulk, Imperial, JTX (Jito), PerpCore** | mixed | Smaller/newer names in "top Solana perp DEX" lists; low priority until they show sustained share. ([quicknode](https://www.quicknode.com/builders-guide/best/top-10-solana-perp-dexs)) |
| **Percolator** | L1-native (upcoming) | **Anatoly Yakovenko himself** building a SOL-native perp DEX. Not live. Watch. ([cryptonews](https://cryptonews.com/news/hyperliquid-vs-solana-liquidity-king-2026/)) |

**Read on the share confusion:** the leaderboard is genuinely contested — Pacifica leads reported daily
volume (airdrop-inflated), Jupiter leads organic/OI/fees, Drift is relaunching, Adrena went RWA. That
churn is *the argument for an aggregation layer*: no single venue is "the answer," so agents need a
neutral cross-venue intelligence surface.

## Integration feasibility matrix

How readable is each venue's data, and how it maps to SolEnrich's existing patterns (on-chain account
reads like Jupiter Perps/Adrena; HTTP/WS API like Hyperliquid `/info`). **Good news: most have HTTP APIs
or SDKs → integration effort ≈ the Hyperliquid `/info` work we just shipped, often easier than Adrena's
hand-Borsh decode.**

| Venue | Data access | How SolEnrich would read it | Effort | Priority |
|---|---|---|---|---|
| **Drift** | `@drift-labs/sdk` (TS) + DriftPy + **Data API** (historical+realtime, no indexing) + on-chain user/market accounts (DLOB built from on-chain accounts). Open-source `protocol-v2`. | Data API (REST) for market structure/funding; SDK or account reads for trader positions. Best surface of any venue. ([docs.drift.trade/developers](https://docs.drift.trade/developers)) | ~1 session | **#1** (relaunch timing + best surface + historically major) |
| **Pacifica** | **REST API + WebSocket + Python SDK** (docs.pacifica.fi). Orderbook impact prices, funding every 5s. | REST/WS like the Hyperliquid `/info` pattern in `perp-reference.ts`. | ~1 session | **#2** (current volume leader, CLOB, clean API) |
| **Flash Trade** | **REST API that indexes all on-chain program accounts in realtime over HTTP/WS** + Rust SDK + open-source `flash-perpetuals`. Pool-to-peer (like Jupiter/Adrena). | REST API, or reuse our pool-account read pattern. RWA/forex angle. ([docs.flash.trade](https://docs.flash.trade/)) | ~1 session | #3 (easy + RWA/forex coverage) |
| **Phoenix Perps** | **Rise SDK** (`@ellipsis-labs/rise`, TS+Rust) + **public REST** `perp-api.phoenix.trade` (`/exchange`, `/exchange/markets` → 200 JSON, no auth — verified 2026-06-19). On-chain CLOB. | REST via perp-api (or Rise SDK). **Live + public now** — data not gated despite trading waitlist. | ~1 session | **#3 (live + public, jumped queue)** |
| **Bullet** (ex-Zeta) | Appchain/L2 — old Zeta SDK (`@zetamarkets/sdk`) + REST data API are for *old Zeta*. Bullet likely needs its own (not-yet-public) API; data lives off Solana L1. | Bullet-specific API (TBD). Can't read via Solana RPC. | Unknown | #5 (blocked on public Bullet API) |
| **Percolator** | Not live. | — | — | Watch |

## Verified API probe (2026-06-22) — the "easy REST" premise corrected

Probed Phoenix and Flash live APIs directly (same diligence that's paid off before). **Finding: neither exposes clean REST funding+OI like Hyperliquid does.** The reliable pattern for Solana pool/CLOB venues is **on-chain reads** (how we already do Jupiter + Adrena), not REST.

- **Phoenix** (`perp-api.phoenix.trade`): mark price via REST (`/exchange/prices`, all markets incl. RWA/NVDA ✅). But current funding + OI are NOT in REST — the per-market endpoint and the OpenAPI spec both confirm only *static config* (funding interval, OI cap); live funding/OI is WebSocket-stream / on-chain only.
- **Flash** (`flashapi.trade`): `/pool-data` gives per-custody utilization + locked/owned (OI proxy) + price ✅ and exposes custody pubkeys. BUT the documented `/custodies` + `/perpetuals` + `/markets` routes return 404/empty on the live API, so explicit borrow rate + long/short OI split aren't cleanly REST-available either. Flash is a **Jupiter-Perps-lineage** program ("Solana perpetuals reference implementation"), so its on-chain custody layout likely mirrors Jupiter's — meaning our existing `JupiterPerpsClient` decode logic (jump-rate borrow APR + OI from custody state) probably ports to Flash on-chain using the custody pubkeys we already pulled from `/pool-data`.

**Implication:** there's no REST shortcut for Solana funding/OI. Two real paths to add a venue:
1. **On-chain reads** (our proven Jupiter/Adrena pattern) — robust, ~1 focused session per venue. **Flash is the best candidate** (Jupiter lineage → likely layout reuse; custody pubkeys in hand).
2. **CEX-style REST** — only CLOB venues with HL/dYdX-style APIs. **Pacifica** is the candidate (CLOB, CEX-style REST + a documented Funding Rates page) — unverified, deprioritized on mindshare, but may be the one venue with clean REST funding.

**Corrected recommendation:** do **Flash via on-chain** (reuse `JupiterPerpsClient` decode against Flash custody accounts) as the next focused session. Park Phoenix funding for a later on-chain pass (keep its REST mark price for basis). Re-evaluate Pacifica post-TGE (or probe its REST if we want a fast CEX-style add).

## Flash on-chain integration — COMPLETE (borrow+util 2026-06-23; OI/skew 2026-07-07)

**STATUS: DONE.** `src/sources/flash-perps.ts` (`FlashPerpsClient`) live in the cross-venue analyzer. Borrow APR (on-chain `borrow_rate_state.current_rate` @ offset 596, `/1e9` hourly → annualized) + utilization + mark (via `/pool-data`) verified live: SOL 0.21% APR @ 1.02% util, BONK 14.75% @ 42% util (Flash adds BONK, which Jupiter Perps lacks). Flows into `perps-cross-venue-funding`, `perps-venue-comparison`, `perps-basis-signal`.

**OI/skew SHIPPED 2026-07-07.** One gPA (~225 `Market` accounts, cached 30s) → decode `collective_position` (side @ 104, open_positions @ 126, size_usd @ 162, USD 6-dec) → aggregate long/short per symbol across all pools → `open_interest_usd` + `skew` + per-side notes on the Flash `VenueQuote`. Verified live and internally consistent (SOL: $278K long / 168 pos vs $504K short / 69 pos = short-heavy; size_amount × avg entry reconciles with size_usd exactly).

**⚠ CRITICAL DISCOVERY (2026-07-07): Flash delegated its accounts to MagicBlock ephemeral rollups.** Account OWNER is now the delegation program `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh`, NOT `FLASH6...` — `getProgramAccounts` on the Flash program returns ZERO; you must gPA the delegation program with the same discriminator filters. Data layouts unchanged; single-account reads by pubkey (our borrow-rate path) unaffected. Mainnet state is the rollup's periodic commit → reads can lag live rollup state slightly (fine at 30s cache granularity). This is also what "v2" is: the Basket/WebSocket redesign runs on the rollup. **The v2 REST dev endpoints (`flashapi.trade/v2/*`) that were live 2026-06-25 now 404** (docs still document them) — the flag-gated v2 client remains blocked on Flash shipping a stable prod API; v1 `/pool-data` still works.

Probed the chain directly (`test/flash-onchain-probe.ts`, `test/flash-idl-fetch.ts`). Path confirmed + de-risked:
- **Program ID:** `FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn`. Custody discriminator `01b830515d833f91` == Jupiter's → same `Custody` struct lineage (Solana Labs perps reference fork). Layout diverged though (Flash 704B vs Jupiter 2000B).
- **IDL fetched on-chain + saved:** `src/idl/flash-perpetuals-idl.json`. It's **new Anchor 0.30+ format** (incompatible with our pinned Anchor 0.29 — SAME as Adrena) → use **fixed-offset Borsh decode** (Adrena pattern), NOT the Anchor Program/IDL path.
- **Custody struct** (offsets derivable from saved IDL): `pool, mint, token_account, decimals, is_stable, depeg_adjustment, is_virtual, inverse_price, oracle(OracleParams), pricing(PricingParams), permissions, fees, borrow_rate(BorrowRateParams), token_amount_multiplier(u64), assets(Assets{collateral,owned,locked}), fees_stats, borrow_rate_state(BorrowRateState), bump, ...`. → utilization = locked/owned; borrow APR from `borrow_rate` + `borrow_rate_state`.
- **Key difference from Jupiter:** Flash splits OI OUT of Custody. `assets` is only `{collateral, owned, locked}` (no guaranteedUsd/globalShortSizes). **Open interest lives in the separate `Market` account** (Flash has a `Market` account; Jupiter packs OI into custody). So OI = a second decode.
- **RWA bonus:** Flash lists 34 markets incl. **SPY/NVDA/TSLA/AAPL/AMD/AMZN** (equities), **XAU/XAG** (metals), **EUR/GBP/USDJPY/USDCNH** (forex), **CRUDEOIL/NATGAS** (commodities), XAUt. Flash = crypto + tokenized-equity + forex + commodity perps in one venue (ties to the RWA wedge).

**~~Remaining: OI/skew~~ DONE 2026-07-07** (as planned, with one correction: gPA must target the MagicBlock delegation program, not `FLASH6...` — see the critical discovery above). Implementation in `FlashPerpsClient.getMarketOI()`; probe: `test/flash-oi-probe.ts`. `Market` layout: disc(8) + pool(32) + target_custody @ 40 + collateral_custody(32) + side @ 104 (enum None/Long/Short) + correlation + max_payoff_bps + permissions(4) + degen_exposure_usd + collective_position @ 126 (PositionStats: open_positions +0, update_time +8 [unused, always 0], avg_entry_price +16 [u64 price + i32 exp], size_amount +28, size_usd +36 → abs 162).

**Also open:** expose Flash's RWA/forex/commodity markets (SPY/NVDA/XAU/EUR/CRUDEOIL…) — a distinct RWA-perps surface; ties to the RWA wedge.

### Flash v2 API — HIGH PRIORITY (2026-06-25, Flash reached out to Sardius personally)

Docs: `https://docs.flash.trade/flash-trade/flash-trade-protocol/build-on-flash/flash-trade-api/flash-trade-v2` (sub-pages: `apireference.md`, `websocketstreaming.md`, `protocolconcepts.md`, `workflows.md`; docs are agent-native — support `.md?ask=`).

**v2 serves the Anchor-DESERIALIZED on-chain accounts as clean REST JSON — i.e. everything we hand-decoded via Borsh in v1, PLUS the OI we deferred. Verified live 2026-06-25:**
- `GET /v2/raw/markets` (98 markets) → `collectivePosition.sizeUsd` + `side` + `targetCustody` = **OI long/short per market** (closes the OI/skew gap — no getProgramAccounts/Borsh).
- `GET /v2/raw/custodies` (50) → `borrowRateState.currentRate` + `assets.owned/locked` = borrow APR + utilization.
- `GET /v2/prices` → mark price. `GET /v2/raw/pools`. All **unauthenticated REST**.
- v2 redesign (not relevant to our read-only use): one `Basket` per wallet; wallet state via WebSocket (`/v2/owner/{owner}/ws`).

**Caveat:** `/v2/health` reports `"env":"dev"` (live but staging; published 2026-06-17, 1 pool). Don't depend on a dev endpoint for production paid endpoints — gate prod use on v2 going prod-stable.

**Opportunity (the real prize):** Flash reached out personally → be the **first-mover / launch-partner integrator** ("the agent-native intelligence layer on Flash v2"); unlocks Flash's RWA/forex/commodity catalog as a unique agent-readable surface; co-marketing.

**Plan:** (1) **Sardius:** confirm v2 prod timeline + stable base URL + launch-partner co-marketing with the Flash contact. (2) Build a **v2-ready `FlashPerpsClient`** (pure REST; OI/skew included) behind a flag → flip to v2 day-one at prod. v1 borrow/util stays live meanwhile (no regression).

## Strategic recommendations (sequencing)

1. **Be Drift's day-one agent intelligence layer.** Relaunch is imminent (before July). First-mover window
   to cover relaunched Drift funding/OI/trader-profiles before anyone else. Best dev surface of any venue
   (SDK + Data API + on-chain accounts). We already keep its program ID in the labeler. **Time-sensitive.**
2. **Add Pacifica.** It's the contested #1 by volume and CLOB-based (diversifies our pool-heavy coverage).
   Clean REST/WS API. Even if its volume is airdrop-inflated, agents are trading there *now*.
3. **Then Phoenix** (live + public REST data API, verified 2026-06-19 — no longer beta-gated; institutional CLOB, cost-leader angle) and **Flash Trade** (easy REST + RWA/forex perps angle).
4. **Architecture is additive.** Each venue is a `VenueQuote`-style entry in the cross-venue model
   (`available: bool` + `unavailable_reason`); `best_entry` / `arbitrage_opportunities` recompute
   automatically — the same one-file-extension pattern used for Adrena and the HL reference legs.
5. **The HL smart-money work (3b) generalizes.** Once we read trader positions per venue (Drift SDK,
   Pacifica API), "Solana perps smart-money / aggregate positioning" becomes a cross-venue product — not
   just HL.
6. **RWA-perps is a wedge only we'd cover.** Adrena + Flash run equities/commodities/forex perps on Solana.
   "TradFi-perps intelligence for agents" ties the RWA thread to the perps suite.

## What this means for "first-class"

To be first-class across the *Solana* perps scene (not just Jupiter+Adrena), the cross-venue endpoints need
to span **Drift + Pacifica + Phoenix + Flash + Bullet** as they become readable. The feasibility research
says this is achievable in a handful of additive sessions — most venues expose HTTP APIs/SDKs. The moat
isn't any single venue; it's being the **only neutral, agent-native, pay-per-call intelligence surface that
normalizes across all of them** while each venue stays siloed in its own UI/API.

## Sources

Market: [ainvest](https://www.ainvest.com/news/solana-surging-perpetual-dex-volume-implications-blockchain-infrastructure-stocks-2601/) ·
[solanafloor (Jupiter/Adrena)](https://solanafloor.com/news/the-rapid-rise-of-perpetual-trading-on-solana-inside-the-rise-of-jupiter-and-adrena) ·
[cryptobriefing (vs HL)](https://cryptobriefing.com/solana-perps-vs-hyperliquid-analysis/) ·
[cryptonews (Percolator)](https://cryptonews.com/news/hyperliquid-vs-solana-liquidity-king-2026/) ·
[cryptorank (Pacifica #1)](https://cryptorank.io/news/feed/be0df-pacifica-takes-the-top-spot-on-solana)
Integration: [Drift devs](https://docs.drift.trade/developers) ·
[Pacifica funding/docs](https://docs.pacifica.fi/trading-on-pacifica/funding-rates) ·
[Phoenix Rise SDK](https://docs.phoenix.trade/sdk/rise) ·
[Flash Trade API](https://docs.flash.trade/flash-trade/flash-trade-protocol/build-on-flash/flash-trade-api) ·
[Zeta/Bullet docs](https://docs.zeta.markets/)
