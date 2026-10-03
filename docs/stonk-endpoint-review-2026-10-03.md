# StonkFun endpoint review (2026-10-03)

Question: which new StonkFun endpoints are worth shipping? Inputs: the StonkFun public API docs, our call data
for the last 8 days, buyer wallets, Moneta's results, and one measurement of the launch ledger.

## What buyers use (8 days to 2026-10-03, all callers incl. ours)

| Endpoint | Calls | Outside payers |
|---|---|---|
| `stonk-pairs` (free) | 2,394 | free; IP callers |
| `stonk-yield` | 1,306 | 2otm6W, 2WgRFR, 34CMQ3 |
| `stonk-alerts` | 779 | 34CMQ3 (rest is Moneta) |
| `stonk-gems` | 378 | 34CMQ3, WuJQtT |
| `stonk-screener` | 375 | 2otm6W, 2WgRFR, 34CMQ3, WuJQtT |
| `stonk-quote` | 342 | 34CMQ3, 2WgRFR, WuJQtT |
| `stonk-reward-risk` | 4 | |
| `stonk-yield-batch`, `stonk-launch-intel`, `stonk-launch-preflight` | 1 each | |

- **Demand is for trading and monitoring data, not launching.** The launch endpoints are unused.
- **The paying wallets hold no StonkFun coins.** They look like dashboards and scanners serving others,
  not holders watching their own bags. A wallet-portfolio endpoint has no buyer evidence yet.
- **Existing buyers do not switch endpoints.** `stonk-yield-batch` was built for the main buyer and never adopted.
  New endpoints win new buyers; they rarely change an integrated buyer's calls.

## StonkFun API data we do not use yet

`/launches` (with `creator` filter, 167,648 launches), `/tokens/{mint}/fees` (claimable creator fees),
`/tokens/{mint}/burns`, `/airdrop`, `/backing`, `/revenue`, `/revenue/history` (daily platform and holder revenue),
`/stats`. No trades, holders, candles or websocket endpoints exist.

## Measurement: launches per creator

Latest 3,000 launches (2026-10-02 20:16 → 10-03 19:28 UTC): **1,407 creators; 350 launched more than once and made
65% of the launches**; the top 10 creators made 13%; the top creator made **124 launches in about 23 hours**.

## Candidates, ranked

### 1. `stonk-creator` — creator track record ($0.01–0.02) · RECOMMENDED FIRST
- Input: a creator wallet, or a coin mint (resolved to its creator).
- Output: launches (24 h / 7 d / all), share that ever traded, share paying now, survival past 3 days, total
  holder payouts, median peak market cap, quote shelves used, serial-launcher flag, and a verdict
  (ESTABLISHED / MIXED / SERIAL_LAUNCHER / NEW).
- Why: 65% of launches come from repeat creators, and a creator's history is the cheapest filter a scanner can
  apply before paying for anything else. It is the StonkFun version of the trenches "dev reputation" idea, and it
  compounds: every refresh adds history only we keep.
- Data: `/launches?creator=` plus our index and population rows (liveness, payouts). Needs the creator on index
  rows (check `/tokens` fields) or a creator → mints map from the launch ledger.
- Moneta: add creator features to its verdicts, so the replay can test whether creator history predicts returns.

### 2. `stonk-market-pulse` — is the stonk market rising or falling? ($0.005)
- Output: breadth (share of live coins up in 24 h), median 24 h move, launches per day, share trading and paying,
  daily holder revenue (`/revenue/history`), and the strongest and weakest quote shelves.
- Why: Moneta's data shows the market move dominates every pick (the median coin fell 4.5–24% a day).
  Dashboards can display it, scanners can gate on it, and Moneta's market-filter experiment needs it.
- Data: mostly already in the stonk index and the population job, plus one cached `/revenue/history` call.
  Cheap to build and to serve.

### 3. Fix `stonk-gems` (existing endpoint, two outside buyers)
- Moneta's data: the gem score does not predict price, and the top scores did worst (85+: −9.5% vs market).
- Short term: reword the description to what the score measures (alive, paying, liquid), not "gems".
- Later: rebuild the score from what the replay finds predictive (for example creator history, market regime,
  quote trend). Quality on a sold endpoint ranks above a new endpoint.

### 4. Creator fees across all coins ($0.005) — later
- `/tokens/{mint}/fees` per coin, summed across a creator's coins, with USD values. Serves launch agents
  (StonkFlow, Pair Router). No launch-side demand yet, so wait.

### Not now
- Wallet stonk portfolio: no buyer evidence (paying wallets hold no coins); Stonk Ledger covers humans.
- Launch transaction wrappers: StonkFun offers them free, and the launch endpoints have no traffic.
- Platform revenue analytics: no agent buyer.

## Suggested order
1. Reword `stonk-gems` now (copy only; one restart, or bundle with the next release).
2. Build `stonk-creator` (about 1–2 sessions), starting with a measurement: do coins from serial launchers trade and
   pay less than coins from one-time creators? If not, the endpoint loses its point.
3. Build `stonk-market-pulse` (about 1 session) and feed it to Moneta's market filter.
