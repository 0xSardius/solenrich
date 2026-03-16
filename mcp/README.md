# SolEnrich MCP Server

MCP (Model Context Protocol) wrapper for SolEnrich. Exposes Solana enrichment tools to Claude Desktop, Claude Code, and other MCP clients.

By default, the MCP server connects to the **production API** at `https://solenrich-production.up.railway.app`. Endpoints require x402 USDC payment on Solana — if payment is missing, the tool returns pricing details.

## Setup

### Claude Desktop

Add to your Claude Desktop MCP config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "solenrich": {
      "command": "bun",
      "args": ["run", "mcp/server.ts"],
      "cwd": "/path/to/solenrich"
    }
  }
}
```

### Claude Code

Add to `.claude/settings.json`:

```json
{
  "mcpServers": {
    "solenrich": {
      "command": "bun",
      "args": ["run", "mcp/server.ts"],
      "cwd": "/path/to/solenrich"
    }
  }
}
```

### Local Development

To point at a local SolEnrich instance instead of production:

```json
{
  "mcpServers": {
    "solenrich": {
      "command": "bun",
      "args": ["run", "mcp/server.ts"],
      "cwd": "/path/to/solenrich",
      "env": {
        "SOLENRICH_URL": "http://127.0.0.1:3000"
      }
    }
  }
}
```

Then start the agent locally with `bun run dev`.

## Available Tools

- **enrich_wallet** — Wallet profiling (holdings, labels, risk score, DeFi positions)
- **enrich_token** — Token analysis (price, security, holders, risk flags)
- **parse_transaction** — Transaction parsing (type, protocol, transfers)
- **whale_watch** — Large holder tracking and accumulation/distribution patterns
- **due_diligence** — Comprehensive token research briefing
- **wallet_graph** — Wallet connection mapping and cluster detection
- **copy_trade_signals** — Trading performance analysis (win rate, PnL)

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `SOLENRICH_URL` | `https://solenrich-production.up.railway.app` | SolEnrich agent URL |
