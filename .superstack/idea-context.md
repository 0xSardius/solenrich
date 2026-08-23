# Idea Context — Next-Build Validation Sprint (2026-08-23)

Question: which candidate provides the most value next — daily digest infographic, Eris
seed-widening, Ananke perps bot, card-market-scan (Collector Crypt), or a paid image-card
endpoint for Telegram bots?

## Measured inputs (this session)

- `/metrics` (prod, authed): **first organic paid caller observed** —
  `x402:JC9uSJ5rQi6BsKUR3b9sYHDrsnas8ZMSebwahqvujYg1` paid for `enrich-wallet-light` +
  `enrich-token-light` on 2026-08-23. Baseline 2026-07-11 was 0 organic.
- Last 7 days of paid 200s: 65 / 0 / 20 / 0 / 0 / 3 / 6 (the 65 and part of 20 are our own
  SolScout runs; the 3 and 6 are not).
- x402scan: past 30 days **145 txns, $3.44, 20 buyers**; all-time **588 txns, $8.92, 28
  buyers**. 20 of 28 all-time buyers active in the last 30 days → buyer discovery is
  accelerating post-dual-network + agentic.market cataloging. Volume per buyer is tiny —
  these are probes, not workflows.

## Interpretation

Distribution work (dual-network, agentic.market, bazaar) is working: strangers now find and
probe the API. The funnel gap is conversion — probes are not becoming repeat callers. The
binding constraint is still demand/proof, not supply. 37 endpoints is enough supply.

## validation

```json
{
  "demand_signals": [
    "First organic paid x402 caller (JC9uSJ5r...) hit wallet+token endpoints 2026-08-23; organic baseline was 0 on 2026-07-11",
    "x402scan: 20 distinct buyers in past 30 days vs 28 all-time (71% recent) — discovery accelerating",
    "Buyer volume ~$0.17/buyer/30d — probes without retention; proof/visibility gap, not supply gap"
  ],
  "risks": [
    { "category": "market", "description": "Digest card gets no engagement; marketing artifact unproven", "severity": "low" },
    { "category": "operational", "description": "Stale digest on homepage reads as dead project if cron fails silently", "severity": "medium" },
    { "category": "legal", "description": "Collector Crypt API has no stated terms of use (Polymarket §4.2 precedent)", "severity": "high-for-card-market-scan" },
    { "category": "market", "description": "Eris/Ananke bots multi-session builds with unmeasured trigger economics; 3 prior bots stalled", "severity": "high-if-built-before-measuring" }
  ],
  "go_no_go": "go",
  "confidence": 0.75,
  "next_steps": [
    "BUILD: daily digest infographic as standalone script (GH Actions cron, paid x402 calls, post + website embed with staleness guard) — 1-2 sessions",
    "MEASURE: widen trenches seed set 14 -> 100-200 wallets, re-run Eris trigger-rate probe; improves smart-money-trenches either way — 1 session",
    "EMAIL (Sardius): Collector Crypt data-terms question; unblocks or kills card-market-scan for ~0 cost",
    "MEASURE: Ananke trigger economics (funding dislocations + regime flips per week from our own perps endpoints) before any bot build",
    "PARK: paid image-card endpoint until a bot builder asks (tripwire)",
    "WATCH: identify organic caller JC9uSJ5r... pattern; check pay.sh PR #176 status"
  ]
}
```

Integration-first note: every candidate composes existing SolEnrich endpoints or external
public APIs; none needs new on-chain programs. The digest is pure integration (satori +
resvg over our own API).
