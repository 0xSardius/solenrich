# SolEnrich MCP Server

MCP (Model Context Protocol) wrapper for SolEnrich. Exposes Solana enrichment tools to Claude Desktop, Claude Code, Cursor, and other MCP clients.

Endpoints require x402 USDC payment on Solana — if payment is missing, the tool returns pricing details.

## Quick Setup (Remote — No Install)

The easiest way to use SolEnrich. No cloning, no dependencies. Just add the remote URL to your MCP client config.

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "solenrich": {
      "type": "streamable-http",
      "url": "https://solenrich-production.up.railway.app/mcp"
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
      "type": "streamable-http",
      "url": "https://solenrich-production.up.railway.app/mcp"
    }
  }
}
```

## Local Setup (stdio)

If you prefer to run the MCP server locally (requires Bun):

### Claude Desktop

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

To point at a local SolEnrich instance:

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

## Available Tools

| Tool | Description |
|------|-------------|
| **enrich_wallet** | Wallet profiling — holdings, labels, risk score + level, DeFi positions |
| **enrich_token** | Token analysis — price, security, holder concentration, risk flags |
| **parse_transaction** | Transaction parsing — type, protocol, transfers, fees |
| **whale_watch** | Top holder tracking — balances, % supply, buy/sell volumes |
| **due_diligence** | Full token research — security, holders, whales, SAFE/CAUTION/RISKY verdict |
| **wallet_graph** | Wallet connection mapping and cluster detection |
| **copy_trade_signals** | Trading performance — win rate, PnL, smart money classification |

## MCP Endpoint

**Remote:** `https://solenrich-production.up.railway.app/mcp`
**Transport:** Streamable HTTP (MCP spec 2025-03-26)
**Protocol:** Stateless — each request creates a fresh server instance

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `SOLENRICH_URL` | `https://solenrich-production.up.railway.app` | SolEnrich agent URL (for stdio transport) |
