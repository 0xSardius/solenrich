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

**Organized across the two regimes the guide defines** (updated 2026-07-02): a shared **spine** + a
**new-pairs** leg (T1–T5, the trenches proper) + a **community/established** leg (T6–T9, "the long game —
the right game," which pump.fun's own poll says 81.5% prefer) + a shared **macro gate** + an
**exit/management** track. Selection was ~90% of the original scope; the guide is emphatic that
management/exits matter *more* than entries, so they're now a first-class part of the map.

### Regime A — new pairs (the trenches proper) + shared spine

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

### Regime B — community / established pairs (the long game, the right game)

The guide's "Community memecoins" section: the winning signal is **maturation, not launch** — "bundlers
flushed out, wallets that were in at 10k rotated out," healthy distribution, a community active *at all
hours not just during pumps*, holders who'd stay through −50%. Slower game, higher control, "you're not
racing bots — you're building." This leg was under-served by the original scope.

**T6. `distribution-health` ($0.03) — "good mileage" quantified.** Distribution *trajectory over time*:
top-holder % trend, HHI trend, holder-count growth, bundler flush-out, holder retention/churn, smart-money
accumulation (not just entry). Reuses `token-analyzer` + `snapshot-store`/`trend-analyzer` (the same
temporal spine as `token-trend`). The on-chain reflection of "is this community healthy" — no social scrape.

**T7. `market-structure` ($0.02–0.03) — the entry-timing read (guide Ch. 7).** HH/HL uptrend detection +
golden-zone (0.5/0.618/0.786 fib) entry read from OHLCV. "Is it in a *confirmed* uptrend, and where's the
entry?" Body-to-body (not wick-to-wick) per the guide's low-liquidity rule. Genuinely new *logic* but reuses
Birdeye candles we already fetch. Serves both regimes; shines on coins with ≥ a few days of price history
(the guide: drawing a line on a 30-min coin is guessing). **Also the exit-invalidation signal** (break of
structure to the downside) — see the exit track.

**T8. `trenches-heat` ($0.01–0.02) — the macro gate (guide Ch. 8 "Reading the Market").** BTC/ETH/SOL trend +
trenches heat (are fresh launches topping at 5–10M or dying at 500K?) + aggregate on-chain volume → a
risk-dial verdict (HIGH-RISK / NEUTRAL / LOW-RISK conditions). Cheap; **powers Eris's self-gating** (fewer,
quieter calls when the trenches are cold). Reuses perps market data + DexScreener aggregate.

**T9. `community-scan` ($0.05–0.10) — the community orchestration headliner.** Survived-the-churn filter
(age/sustained volume) → `distribution-health` → `market-structure` confirmed uptrend → smart-money
*accumulation* overlay → ranked "worth entering/holding" list with per-token reasoning. The `community-scan`
counterpart to `trenches-scan`. Reuses T3/T6/T7. Ship after the parts validate.

### Exit & management track (the half that keeps the money — guide Ch. 9)

The guide: *"trade management is indefinitely more important than your entry."* The selection suite tells you
what to buy; this tells you when to *sell / cut / trim*. Two pieces already exist and just need framing +
one net-new bot layer:

- **`check-alerts` (already built) = the exit-trigger system.** Spot alerts on price spikes, risk-score
  changes, whale flows, holder-concentration shifts. Frame it as Eris's "has my thesis broken" watcher on
  every open call. (Extend spot criteria as needed; the perps event types are already there.)
- **`market-structure` (T7) = the invalidation signal.** Break of structure to the downside = the guide's
  "setup died, exit" trigger. Same endpoint, dual-use (entry + exit).
- **Eris-side management logic (bot, not an endpoint — needs portfolio state):** take-profit laddering
  (scale out gradually on the way up), position sizing (% of portfolio, "if this zeroes can I trade
  tomorrow?"), and the recurring anchor *"would I buy this at the current price? → if no, sell the
  difference."* This is pure guide gospel and lives in the bot because it needs position/P&L context.

*(Deliberately NOT building: social/sentiment scraping — no edge, different game per strategy. Narrative
"word-frequency" plays stay out of scope; we do the on-chain reflection — buy velocity — not the tweets.
The narrative half of the guide's "information deficiency" edge is out of scope by design; smart-money +
attention are our on-chain *money-proxies* for whether a narrative is working, which makes us deliberately
a research-filter for apes, not a block-0 alpha-originator.)*

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

### 5b. How Eris sources calls "early" — the ingestion design (researched 2026-07-02)

Call-sourcing bots are 4 layers; **"early" is won entirely in Layer 1 (ingestion)** — the rest is filter +
deliver + track. There are three ingestion speed tiers and *which tier you're on IS how early you are*:

- **Tier A — Geyser/gRPC (sub-second, sniper tier):** Yellowstone gRPC off a validator (Helius/Triton/
  QuickNode/Shyft) → parse the mint out of the launch tx the instant it lands. **We do NOT play here**
  (block-0 game, needs multiwallet ops, razor-thin edge — the guide's excluded lane).
- **Tier B — Launchpad websocket (1–3s, research-ape tier — OUR lane):** **PumpPortal** (`pumpportal.fun`,
  free WS) — `subscribeNewToken` pushes every new pump.fun launch as JSON; `subscribeTokenTrade` (per-token
  trades); **`subscribeAccountTrade` (watch specific wallets).** Fast enough to research-and-ape, not a race.
- **Tier C — Polled DEX APIs (seconds–minutes, enrichment tier):** DexScreener/Birdeye "new/trending." Too
  slow to be first, but **perfect for Regime B (community/established), where you're not racing** + enrichment.

**Two sourcing strategies (pick both, but the 2nd is our strongest first move):**
1. **Scan-all-launches** — drink the pump.fun firehose (100s/min) → filter hard. Edge = *filter quality*,
   which is exactly where our spine (x-ray/dev-rep/smart-money/attention) beats a plain rugcheck bot.
2. **Watch-smart-wallets** — subscribe to a curated set of proven-winner wallets (`subscribeAccountTrade`
   or **Helius webhooks**) and call whatever *they* ape. Higher signal-to-noise than scanning launches;
   the "early" comes from the wallet being early + mirroring instantly. **This IS `smart-money-trenches`
   as a live stream** — highest-ROI first move.

**Stack:** persistent process (not serverless — WS must stay alive) · PumpPortal WS and/or Helius webhooks
(ingest) · Helius RPC (enrich) · Redis (dedup/cooldowns/last-seen) · small DB (call tracking) · **Bun +
grammY** (Telegram) · Railway (host). Post-on-change, not on a timer.

**"Early" we can credibly claim:** *seconds-to-minutes, better-filtered than anyone* — NOT "first block."
Exactly the lane the guide told us to pick.

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

## 8. Sequencing (updated 2026-07-02 — consumer-led, both regimes + exits)

Discipline: **the spine is the v1 advisory *brain* (~65% of a fully autonomous system — picking is there,
managing is half there via check-alerts + market-structure, executing isn't started). Advisory-first is
how we validate profitability with real P&L before betting autonomy on it.**

1. **Confirm the launch feed** (pump.fun/pumpportal, Tier B) + the watch-smart-wallets ingest strategy.
2. **Build `smart-money-trenches`** (highest ROI, zero new-traffic dependency) — the first endpoint AND
   Eris's first signal (also the live watch-smart-wallets stream).
3. **Stand up Eris** pointed at it → public calls with reasoning + honest hit-rate tracking (the lab; the
   feedback meter turns on).
4. **Safety half (new pairs):** `dev-reputation` + `token-x-ray` — makes Eris's new-pair calls trustworthy
   (99% of losses live here).
5. **Community/established leg:** `distribution-health` + `market-structure` — opens Regime B (the guide's
   "better game"). `market-structure` doubles as the exit-invalidation signal.
6. **Exit/management track:** frame `check-alerts` as the thesis-broken watcher + add Eris-side take-profit
   laddering / position sizing (bot logic, needs portfolio state).
7. **Macro gate:** `trenches-heat` — cheap, makes Eris self-gate to conditions.
8. **Orchestrators:** `trenches-scan` + `community-scan` once the parts validate individually.
9. Productize each proven synthesis into a paid endpoint (checklist-complete). The bot's winning logic IS
   the downstream endpoint.

Attribution: the guide is @spyzer's (x.com/@spyzer) original work — we're using its framework as private
R&D input, not republishing it.
