# SolEnrich Endpoint Additions — Vibe-Trading Workshop (2026-06-16)

> Output of the endpoint-additions workshop. Five candidate endpoints scoped against three lenses
> (serves a vibe-trading agent / defensible synthesis incumbents can't copy / reuses existing
> machinery), then ranked by **buyer ROI**.
>
> **DECISION: build `hyperliquid-smart-money` first** — highest provable buyer ROI, and it powers
> Ananke's v1.5 copy-alert tier. Sequence: validation pull → `hyperliquid-trader-profile` (3a) →
> `hyperliquid-smart-money` (3b).

---

## The frame: a flywheel, not a grab-bag

These aren't independent endpoints — each makes the others better:
- **`vibe-check`** = the verdict the agent asks for.
- **`attention-momentum`** = the proprietary signal that feeds the verdict.
- **`hyperliquid-smart-money`** = premium cross-venue intelligence.
- **Ananke** (the consumer agent) both *calls* these AND *generates the query traffic* that sharpens
  `attention-momentum`. Demand and the moat's data source are the same loop.

## Lenses every candidate passed

1. **Serves a vibe-trading agent** — discovery → verdict → edge → execution-intel → monitoring → attention.
2. **Defensible synthesis** — composes multiple sources; incumbents (Helius/Nansen/Birdeye) structurally
   can't copy without cannibalizing their dashboard/subscription businesses.
3. **Reuses existing enrichers/sources** — cheap to build.

---

## The five candidates

### 1. `vibe-check` — one-call ACT / WAIT / AVOID verdict
- **What:** token (or market) + optional size + optional thesis → single confidence-scored verdict with
  the contributing signals AND the disagreements between them.
- **Vibe job:** "the timeline says ape BONK — what's the call?" One call, one grounded answer.
- **Un-copyable:** folds in `consensus-signal` (agent attention — incumbents have no agent request stream);
  sells a *decision*, not ingredients.
- **Reuse (high):** ~60% there — `query`'s `buy-decision` compound intent already fuses due-diligence +
  token-trend + whale-watch via `composeCompoundBriefing`. Add the consensus leg + `slippage_estimates` +
  a confidence-scoring function. Same shape as `trending-signals`.
- **Cost ~1 session. Price $0.03–0.05.**

### 2. `attention-momentum` — agent-attention acceleration (the moat)
- **What:** tokens/markets ranked by *acceleration* of agent attention (rate-of-change, not absolute),
  cross-referenced with price. Killer field: attention rising + price flat = early signal; attention
  cooling + price pumping = distribution risk. Fold "divergence setups" in here as a mode, not a separate
  endpoint.
- **Vibe job:** Chris-Camillo social arbitrage, but the "social" leg is agent attention measured inside
  SolEnrich — "what's catching fire among agents before price reacts?"
- **Un-copyable:** the single most defensible thing in the catalog — the data is the request stream itself.
- **Reuse (high):** `signal-tracker` already computes rank/percentile/rising-vs-cooling from the hourly
  counters (`metrics:{type}s:{addr}:hour:{hour}`) that *now actually populate* post the Phase 13 fix. Add
  acceleration ranking + price overlay.
- **Honest caveat:** signal quality scales with traffic (~0.58 paid calls/day today). Build-the-rails-now,
  compounds-with-the-swarm. Ananke's monitoring loop is what thickens it.
- **Cost ~1 session. Price $0.02** (or $0.05 given uniqueness). Sell on uniqueness now, ROI later.

### 3. Hyperliquid depth (mini-suite)
**The unlock:** HL is the most transparent high-volume perps venue in existence — every user's full
position book is public by address. No CEX offers this. "Nansen-for-Hyperliquid, agent-native." All three
layers extend the *same* `perp-reference.ts` `POST /info` pattern already in place (public, no auth, no
geo-block). HL traders are EVM `0x` addresses → SolEnrich's first first-class off-Solana venue (spot/wallet
data stays Solana; perps intelligence is venue-agnostic).

- **3a. `hyperliquid-trader-profile`** (the cheap enabler) — positions, leverage, liquidation price, uPnL,
  account value, classification for an HL `0x` address. Reuse `perps-analyzer` classification + flags
  (`high_leverage`, `approaching_liquidation`) + perps formatter. New: `clearinghouseState` + `userFills`
  methods on `PerpReferenceClient`. ~1 session. **$0.012.**
- **3b. `hyperliquid-smart-money`** ← **FIRST BUILD** — track a watchlist of top HL traders (leaderboard +
  known whales), aggregate net positioning per coin, surface flips / new positions / accumulation and *what
  just changed*. Reuse 3a across a watchlist + `copy-trade-analyzer` scoring + `check-alerts` diff logic.
  ~1–2 sessions. **$0.05–0.10.**
- **3c. `hyperliquid-market-positioning`** — aggregate OI/funding/long-short skew + (later) liquidation
  clusters per coin. The deferred `perps-liquidation-risk-map` (#6), easier on HL because positions are
  public. ~1 session for the cheap version. **$0.02.**
- **Bonus reuse loop:** HL `l2Book` gives real depth at size → upgrades `perps-venue-comparison`'s HL leg
  from funding-only to slippage-aware. Free once 3a's client methods exist.

### (on the board, later) RWA tokenized-equity basis + labeling
- Reuse `perps-basis-signal` machinery: tokenized-equity (xStocks/Backed SPL mints) vs real-equity spot =
  a basis signal. Plus RWA-aware wallet labeling/risk. Buildable WITHOUT tokens.xyz. Same-narrative, cheap.
  Deferred behind the HL track.

---

## Buyer-ROI ranking (why HL smart-money won)

1. **`hyperliquid-smart-money`** — provable copy-edge. HL is the only high-volume venue where you can verify
   BOTH a trader's actual PnL history (`userFills`) AND their live positions (`clearinghouseState`) on-chain.
   Copy-trading is the most measurable money-making strategy; HL lets you prove the trader is good before
   copying. Marketable receipts ("agents mirroring this would've returned X%"). **Also the brain of Ananke's
   v1.5 paid copy-alert tier** — highest-ROI endpoint == revenue-tier engine.
   - *Caveats:* copy-edge decays with crowding (advantage = agent-native low-latency delivery + synthesis,
     not raw position-peeking); you see the HL book but not CEX/spot hedges → surface confidence, don't
     oversell any single position.
2. **`vibe-check`** — ROI via the loss you DON'T take (AVOID verdict on rugs) + screening volume (call it on
   everything pre-ape; pays for itself the first time it stops a bad entry). Reliable, less demonstrable
   (counterfactual).
3. **`hyperliquid-trader-profile`** — medium alone, high as the enabler of #1.
4. **`hyperliquid-market-positioning`** — real edge (squeeze/cascade anticipation) but narrower buyer.
5. **`attention-momentum`** — highest ceiling, lowest current floor (predictive + traffic-gated). Moat asset
   now, ROI asset later.

**Framing:** at $0.01–0.10/call against a $500–5,000 position, cost is rounding error — the real question
is signal *reliability and provability*, which is what the ranking is on.

---

## DECISION (2026-06-16): `hyperliquid-smart-money` is the first new build

Build sequence:

- **Step 0 — validation pull (de-risk first).** Pull HL public `userFills` for ~20 top traders; backtest
  "would copying their position changes over the last 30d have been profitable after realistic latency?"
  Validates the edge exists, sets scoring thresholds, and produces the exact ROI receipts to market the
  endpoint with. If flat → we learn before building.
- **Step 1 — `hyperliquid-trader-profile` (3a).** The enabler. Add `clearinghouseState` + `userFills` to
  `PerpReferenceClient` (same `POST /info` pattern). Compose with `perps-analyzer` + perps formatter.
- **Step 2 — `hyperliquid-smart-money` (3b).** Watchlist + scoring + what-changed diff on top of 3a.

Then, in ROI order: `vibe-check` → `attention-momentum` (rails) → RWA basis.

## Reuse map (what each composes)

| New | Reuses |
|---|---|
| HL client methods | `perp-reference.ts` `fetchWithTimeout` + `POST /info` pattern (already public/no-auth/cached) |
| `hyperliquid-trader-profile` | `perps-analyzer` classification + risk flags; `llm-perps` formatter pattern |
| `hyperliquid-smart-money` | 3a + `copy-trade-analyzer` scoring + `check-alerts` diff logic |
| `vibe-check` | `query` buy-decision intent + `consensus-signal` + `slippage_estimates` |
| `attention-momentum` | `signal-tracker` + hourly counters + price overlay |
| RWA basis | `perps-basis-signal` machinery |

---

## Step 0 validation — DONE (2026-06-16): endpoint CONFIRMED, framing reframed

Ran `test/hl-copy-edge-validation.ts` (two cuts) against the live HL public API.

**Cut 1 (naive — rank leaderboard by absolute month PnL): INCONCLUSIVE.** Top accounts are market-makers / mega-funds (e.g. $9.5B weekly volume on a $57M account = 166x turnover); fills cap at 2000 so realized PnL undercounts; leaderboard "pnl" conflates deposits/withdrawals with trading. Only 48% of the top-25 had positive realized PnL. **Lesson: don't rank by absolute PnL; filter out MMs.**

**Cut 2 (MM-filtered, consistency-tested) — the working pipeline.** Funnel: 39,401 leaderboard rows → 12,050 in the copyable band ($100k–$20M) → 10,949 after turnover filter (monthVlm/acct ≤ 40x excludes MM/HFT) → 8,498 with positive month ROI → of the top 60 by ROI, **39 (65%) passed consistency (week+month trading PnL > 0) + directional (≤15 positions).** *This funnel is the endpoint's core filtering logic.*

**Findings that reshape the spec:**
1. **Lead with POSITIONING / CONSENSUS, not "copy this genius."** The cleanest, most defensible, most marketable output is the aggregate. On 2026-06-16 the 39 copyable traders were **21:0 LONG HYPE (net +$80.8M)**, net SHORT ETH, net long WLD/JTO/LIT. Crisp, legible, hard-to-fake = the "where is HL smart money leaning?" signal a vibe trader wants.
2. **Individual copy-trade is viable but needs guardrails.** ROI blows up at small denominators (one entry showed "25,855% month ROI" on $223 PnL — a few-dollar account that mooned) → rank individuals by a robust metric (absolute PnL within band / risk-adjusted), not raw ROI. And ROI-ranking + week>0 selects hot-streak/correlated traders (mostly the one HYPE trade) → present individuals with honest confidence (size, turnover, consistency); don't claim durable alpha.
3. **MM-turnover filter + account band + consistency gate = the productized pipeline.** Validated and reusable as the enricher core.

**Not yet validated (deferred, non-blocking):** durable per-trader alpha (needs multi-month out-of-sample); latency-adjusted copy returns (needs historical entry prices — matters less now we lead with positioning, not tight copy-execution).

**Live receipt (marketable):** "SolEnrich's HL smart-money filter — 39 consistently-profitable traders are 21:0 long HYPE (net +$80M) and net short ETH (2026-06-16)." Do NOT market the 248% median month ROI (inflated by the HYPE run + hot-streak selection).

**Reframed `hyperliquid-smart-money` spec:**
- **Primary output:** aggregate positioning/consensus per coin (long/short trader counts, net notional, bias) across the MM-filtered, consistency-gated set.
- **Secondary:** per-trader drill-down (positions, robust-ranked, honest confidence labels).
- **Build unchanged:** 3a `hyperliquid-trader-profile` (adds `clearinghouseState` + `portfolio` to `PerpReferenceClient`) → 3b `hyperliquid-smart-money` (the funnel + positioning aggregation + `check-alerts`-style "what changed" diff). The validation script's funnel ports directly into the enricher.
