# `wallet-link-check` — scope (2026-09-30)

Requested by Elijah (Lumière PayCheck, x402 trust layer). His monitor sees a seller's payout wallet change
from A to B and must decide: normal rotation or hijack. He would call this on every change event, paid per
call over x402. The question is general ("are these two wallets the same owner?"), so the endpoint also serves
sybil checks, copy-trade vetting and know-your-agent.

## Contract

**Input**

| Field | Type | Notes |
|---|---|---|
| `wallet_a` | Solana address | Old wallet. If it is a token account (ATA), resolve its owner first. |
| `wallet_b` | Solana address | New wallet. Same ATA rule. |
| `context` | `payout_rotation` \| `general` | Default `general`. `payout_rotation` turns on the x402 checks. |
| `format` | json \| llm \| both | Standard. |

**Output**

| Field | Meaning |
|---|---|
| `verdict` | `LIKELY_SAME_OWNER` / `UNCERTAIN` / `SUSPICIOUS` (shown as `LIKELY_ROTATION` in `payout_rotation` context) |
| `same_owner_confidence` | 0–1 |
| `direct_link` | Transfers between A and B: count each way, SOL and token amounts, first and last time |
| `funding` | First funder of A and of B; `b_funded_by_a`; `shared_funder` (ignoring exchanges and known protocols) |
| `wallet_b` | First seen, transaction count, active days, labels, entity (if an exchange or protocol) |
| `x402` | B's past x402 inflows (count, distinct payers); whether B is already the payout wallet for other Bazaar resources |
| `risk_flags` | `new_wallet`, `thin_history`, `fast_sweep`, `b_is_exchange_deposit`, `no_link_found` |
| `evidence[]` | One plain sentence per finding, in score order |
| `coverage` | What was read: pages of history for A and B, and whether each history was complete |

## Scoring (rules, pure function)

Strong for same owner:
- A sent SOL or tokens to B, or B to A.
- B's first funder is A.

Medium:
- A and B share a first funder that is not an exchange or a known protocol.
- B has received x402 payments before from several payers.

Against:
- B is under 7 days old with no link to A.
- B sweeps funds out within minutes of receiving them.
- B is already the payout wallet for unrelated Bazaar sellers.

Rules:
- **Thin evidence gives `UNCERTAIN`, never `LIKELY_SAME_OWNER`.** A false "safe" on a hijack is the worst outcome for the buyer.
- An exchange deposit address as B gives `UNCERTAIN` plus `b_is_exchange_deposit`. Ownership cannot be proven from the chain.
- Weights are constants, tuned from fixtures and from any labeled cases Lumière shares.

## Data plan and what is new

| Need | Today | New work |
|---|---|---|
| Transfers between A and B | `GraphMapper` reads only the last 100 transactions | Read **B's** full history (usually short), capped; read A's recent pages only. Look for the counterparty in both. |
| First funder and true wallet age | `WalletProfiler.first_tx_date` = oldest of the last 100 signatures, not the real first transaction | Page signatures back to the start, capped at ~20 pages; report `complete: false` past the cap. **Check first whether Helius offers a "funded by" call** (do not assume the name or parameters). |
| ATA → owner | `solana-rpc.resolveTokenAccountOwners` | Reuse |
| Labels, entities, behaviour flags | `labeler`, `lookupEntity` | Reuse; add `fast_sweep` detection |
| x402 inflows to B | Nothing | USDC inflows where the fee payer is a known facilitator. Build the facilitator fee-payer list from our own incoming payments (CDP) plus PayAI's published address. |
| B as payout wallet elsewhere | Nothing | Daily cached snapshot of `payTo` addresses from the CDP Bazaar listing |

Cost per call: target ≤ 10 Helius requests. Cache results for 1 hour, keyed by the wallet pair.
If a cold call can pass ~20 s, add the key to `SETTLE_FIRST_ENDPOINTS`.

## Build plan

**Session 1 — measure first (no endpoint yet)**
1. Confirm the Helius history and "funded by" API shapes from the docs.
2. Build the data layer and the pure scorer.
3. Run it on fixtures:
   - same owner: our agent wallet `66Qvhr…` vs operational `5ijYech…`; SolScout `H3Uy…` vs Moneta `5x2U…` (both funded by us);
   - unrelated: `vines1…` vs `2otm6W…`; a random pair of busy wallets;
   - an exchange deposit address as B.
4. Check the verdicts are right and the evidence reads plainly. Tune the weights.

**Session 2 — ship**
- New-endpoint checklist, all 10 steps: `PRICING` ($0.03), handler + Zod schema + LLM formatter, MCP tool,
  `ENDPOINT_META` + suite, `/docs`, SolScout stress config, `test-all-endpoints` entry, README + home card,
  `INPUT_EXAMPLES` (required inputs), skill registries.
- Unit tests for the scorer on the fixtures.
- Deploy in a buyer gap (API restart). Paid SolScout sweep to seed the Bazaar.
- Send Elijah a sample response on a real pair.

## Out of scope for v1

- **Base / EVM wallets.** Most of the Bazaar is on Base. That needs EVM data (BaseEnrich). Decide after Elijah says what share of his wallet changes are on Solana.
- A scam or drainer database. The flags are behaviour patterns only; say so in `/docs`.

## Questions for Elijah

1. What share of the payout-wallet changes you see are on Solana?
2. Do you have past change events you know were rotations or hijacks? Even 5–10 would calibrate the score.
3. Does the 402 give you the owner wallet or the token account?
4. Latency budget per call, and roughly how many change events a day?
5. What would your agents do on `UNCERTAIN`: block, hold, or ask a human?
