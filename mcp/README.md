# SolEnrich MCP Server

MCP (Model Context Protocol) wrapper for SolEnrich. Exposes Solana enrichment tools to Claude Desktop and other MCP clients.

## Setup

### 1. Start the SolEnrich agent

```bash
bun run dev
```

### 2. Configure Claude Desktop

Add to your Claude Desktop MCP config (`claude_desktop_config.json`):

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

### 3. Use in Claude Desktop

Once configured, Claude can use these tools:

- **enrich_wallet** — Wallet profiling (holdings, labels, risk score)
- **enrich_token** — Token analysis (price, security, holders)
- **parse_transaction** — Transaction parsing (type, protocol, transfers)
- **whale_watch** — Large holder tracking and flow patterns
- **due_diligence** — Comprehensive token research briefing
- **wallet_graph** — Wallet connection mapping and cluster detection
- **copy_trade_signals** — Trading performance analysis

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `SOLENRICH_URL` | `http://127.0.0.1:3000` | URL of the running SolEnrich agent |
