# agentic.market listing enrichment request (draft, 2026-09-03)

**Status of our entry** (`api.agentic.market/v1/services/api-solenrich-com`, checked 2026-09-03):
`name: "api.solenrich.com"`, `description: ""`, `category: ""`, `providerUrl: ""`, `enriched: false`.
All 38 endpoints are cataloged, networks Base + Solana. Entries like Exa are `enriched: true`
with a clean name, category, and one-line description. That is a curation pass on their side.

**Who runs it:** the site footer says "This marketplace is operated by Coinbase." So this goes to
the CDP x402 team, not a third party. Channels, best first:
1. CDP Discord, the x402 channel (tag the agentic.market maintainers).
2. Reply/DM on the @agenticmarket or @CoinbaseDev announcement post for agentic.market.
3. `x402` GitHub org discussions (coinbase/x402) if no Discord response in a week.

---

**Subject:** agentic.market listing enrichment — SolEnrich (api-solenrich-com)

Hi team,

SolEnrich was auto-imported into agentic.market after we enabled Base accepts on 2026-07-09
(`agentic.market/services/api-solenrich-com`). All 38 endpoints cataloged correctly, thank you.

The service-level fields are still blank (`enriched: false`): the name shows as the domain,
category and description are empty, and there is no provider URL. Could you run the enrichment
pass on us? Suggested values:

- **Name:** SolEnrich
- **Category:** Data
- **Provider URL:** https://www.solenrich.com
- **Description:** Agent-native onchain intelligence for Solana traders: cross-venue perps
  funding (Jupiter, Adrena, Flash, Hyperliquid), smart-money and whale tracking, token
  due-diligence and rug detection, memecoin trenches-to-exit signals, and wallet risk scoring.
  Pay-per-call via x402 (USDC on Solana or Base). JSON for agents, natural-language briefings
  for LLMs.

Everything above is also machine-readable at:
- `https://api.solenrich.com/.well-known/x402` (service description + all resources)
- `https://api.solenrich.com/openapi.json`
- `https://api.solenrich.com/llms.txt`

We settle through the CDP facilitator on both networks and are in the official MCP registry
(`io.github.0xSardius/solenrich`). Happy to be a showcase example of a dual-network Solana-native
x402 data service if useful.

Thanks,
Sardius (@0xSardius)
Parallax Labs — https://www.solenrich.com
