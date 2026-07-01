# The Trenches — memecoin intelligence vertical + Eris bot (scope, 2026-07-01)

Bot-first build: **Eris** (a public "calls" Telegram bot) is the R&D lab *and* the marketing/proof
engine. It's given maximum tools to make good calls; the **paid endpoints are extracted downstream**
from whatever synthesis proves it wins. Grounded in Spyzer's "A Complete (Meme)coin Guide"
(`docs/A complete (meme)coin guide.pdf`) — see "What the guide gave us" below.

Related: builds on the CLAUDE.md "The Trenches" open idea (2026-06-22) and the vibe-trading thesis
(SolEnrich = the on-chain-truth layer; `consensus-signal`/attention = the moat). Adjacent vertical —
does NOT block perps. Finish Flash on-chain (perps venue coverage) first, then open the trenches.

---

## 1. The thesis (why this wins), straight from the guide

- **"Attention drives value. The earlier you spot where attention will flow, the more money you make."**
  This is verbatim our `consensus-signal` / attention-momentum moat, applied to fresh tokens.
- **"The best traders don't find coins faster — they process more variables better."** The guide is a
  *checklist* of variables (bundling %, dev wallet, holder count, MC/VOL, liquidity, chart structure,
  narrative). **Our product = process that checklist in one API call, at scale, faster than a human.**
- **"My best trades come from information deficiency."** Edge = knowing something before it's public.
  Our synthesis surfaces on-chain facts (smart-money entries, bundle clusters, dev history) *seconds
  faster and more completely* than a trencher clicking through DexScreener/Bubblemaps/Solscan by hand.
- **"99% of traders on-chain lose to bundles."** → Rug/insider avoidance is not a side feature; it is
  half the value. Memecoin outcomes are binary (rug −100% / runner +10x), so avoiding one rug or
  catching one runner pays for thousands of calls. **ROI story is stronger than perps.**
- **Our lane (do NOT cross):** *seconds-to-minutes pre-ape research*, not block-0 sniping. The guide
  confirms sniping is a separate game ("5 seconds after the news event they've multiwallet-bought 10%
  at 4K") that needs Geyser/streams and multiwallet ops — crowded, low-edge for us. We are the
  research layer a trencher (or their bot) calls *before* they ape, not the sniper.

---

## 2. What the guide gave us — expert thresholds to bake into scoring

These are Spyzer's concrete, battle-tested heuristics. Encoding them = instant credibility + a real
synthesis moat (we're not inventing rules, we're implementing a proven trencher's checklist).

**Rug / bundle / honeypot detection (the safety half):**
- Top holder should hold **≤ 3.5%** of supply. Higher = one wallet's dump can nuke the chart.
- **VOL should be > MC**; volume **< 80% of MC** on a young coin ≈ bundle (supply not really exchanged).
- **> 3–5 holders funded from the same source at the same time** = bundle signal (funding origin).
- **Fresh wallets** (brand-new, no history) among top holders = red flag, especially multiple.
- Majority of holders flagged as **bundlers** = avoid.
- **Botted charts**: near-identical consistent candles, "staircase," or only-huge-candles (one entity).
- **LP locked** (creator burned LP keys, want high %), **mint authority disabled**, **freeze authority
  disabled** (freeze enabled = honeypot, can't sell).
- Creator balance: has the dev **sold** or is he holding?
- **Honeypot triad**: up-only chart + low volume + few holders.
- **Bundle clusters** (Bubblemaps-style): wallets linked by shared funding CEX, creation time,
  inter-wallet transfers → one entity behind many wallets. This is exactly our **wallet-graph**.
- **Fees sanity**: a ~15k MC coin should have **> 0.5 SOL** in fees paid (real trading, not a shell).

**Attention / momentum (the upside half):**
- Buy velocity, **unique-buyer growth rate**, holder growth (real distribution, not one whale).
- **Smart money** = wallets with a proven win record (our `copy-trade-analyzer`) entering *fresh* tokens.
- **Canonical-coin / vamping check**: is this the *leader* for its narrative, or will it get vamped by a
  competing coin? (canonical identity + distribution moat + product gravity = less vampable).
- The decision anchor: **"Would I buy this coin if I found it only now?"** → our synthesis verdict.

**Market context (macro gate):** BTC/ETH/SOL trend + trenches heat (how high are launches topping,
volume). In cold conditions, be quiet. Eris should *self-gate call frequency to market conditions*.

---

## 3. Naming — **Eris** (DECIDED 2026-07-01)

**Eris** — Greek goddess of discord/chaos — chosen for the trenches bot (the "trickster/chaos deity" slot
reserved in CLAUDE.md). Thematically ideal: discord/chaos = the chaos of the trenches.

Availability-checked 2026-07-01: only **2 tiny/dead ERIS tokens on Solana** (~$2k mcap each) — vs the 24
live LOKI tokens that ruled out the earlier "Loki" candidate. Effectively clean for a bot handle — use a
distinct handle (e.g. `@ErisTrenches` / `@ErisScanBot`).

**Launch feed CONFIRMED: pump.fun / pumpportal** (real-time new-launch + trade websocket).

---

## 4. The endpoints (extracted downstream from the bot)

Ranked by buyer-ROI × defensibility. Each maps to guide variables + reuses existing machinery. Prices
indicative. All follow the CLAUDE.md new-endpoint checklist (incl. `BAZAAR_INPUT_EXAMPLES`).

**T1. `dev-reputation` ($0.02–0.03) — the compounding data moat.** "Has this deployer rugged before?"
Tracks a deployer wallet's launch history: # launches, rug rate, median outcome, biggest win, time-to-dump
pattern. **Improves with every launch we observe** — incumbents can't replicate without the history
(same moat shape as `consensus-signal`). Reuses Helius tx/asset history + our labeler. Pure
loss-avoidance ROI. *Data moat #1.*

**T2. `token-x-ray` ($0.03–0.05) — the rug/insider verdict.** One call → SAFE/CAUTION/RIGGED with reasons.
Bundles the guide's safety checklist: LP-locked %, mint/freeze authority, top-holder % (>3.5 flag),
bundle-cluster detection (wallet-graph: shared funding/creation/transfers), fresh-wallet count, VOL/MC
ratio (<80% flag), fee sanity, botted-chart pattern, honeypot triad. Defensible **synthesis** (not a
standalone rug-check — those are commoditized by rugcheck.xyz/gmgn; value is the *bundled verdict*).
Reuses `token-analyzer` + `wallet-graph` + `scoreTokenRisk`.

**T3. `smart-money-trenches` ($0.05) — highest first-build ROI.** "Which *proven-winner* wallets are aping
fresh (<6h) tokens right now, and what are they buying?" The single cleanest attention signal a trencher
pays for — follow the wallets that already made money. Reuses `copy-trade-analyzer` (winner ID is
proprietary analysis) + a fresh-launch feed + `whale-watch`. **Zero new-traffic dependency; build first.**

**T4. `attention-momentum` ($0.02) — the moat, rails now.** Accelerating *agent* queries per fresh token,
from our own request stream (extends `consensus-signal`/`signal-tracker`). Un-clonable ("momentum before
price, but proprietary"). Traffic-gated → quiet today, compounds as Eris + the swarm generate queries.
Build the rails now; every Eris lookup feeds it. *Data moat #2.*

**T5. `trenches-scan` ($0.05–0.10) — the orchestration headliner.** Fresh launches → filter rugs
(`token-x-ray`) → dev-rep gate → smart-money + attention overlay → ranked "ape-able now" list *with
reasoning per token* + the "would I buy this now" verdict. The trenches `trending-signals`. Reuses all of
T1–T4 + `new-tokens`. Ship after T1–T4 validate individually.

*(Deliberately NOT building: social/sentiment scraping — no edge, different game per strategy. Narrative
"word-frequency" plays stay out of scope; we do the on-chain reflection — buy velocity — not the tweets.)*

---

## 5. Eris — the bot-as-lab (the actual first build)

**What it is:** a Telegram bot that (a) responds to a pasted CA/ticker with a fast SolEnrich-powered
verdict (Rick-bot style), and (b) posts *public calls* to a channel with reasoning + a transparently
tracked hit rate. It's the R&D vehicle (discover what synthesis wins) AND the marketing/proof engine
(a verifiable track record is what sells the whole platform).

**The guide validates this exact format:** the "Rick bot" it teaches *is* a Telegram bot that returns
name/chain/price/mcap/liq/vol/top-holders on a pasted CA, **and tracks who called a coin first + shows
the multiple** ("you called it at 100k a day ago = 10x call"). Our differentiator over Rick: Eris adds
the *synthesis verdict* (rug/bundle/smart-money/attention), not just raw stats.

**Design principles (the "maximum tools" the user asked for, bounded by the thesis):**
1. **The moat is the synthesis, not the tools.** Give Eris every data source to *discover what wins*; the
   defensible, productizable output is the synthesis (T1–T5), not raw access.
2. **Dogfood SolEnrich where it can** — route through existing endpoints (copy-trade winner ID,
   wallet-graph, whale-watch, consensus) so every call feeds the moat; use raw sources only for the
   experimental/new stuff not yet an endpoint.
3. **Transparent track record from post #1** (the guide is emphatic: scam call channels retroactively
   post only winners; credibility is everything). Timestamp every call at its mcap, post the *reasoning*,
   publicly track win rate — no cherry-picking. This is also the anti-pattern the guide warns about, so
   Eris being honest *is* the differentiation.
4. **Self-gate to market conditions** (guide's "reading the market"): fewer/quieter calls when the
   trenches are cold; NFA framing always.
5. **Latency honesty**: Eris does *pre-ape research* (seconds-to-minutes), explicitly not block-0 sniping.

**Intelligence layer (what Eris computes per candidate):**
- Rug/insider gate (→ becomes `token-x-ray`): the guide's safety checklist.
- Dev reputation (→ `dev-reputation`): deployer history.
- Smart-money overlay (→ `smart-money-trenches`): winner wallets in the token.
- Attention (→ `attention-momentum` + on-chain buy velocity).
- Verdict: ACT / WATCH / AVOID + one-sentence narrative + "would I buy this now."

**Call + tracking mechanism (Rick-bot-inspired, extended):**
- On a call: record `{ca, ticker, mcap_at_call, ts, reasoning, verdict}`.
- Follow-up: sample price at +1h/+6h/+24h → compute realized multiple; maintain a public, non-cherry-picked
  hit-rate table. Reuses our temporal-snapshot machinery.
- Outcome data becomes a *proprietary label set* (which of our signals actually predict runners) — future
  training signal + the honest track record.

**It's a separate consumer agent (swarm pattern), NOT in `src/`.** Its own repo, like Ananke.

---

## 6. Data sources

Already held: **Helius** (tx/asset history, mints, swaps, deployer history — powers dev-rep + x-ray +
wallet-graph), **DexScreener** (new pairs, trending, MC/VOL/liq), **Birdeye** (holders, OHLCV),
**Jupiter** (price/slippage), our own **wallet-graph / copy-trade-analyzer / consensus / temporal**.

New / to add: **pump.fun / pumpportal** (the dominant launchpad — real-time new-launch + trade websocket;
this is the "new stream" the user was after — `solana.com/data` was the wrong tool: day-lagged network
metrics, not per-token real-time). Optionally **Bitquery** (real-time DEX/token-creation streams) and
**Bubblemaps API** (bundle clusters — though wallet-graph gives us this natively).

---

## 7. Honest caveats (from the guide — build the right thing)

- **Rug-avoidance is 99% of the losses** — get `token-x-ray` + `dev-reputation` genuinely right, or the
  calls hurt people. This is the higher bar than the upside signals.
- **Raw rug-check is commoditized** (rugcheck.xyz/gmgn/bubblemaps) — only valuable *folded into the
  synthesis/verdict*, never standalone.
- **Transparency is the whole value** — a public calls bot lives or dies on a verifiable, honest track
  record. One caught overclaim kills it.
- **The game is hard and getting harder** ("exponential decay," PvP arena, widening skill gap) — Eris's
  edge is *processing more variables faster*, not being first; frame conservatively, NFA always.
- **Latency boundary** — we are pre-ape research, not sniping. Don't chase sub-second.

---

## 8. Sequencing

1. **Confirm the launch feed** (pump.fun/pumpportal) + Eris naming (Eris vs Eris).
2. **Build `smart-money-trenches`** (highest ROI, zero new-traffic dependency) as the first endpoint AND
   Eris's first signal.
3. **Stand up Eris** pointed at it → public calls with reasoning + honest hit-rate tracking (the lab).
4. Add `dev-reputation` + `token-x-ray` (the safety moat) as Eris proves what matters.
5. `trenches-scan` orchestration once T1–T4 validate.
6. Productize each proven synthesis into a paid endpoint (checklist-complete). The bot's winning logic IS
   the downstream endpoint.

Attribution: the guide is @spyzer's (x.com/@spyzer) original work — we're using its framework as private
R&D input, not republishing it.
