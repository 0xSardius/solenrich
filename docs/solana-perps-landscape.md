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
| **Phoenix Perps** (Ellipsis) | Orderbook (CLOB) | Private beta, gradual rollout, aims −⅔ trading cost. Same team as the $1B+ Phoenix spot CLOB. ([ellipsislabs](https://www.ellipsislabs.xyz/blog-posts/introducing-phoenix-perpetuals)) |
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
| **Phoenix Perps** | **Rise SDK** (`@ellipsis-labs/rise`, TS+Rust) — HTTP route clients + WS at `https://perp-api.phoenix.trade`. On-chain CLOB. | REST via Rise / perp-api. **Blocked on private-beta access.** | ~1 session (post-beta) | #4 (when beta opens) |
| **Bullet** (ex-Zeta) | Appchain/L2 — old Zeta SDK (`@zetamarkets/sdk`) + REST data API are for *old Zeta*. Bullet likely needs its own (not-yet-public) API; data lives off Solana L1. | Bullet-specific API (TBD). Can't read via Solana RPC. | Unknown | #5 (blocked on public Bullet API) |
| **Percolator** | Not live. | — | — | Watch |

## Strategic recommendations (sequencing)

1. **Be Drift's day-one agent intelligence layer.** Relaunch is imminent (before July). First-mover window
   to cover relaunched Drift funding/OI/trader-profiles before anyone else. Best dev surface of any venue
   (SDK + Data API + on-chain accounts). We already keep its program ID in the labeler. **Time-sensitive.**
2. **Add Pacifica.** It's the contested #1 by volume and CLOB-based (diversifies our pool-heavy coverage).
   Clean REST/WS API. Even if its volume is airdrop-inflated, agents are trading there *now*.
3. **Then Flash Trade** (easy REST + RWA/forex perps angle) and **Phoenix** (when beta opens).
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
