# Distribution Submissions — P1 ready-to-use pack (2026-06-27)

Everything needed to fix SolEnrich's discoverability gaps. Built from the audit
(`discoverability-audit.md`). **Root fix across every surface: lead with CAPABILITY, not brand.**
"SolEnrich" means nothing to an agent searching "Solana wallet risk score API" — the copy below
front-loads the exact phrases agents/operators search.

Legend: **[Claude]** = drafted here, ready. **[Sardius]** = needs a manual login/submit/PR.

---

## 0. Canonical copy (use everywhere — bazaar metadata, MCP, directories, SEO)

**Tagline (one-liner):**
> Onchain intelligence for AI agents trading Solana — wallet risk scoring, token due-diligence, cross-venue perps funding, and smart-money signals. Pay-per-call via x402.

**Short (~150 chars):**
> Solana onchain intelligence API for AI agents: wallet risk scoring, token due-diligence, cross-venue perps funding rates, smart-money tracking. Pay-per-call (x402) + MCP.

**Medium (~2 sentences):**
> SolEnrich is the agent-native onchain intelligence layer for Solana: wallet risk & profiling, token due-diligence / rug detection, cross-venue perps funding (Jupiter + Adrena + Flash + Hyperliquid + dYdX), smart-money positioning, whale tracking, and copy-trade signals. 31 endpoints, pay-per-call via x402 (USDC) or Stripe, plus a remote MCP server for Claude/Cursor.

**Intent keywords / tags (use as the literal tags):**
`solana` · `ai-agents` · `x402` · `mcp` · `wallet-risk-score` · `token-due-diligence` · `rug-detection` ·
`perps-funding-rate` · `cross-venue-perps` · `hyperliquid` · `smart-money` · `whale-tracking` ·
`copy-trade-signals` · `onchain-data` · `defi-intelligence`

**The exact search phrases to embed** (so we rank for capability queries we currently lose):
"Solana wallet risk score", "token due diligence", "rug check", "cross-venue perps funding rate",
"smart money tracker", "Solana whale tracking", "agent-native onchain data", "Nansen alternative for agents".

---

## 1. CDP x402 Bazaar — improve ranking (we're IN, but lose capability searches) **[Claude — code]**

We rank for brand/exact-description but not "wallet risk score" / "perps funding". The bazaar indexes our
service description + per-route descriptions. Action: make the agent/service description capability-led
(the per-route descriptions are already rich). Update `AGENT_DESCRIPTION` (Railway env) **and** the default
in `src/lib/agent.ts` to the Medium copy above. Re-seed (`SolScout --paid`) so the new metadata re-indexes.

---

## 2. MCP — Official Registry (highest leverage; downstream registries mirror it) **[Sardius — publish]**

`server.json` (DNS namespace — we own solenrich.com; alt: `io.github.0xsardius/solenrich` via GitHub auth):
```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-07-09/server.json",
  "name": "com.solenrich/solenrich",
  "description": "Solana onchain intelligence API for AI agents: wallet risk scoring, token due-diligence, cross-venue perps funding rates, smart-money tracking. Pay-per-call via x402.",
  "repository": { "url": "https://github.com/0xSardius/solenrich", "source": "github" },
  "version": "1.0.0",
  "remotes": [
    { "type": "streamable-http", "url": "https://api.solenrich.com/mcp" }
  ]
}
```
Publish: install `mcp-publisher` CLI → auth (DNS TXT record for `com.solenrich`, or GitHub OAuth for the
`io.github.*` namespace) → `mcp-publisher publish`. Docs: github.com/modelcontextprotocol/registry.

---

## 3. MCP — Smithery (FIX existing listing) **[Sardius — login]**

At smithery.ai → SolEnrich (`solenrich/SE01`):
- Remote URL → `https://api.solenrich.com/mcp` (streamable-http)
- Description → the **Medium copy** above (current copy omits perps + smart-money entirely)
- Tool count/list → refresh to the real 29 tools

## 4. MCP — Glama / PulseMCP / mcp.so (NEW) **[Sardius — submit]**
- Glama: glama.ai/mcp/servers → "Add server" (or it auto-indexes a public GitHub repo)
- PulseMCP: pulsemcp.com/submit
- mcp.so: mcp.so/submit
For each, paste: name `SolEnrich`, URL `https://api.solenrich.com/mcp`, the **Medium copy**, the tags above.

---

## 5. awesome-list PRs (free, high-authority backlinks) **[Sardius — PR]**

**`github.com/solana-foundation/awesome-solana-ai`** — under the data/API section:
```markdown
- [SolEnrich](https://api.solenrich.com) — Onchain intelligence API for Solana trading agents: wallet risk scoring, token due-diligence, cross-venue perps funding (Jupiter/Adrena/Flash/Hyperliquid), smart-money tracking. Pay-per-call via x402; remote MCP server included.
```

**`github.com/xpaysh/awesome-x402`** — under services/sellers:
```markdown
- [SolEnrich](https://api.solenrich.com) — Solana onchain intelligence (wallet risk, token due-diligence, cross-venue perps funding, smart-money) for AI agents. 31 endpoints, pay-per-call via x402, + MCP.
```

---

## 6. MPPScan (eligible now — MPP + OpenAPI) **[Sardius — submit]**

mppscan.com/register → API name `SolEnrich`, OpenAPI URL `https://api.solenrich.com/openapi.json`,
description = **Short copy**. (We already expose the OpenAPI discovery doc MPPScan ingests.)

---

## 7. agentic.market — should now auto-index **[verify]**

It auto-indexes CDP-bazaar resources. Now that we're in the bazaar (confirmed 2026-06-27), check
agentic.market in a few days for a SolEnrich listing; no manual action unless still absent.

---

## Real MCP tool list (29) — for any submission that wants it
enrich_wallet, enrich_token, parse_transaction, whale_watch, due_diligence, wallet_graph,
copy_trade_signals, batch_enrich, compare_tokens, compare_wallets, token_trend, wallet_history,
portfolio_history, new_tokens, protocol_profile, query, perps_market_structure, perps_trader_profile,
hyperliquid_trader_profile, hyperliquid_smart_money, perps_basis_signal, perps_market_trend,
perps_venue_comparison, perps_cross_venue_funding, trending_signals, smart_money_flow, feed_latest,
check_alerts, consensus_signal
