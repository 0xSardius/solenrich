# Perps Signals Bot — Build Scope

> **Working name:** Riptide (placeholder — Tidal-family water theme; alts: Undertow, Current).
> **What this is:** A sequential, actionable build scope for a Telegram bot that resells SolEnrich's
> perps intelligence as real-time signals. Execute top-to-bottom. Architectural decisions are made —
> implement, don't re-decide.
>
> **Product:** Real-time Solana perps intelligence for traders — cross-venue funding spreads, regime
> shifts, and market-stress alerts — every signal generated from SolEnrich and watermarked back to it.
>
> **This is a SEPARATE project from SolEnrich.** New repo, own deploy. It is a *consumer* of SolEnrich,
> not part of it (different runtime: a cron loop + Telegram process + small state store, vs SolEnrich's
> stateless request/response API). Same reasoning as BaseEnrich: independent failure domain.

---

## WHY THIS, WHY NOW

SolEnrich's bottleneck is demand, not supply (~0.5 external paid calls/day; 29 endpoints). This bot is
the first-stage **demand engine + visibility play + dogfood**:

- **Visibility** — a public channel where every post markets SolEnrich, in the post-Drift Solana perps
  niche where SolEnrich is near-monopoly ("the only API serving perps to agents").
- **Demand** — continuous monitoring generates real query volume; SolEnrich's consensus/temporal moats
  (dead at 0.5 calls/day) finally accumulate data.
- **Momentum** — shippable in a long weekend; showcases the freshest, most-differentiated endpoints.
- **Revenue** — freemium (deferred to v1.5): free channel markets, paid tier sells real-time + personal alerts.

**It's also the brain of a future copy-trade/execution bot.** The roadmap is one bot, three tiers:
`v1 market signals → v1.5 smart-money/copy alerts → v2 optional execution`. Nothing here is throwaway.

---

## V1 CUT LINE

**IN:**
- Public Telegram channel (the visibility engine)
- 3 auto signal types: **funding/basis spreads**, **regime shifts**, **market-health changes**
- Markets: SOL / BTC / ETH
- **Post-on-change** with thresholds + cooldown (NOT on a fixed timer — see below)
- One on-demand command (`/funding SOL`) + optionally `/venue SOL 5000 long`
- "Powered by SolEnrich" + link on every post
- Deployed on Railway, monitoring loop every ~30 min

**OUT (deferred to v1.5+):**
- Paid tier + payment mechanism
- Per-subscriber wallet liquidation alerts (`check-alerts`)
- Smart-money / copy-alert tier
- Twitter/X cross-post
- 8004-solana identity / agent-to-agent selling

---

## SIGNAL → ENDPOINT MAP

All endpoints are `POST https://api.solenrich.com/entrypoints/{key}/invoke` with body `{ "input": { ... } }`.
Call with `format: "json"` — the loop needs structured numeric fields for change-detection, and formats its
own Telegram messages (deterministic templates). Verify exact response field names against `/openapi.json`
or a live response when wiring each one.

| Signal | Endpoint (key) | Input | Fires when |
|---|---|---|---|
| **Funding spread / arb** | `perps-cross-venue-funding` | `{ market, include_reference: true }` | cross-venue APR spread > `FUNDING_SPREAD_PTS` (default 5) |
| **Basis opportunity** | `perps-basis-signal` | `{ asset, min_yield_apr_pct: 5 }` | a viable opportunity appears/crosses threshold |
| **Regime shift** | `perps-market-trend` | `{ lookback: "7d" }` | OI / skew / utilization direction flips vs last cycle |
| **Market stress** | `perps-market-structure` | `{}` (returns SOL/BTC/ETH) | health crosses HEALTHY→TILTED→STRESSED, util near OI cap, or borrow APR spikes |
| **"Where to trade"** (command) | `perps-venue-comparison` | `{ market, size_usd, side }` | user runs `/venue SOL 5000 long` |
| **Liquidation alerts** (v1.5 paid) | `check-alerts` | `{ wallets, since, criteria }` | subscriber's tracked wallet nears liquidation / PnL swing |

Market enum across perps endpoints: `SOL | BTC | ETH | BONK`. v1 monitors SOL/BTC/ETH (BONK optional —
not tradable on Jupiter Perps, so cross-venue is thinner).

---

## THE ONE PRINCIPLE: POST-ON-CHANGE, NOT ON A TIMER

A channel that posts "funding is 12%" every 30 minutes gets muted. Each cycle:

1. Call the endpoints, extract the numeric/categorical state per market.
2. Diff against last-seen state in Redis.
3. Emit a post **only** when something crosses a threshold (spread widened past N pts, regime direction
   flipped, health tier degraded), AND it isn't within the cooldown window for that signal+market.
4. Write the new state back.

Thresholds live in `config.ts` so they're tunable without a redeploy of logic:

```
FUNDING_SPREAD_PTS = 5        // min cross-venue APR spread (points) to post
BASIS_MIN_APR_PCT = 5         // min net-yield-after-borrow to surface
BORROW_SPIKE_PTS = 10         // borrow APR jump to flag stress
COOLDOWN_MIN = { funding: 60, regime: 180, health: 120 }  // per signal type, per market
CADENCE_MIN = 30              // monitoring loop interval
MARKETS = ["SOL", "BTC", "ETH"]
```

---

## ARCHITECTURE & REPO SHAPE

Mirror SolEnrich's enricher/formatter separation.

```
riptide/
├── src/
│   ├── config.ts        # env, MARKETS, thresholds, cadence, SolEnrich base URL + auth mode
│   ├── solenrich.ts     # client → calls perps endpoints, returns typed structs
│   ├── signals/
│   │   ├── funding.ts   # spread/arb + basis detection
│   │   ├── regime.ts    # trend-shift detection (market-trend)
│   │   └── health.ts    # market-structure health transitions
│   ├── state.ts         # Redis: last-seen values, cooldown, (later) subscribers
│   ├── telegram.ts      # grammY bot: channel posting + commands
│   ├── formatter.ts     # signal struct → Telegram message string (deterministic templates)
│   ├── loop.ts          # the monitoring cycle: fetch → diff → emit → persist
│   └── index.ts         # boot: start grammY bot + scheduler (setInterval CADENCE_MIN)
├── Dockerfile           # copy SolEnrich's (oven/bun base)
├── package.json
├── tsconfig.json        # copy SolEnrich's
└── .env.example
```

**Data flow:** `loop.ts` (every CADENCE_MIN) → `solenrich.ts` (fetch all markets) → `signals/*` (compute +
diff vs `state.ts`) → `formatter.ts` (render) → `telegram.ts` (post to channel) → `state.ts` (persist).

---

## TECH STACK

- **Bun + TypeScript** (matches SolEnrich; reuse `tsconfig.json` + `Dockerfile`)
- **grammY** — Telegram bot framework (TS-native, Bun-friendly). `bun add grammy`
- **Upstash Redis** — state store. `bun add @upstash/redis` (reuse SolEnrich's `Cache` pattern)
- **SolEnrich client** — plain `fetch` (internal-free mode) or `@x402/fetch` (paid mode); see below
- **Railway** — deploy via Dockerfile, long-running process (holds the scheduler + bot)

---

## SOLENRICH INTEGRATION — CALL MODE

SolEnrich's `/entrypoints/*` are x402-paywalled. Two ways for the bot to call them:

**(A) Pay x402 (simplest to start, costs the circular fee).** Bot holds a funded Solana USDC wallet,
uses `@x402/fetch` to auto-pay. ~$100–150/mo monitoring 3 markets every 30 min — but it's *you paying
yourself*, minus facilitator fees. Real, but silly at volume.

**(B) First-party internal bypass (recommended).** Add a ~10-line check to SolEnrich's x402 middleware:
if `X-Internal-Key` header matches an env secret, skip the payment middleware. The bot (and the rest of
the Parallax agent swarm) then calls SolEnrich free; external callers still pay. Small SolEnrich-side task,
saves the cost, and is the right primitive for dogfooding the whole swarm.

> **DECIDED:** Internal-free (B) for the monitoring loop. Optionally route a *small sample* of calls
> through real x402 (A) purely for the "paid x402 traffic is flowing" proof. **Moat data builds either
> way** — SolEnrich's snapshot accumulation + endpoint call-count metrics run on every 200 response
> regardless of payment. (Perps endpoints pass `market` not `mint/address`, so they won't pollute the
> token/wallet consensus signal — clean.)

**SolEnrich-side task for (B):** in `src/lib/agent.ts`, in the `/entrypoints/*` middleware, short-circuit
to `next()` when `c.req.header('x-internal-key') === process.env.INTERNAL_API_KEY`. Add `INTERNAL_API_KEY`
to Railway env. (This is the only change required to SolEnrich itself.)

---

## STATE MODEL (Redis, prefix `riptide:`)

```
riptide:state:funding:{MARKET}      → JSON { best_long_apr, best_short_apr, max_spread_pts, ts }
riptide:state:regime:{MARKET}       → JSON { oi_dir, skew_dir, util_dir, ts }
riptide:state:health:{MARKET}       → "HEALTHY" | "TILTED" | "STRESSED" + ts
riptide:cooldown:{signal}:{MARKET}  → set with EX = COOLDOWN_MIN*60 (presence = in cooldown)
# v1.5:
riptide:subs                        → set of chat IDs (paid subscribers)
riptide:watch:{chatId}              → set of wallet addresses to monitor
```

Wrap all Redis ops in try/catch — a state failure must skip that signal, never crash the loop (same
discipline as SolEnrich's cache).

---

## TELEGRAM SETUP

1. Create the bot via @BotFather → `TELEGRAM_BOT_TOKEN`.
2. Create a **public channel**, add the bot as admin → `TELEGRAM_CHANNEL_ID`.
3. grammY: bot posts auto-signals to the channel; handles commands in DMs/groups.

**Commands (v1):**
- `/start` — what this is + link to SolEnrich
- `/funding <SOL|BTC|ETH>` — on-demand cross-venue funding snapshot
- `/venue <market> <size_usd> <long|short>` — "where to trade at size" (venue-comparison)
- `/status` — loop health (last cycle time, markets watched)

**Message style:** short, scannable, deterministic templates (your SolEnrich formatter muscle). Always
end with attribution. Examples:

```
🔀 FUNDING SPREAD — SOL
Jupiter Perps 18.2% vs Hyperliquid 9.1% → 9.1pt spread (long HL / short Jupiter)
Best long: Hyperliquid 9.1% APR · Best short: Jupiter 18.2% APR
via SolEnrich · api.solenrich.com

📈 REGIME SHIFT — BTC
Heating up: OI +22% (7d), skew flipping long, utilization rising.
Borrow APR 11.4% · health TILTED
via SolEnrich

⚠️ MARKET STRESS — SOL
Health HEALTHY → STRESSED. Utilization 94% (near OI cap), borrow APR spiked to 35%.
via SolEnrich
```

---

## COST MODEL

- **SolEnrich calls:** ~$0 in internal-free mode (recommended). ~$100–150/mo if fully x402-paid (circular).
- **Railway:** ~$5–10/mo (one always-on small service).
- **Upstash Redis:** free tier is plenty (handful of keys, low ops).
- **Telegram:** free.

Net v1 infra: **~$10/mo.**

---

## MONETIZATION (v1.5 — deferred, here's the menu)

- **Free channel** = marketing. Headline signals, slightly delayed.
- **Paid tier** = real-time (no delay) + personal liquidation/PnL alerts on *your* wallets (`check-alerts`)
  + custom thresholds + `/venue` on demand.
- **Payment mechanism (decide later):** Telegram Stars (simplest), Stripe link, or USDC/x402 (most
  on-brand for the agent-native story). Don't build this for v1.

---

## BUILD SEQUENCE (~a long weekend)

1. **Day 1 — skeleton + one signal end-to-end.** grammY bot + public channel live, `/start`. `solenrich.ts`
   calling `perps-cross-venue-funding`, parsing the funding spread. Post a real funding signal manually.
2. **Day 2 — the loop.** funding + health signal engines, Redis state-diffing, post-on-change + cooldown,
   wire the 30-min scheduler in `index.ts`. Internal-free auth (add the SolEnrich `X-Internal-Key` bypass).
3. **Day 3 — round out + ship.** regime/trend signals, `/funding` + `/venue` commands, message-format
   polish, Dockerfile, deploy to Railway. Watch it post for a day, tune thresholds.

---

## DECISIONS

**Confirmed:**
- Telegram-only for v1 (perps traders live in TG; fastest path). Twitter cross-post deferred to v1.5.
- Internal-free SolEnrich calls for the loop (+ optional token x402 sample for the paid-traffic proof).
- Post-on-change with thresholds + cooldown (not fixed-interval posting).
- Markets: SOL / BTC / ETH (BONK optional).

**Open (resolve during build, not blocking):**
- Final name (Riptide / Undertow / Current / other).
- Exact threshold values — start with the defaults above, tune from real channel output.
- Whether to add the `X-Internal-Key` bypass to SolEnrich now (recommended) or pay x402 to start.

---

## ROADMAP BEYOND V1

- **v1.5 — smart-money / copy-alert tier.** Add `smart-money-flow` + `copy-trade-signals` + `whale-watch`
  + per-wallet `check-alerts`. This is the copy-trade *brain* sold as premium signals — still advisory,
  still zero capital risk. Introduces the paid tier + subscriber state.
- **v2 — optional execution layer.** Copy-execution (mirror smart-money trades) preferred over grid
  (SolEnrich is the alpha source, not a peripheral safety layer). Real capital, real risk — gate on the
  signal quality being proven by paying v1.5 subscribers. Start tiny, paper-trade first.
- **Identity (when selling to agents).** Register on 8004-solana so other agents can discover + pay the
  bot — the "agent buys intelligence from SolEnrich, resells to other agents" story. Not before first
  human subscribers.
```
