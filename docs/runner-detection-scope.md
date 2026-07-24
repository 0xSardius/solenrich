# Runner detection — scope (`runner-scan` + `trenches-scan`), 2026-07-23

Scopes the two endpoints that answer "**how do we detect big Solana runners (the Ansem/Jimothy kind)
as they're occurring?**" Extends `docs/trenches-scope.md` (T4/T5) and the CLAUDE.md "Trenches" thesis.

## The framing that drives the design

"Detect a runner as it occurs" is TWO signals, not one:

1. **WHO is buying** — proven/known-alpha wallets aping the same fresh token. Ansem/Jimothy are *wallets*;
   when a cohort of proven winners buys, that's the earliest reliable signal (they cause the price).
   **Already built:** `smart-money-trenches`.
2. **WHAT the token is doing** — the on-chain signature of a run-in-progress: accelerating buyers, buy
   pressure, volume/price velocity, holder growth. Independent of who's driving. **The gap we're filling.**

Plus a third, proprietary confirmation:

3. **AGENT ATTENTION** — are *agents* querying it at an accelerating rate (our own request stream).
   Already scoped as `attention-momentum` (T4). **Un-clonable.**

**Naming clarification (resolves the earlier ambiguity):** `attention-momentum` = accelerating *agent
queries* (the moat leg, agent-side). The new on-chain velocity detector is a **separate** endpoint —
`runner-scan` — because it measures *market* acceleration, not agent acceleration. Do NOT fold them
together; they are different inputs that both feed `trenches-scan`.

We detect the **on-chain wake, not the tweet.** By the time Ansem posts, the buying is already on-chain —
that's what we read. Lane = **seconds-to-minutes pre-ape**, NOT block-0 sniping (Geyser/streams, a
different game we don't play). "As it occurs" = early in the move, not first block.

---

## Endpoint 1 — `runner-scan` (on-chain velocity/runner detector) — ✅ SHIPPED 2026-07-24 (`4f9a70b`)

**As-built deltas from the scope below (all deliberate, all verified live):**
- **Candidate pool** = union of DexScreener latest-profiles + latest-boosts + top-boosts (~45 unique
  Solana mints). DexScreener has no public "all new pairs" feed, so this is a **pay-to-appear pool**;
  the response says so in `candidate_source` rather than implying full coverage. Batch lookup
  (`tokens/v1/solana/{≤30 comma-separated mints}`) makes a 45-token scan cost 2 requests.
- **Fifth stage `QUIET`** added to the scoped four. Forcing every token into IGNITING/RUNNING/LATE/
  FADING would have been dishonest — most tokens are simply not doing anything.
- **Buy-pressure gate (not in the original scope, added after live testing).** First live run ranked a
  token churning at 43% buys ABOVE one accumulating at 85%, because raw acceleration outweighed
  pressure. Acceleration while sellers dominate is *distribution*, so it now takes a 0.4× penalty and
  cannot reach RUNNING/IGNITING. RUNNING needs ≥2 accelerating windows AND ≥0.55 pressure; IGNITING
  needs ≥1 window AND ≥0.50.
- **`up_big_24h` flag** fires on any ≥150% 24h gain even when buying is still accelerating (so the
  stage is not LATE) — a buyer arriving at +965% is taking a different trade and should be told.
- **Holder growth + liquidity trend need a prior snapshot**, so they are null on first sight of a mint
  and fill in on repeat scans ≥5 min apart (`runner:snap:{mint}`, 2h TTL). Birdeye holder lookups are
  capped at the top 6 candidates by 1h volume (free tier is ~1 rps); no stale carry-forward.
- Live: 45 candidates → 10–11 passing at default filters, ~3.0s cold. Defaults from the scope
  (24h / $10K liq / $5K 1h vol) were validated empirically — they give a healthy funnel, not zero.

**Still open:** paid seed run to catalog it in the CDP bazaar (all-optional inputs, so it should
auto-catalog once a payment settles).

---

## Endpoint 1 — original scope

**What:** scans fresh/trending tokens and flags the ones whose on-chain activity is *accelerating* — the
signature of a runner in progress — while still early enough to matter. Standalone value AND the "WHAT"
input to `trenches-scan`.

**Buyer:** trenches bots wanting "what's running RIGHT NOW that I can still catch"; Eris's call feed.

**Price:** $0.04 (scan + synthesis; between `new-tokens` $0.012 and `trenches-scan` $0.05–0.10).

**Inputs (all optional → auto-catalogs, no BAZAAR_INPUT_EXAMPLES needed):**
- `max_token_age_hours` (default 24 — fresh but past block-0)
- `min_liquidity_usd` (default 10_000 — kill dust)
- `min_volume_h1_usd` (default 5_000)
- `limit` (default 15)
- `format`

**Data sources (all already integrated; one small extension):**
- **DexScreener** — `volume{h24,h6,h1}`, `priceChange{h1,h6,h24}`, `pairCreatedAt` (have `getTokenAgeHours`),
  **plus `txns{m5,h1,h6,h24}.{buys,sells}` — the API returns this but our client doesn't parse it yet
  (~10-line `DexScreenerClient` extension: add `txns` to `DexPair`/`DexTokenData`).**
- **Birdeye** — holder count (holder growth if a prior snapshot exists), OHLCV.
- Helius (optional, v1 SKIP) — tx-level unique-buyer sampling; use DexScreener buy *counts* as the v1 proxy.

**Velocity metrics (the core logic — pure functions):**
1. **Buy-rate acceleration** — short-window rate vs long-window rate: `(buys_m5 × 12) vs buys_h1`,
   `(buys_h1 × 6) vs buys_h6`. Ratio > 1 = accelerating. This is the second-derivative signal.
2. **Buy pressure** — `buys / (buys + sells)` per window; > 0.60 = demand-dominated. Track m5 vs h1 (rising = strengthening).
3. **Volume acceleration** — `volume_h1 vs volume_h6 / 6` (is the current hour above the 6h pace).
4. **Price velocity** — `priceChange_h1 vs priceChange_h6 / 6` (accelerating price).
5. **Holder growth** — Birdeye holder count vs cached prior (real distribution, not one whale). Null if no prior.
6. **Liquidity trend** — LP added = bullish; **LP pulled + sells spiking = rug/dump, NOT a runner (hard guard).**

**Composite `runner_score` (0–1, clamped) + stage classification:**
- `IGNITING` — early acceleration, low mcap, thin history.
- `RUNNING` — sustained acceleration + buy pressure across ≥2 windows.
- `PARABOLIC / LATE` — huge `priceChange_24h` but buys decelerating → **"already ran, entry/distribution
  risk high"** (honesty flag — do not present as a fresh entry).
- `FADING` — decelerating, sells rising.

**Honest guards (non-negotiable — this is loss-avoidance intelligence):**
- Require acceleration across **≥2 windows** (one m5 spike ≠ a runner).
- **Rug/dump guard:** liquidity pulled or sells spiking → flag as risk, never as a runner.
- **Late-detection honesty:** big `priceChange_24h` → `LATE` stage + entry-risk flag.
- **Wash-trading caveat:** txn counts are bottable; cross-check with holder growth where available; note it.

**Output:** ranked `[{mint, symbol, age_hours, mcap, liquidity_usd, stage, runner_score, buy_pressure,
buy_rate_accel, volume_accel, price_velocity, holder_growth|null, flags[], reasoning}]` + summary.

**Reuses:** `dexscreener` (extend for `txns`), `token-analyzer` (mcap/liq/risk), `getTokenAgeHours`,
`birdeye`. **New:** `src/enrichers/runner-detector.ts` (+ pure `runner-score.ts` for unit-testable math).

---

## Endpoint 2 — `trenches-scan` (three-signal orchestrator) — THE HEADLINER, BUILD LAST

**What:** composes the full stack into one ranked, reasoned "ape-able right now" list — the three-signal
confirmation + a safety gate. This is the "sell the decision, not the ingredient" apex and Eris's primary
signal. (This is `docs/trenches-scope.md` T5, now fleshed out.)

**Price:** $0.08 (orchestration, multi-source; between `trending-signals` $0.05 and `smart-money-flow` $0.10).

**Inputs (all optional):** `max_token_age_hours`, `min_liquidity_usd`, `require_smart_money` (bool),
`min_signals` (how many of the 3 must fire; default 2), `limit`, `format`.

**Logic (the composition):**
1. **Candidate union** — dedupe-by-mint the union of: tokens smart-money is buying (`smart-money-trenches`),
   tokens with accelerating velocity (`runner-scan`), fresh tokens with rising agent-attention
   (`attention-momentum`).
2. **Safety filter** — each candidate through `token-analyzer` risk scoring (+ `dev-reputation` /
   `token-x-ray` when they ship); drop CRITICAL/HIGH (rug signals). **99% of trencher losses are rugs —
   this gate is the higher bar than the upside signals.**
3. **Signal-overlap scoring** — per survivor, count how many of the 3 fire and how strongly; rank by
   (signals_fired desc, composite strength).
4. **Verdict + reasoning** — `STRONG` (all 3 + safe) / `EMERGING` (2 of 3) / `WATCH` (1 strong), each with
   a one-line reason naming WHICH signals fired ("3 proven wallets in + buy-velocity accelerating 2.4× +
   agent attention rising 4×").
5. **Stage awareness** — inherit `runner-scan`'s stage so it never calls a token that already ran.

**Output:** ranked `[{mint, symbol, verdict, signals_fired:{smart_money, velocity, attention}, safety,
runner_stage, reasoning}]` + summary + caveats (NFA, latency lane, most still fail — EV is the average).

**Reuses:** `smart-money-trenches`, `runner-detector` (new), `signal-tracker`/`attention-momentum`,
`token-analyzer`, `due-diligence`. **New:** `src/enrichers/trenches-scan.ts` (orchestrator).

**Why defensible:** no single leg is a moat (anyone can watch a wallet or a volume spike). The **overlap**
is — and the attention leg requires owning an agent-data business first, which incumbents don't. This is
the endpoint they structurally can't replicate.

---

## Sequencing

1. **`runner-scan`** — standalone value + it's the `trenches-scan` "WHAT" input. Start here.
2. **`attention-momentum`** (already scoped T4) — thin extension of `signal-tracker` (`rising` +
   `prior_window_queries` already exist); formalize acceleration magnitude into a first-class signal.
3. **`trenches-scan`** — composes all three + safety. Ship after 1 & 2 validate individually.

Each = full CLAUDE.md 9-step new-endpoint checklist. All-optional inputs → auto-catalog in the CDP bazaar.
All three sharpen Eris's calls (and Eris's outcome tracking becomes the label set that tunes the weights).

## Honest caveats (carry into the copy)

- **Latency lane:** seconds-to-minutes pre-ape, not block-0. Say so.
- **Survivorship:** "detect the next Ansem play" is hindsight-flattering; we detect *cohorts + acceleration*,
  which is robust, not "predict the one genius."
- **Wash/bot noise:** on-chain counts are gameable; the safety gate + holder-growth cross-check + multi-window
  requirement are what keep it honest.
- **Most flagged tokens still fail** — memecoin outcomes are binary; the ROI is avoiding rugs + catching the
  occasional 10×, not a high hit rate. NFA always.
