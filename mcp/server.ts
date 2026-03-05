/**
 * Phase 10: MCP Server Wrapper
 *
 * Thin MCP wrapper that exposes SolEnrich endpoints as MCP tools.
 * Uses the official @modelcontextprotocol/sdk.
 *
 * Tools registered:
 *   - enrich_wallet: wallet profiling with labels, risk score, holdings
 *   - enrich_token: token analysis with price, security, holder data
 *   - parse_transaction: transaction parsing with protocol detection
 *   - whale_watch: large holder tracking and accumulation/distribution
 *   - due_diligence: comprehensive token research briefing
 *
 * The MCP server makes HTTP requests to the running SolEnrich agent.
 * x402 payment will happen automatically once @x402/solana ships.
 *
 * Transport: stdio (for Claude Desktop / MCP client integration)
 *
 * Run: bun run mcp/server.ts
 * Or configure in Claude Desktop's MCP settings.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// --- Config ---

const AGENT_URL = process.env.SOLENRICH_URL ?? 'http://127.0.0.1:3000';

// --- Helper: invoke a SolEnrich entrypoint ---

async function invoke(entrypointKey: string, input: Record<string, unknown>): Promise<string> {
  const url = `${AGENT_URL}/entrypoints/${entrypointKey}/invoke`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SolEnrich ${entrypointKey} returned ${res.status}: ${text}`);
  }

  const json = await res.json() as any;

  if (json.status === 'failed') {
    throw new Error(`SolEnrich ${entrypointKey} failed: ${json.error ?? 'unknown error'}`);
  }

  // Extract the briefing text from LLM format response
  const output = json.output;
  if (typeof output?.briefing === 'string') {
    return output.briefing;
  }

  // Fallback: return stringified output
  return JSON.stringify(output, null, 2);
}

// --- MCP Server ---

const server = new McpServer({
  name: 'SolEnrich',
  version: '1.0.0',
});

// Tool 1: Wallet Enrichment
server.registerTool(
  'enrich_wallet',
  {
    title: 'Enrich Wallet',
    description: 'Get a Solana wallet profile: SOL balance, token holdings, DeFi positions, labels (whale, active_trader, defi_user), and risk score.',
    inputSchema: {
      address: z.string().describe('Solana wallet address (base58, 32-44 chars)'),
      depth: z.enum(['light', 'full']).default('light').describe('light = basic profile, full = includes DeFi positions and connected wallets'),
    },
  },
  async (args) => {
    const briefing = await invoke('enrich-wallet-light', {
      address: args.address,
      depth: args.depth ?? 'light',
      format: 'llm',
    });
    // Use full variant if depth=full
    if (args.depth === 'full') {
      const fullBriefing = await invoke('enrich-wallet-full', {
        address: args.address,
        depth: 'full',
        format: 'llm',
      });
      return { content: [{ type: 'text' as const, text: fullBriefing }] };
    }
    return { content: [{ type: 'text' as const, text: briefing }] };
  },
);

// Tool 2: Token Enrichment
server.registerTool(
  'enrich_token',
  {
    title: 'Enrich Token',
    description: 'Analyze a Solana SPL token: price, market cap, liquidity, holder distribution, risk flags, and Jupiter verification status.',
    inputSchema: {
      mint: z.string().describe('Token mint address (base58)'),
      include_holders: z.boolean().default(false).describe('Include top holder data'),
    },
  },
  async (args) => {
    const key = args.include_holders ? 'enrich-token-full' : 'enrich-token-light';
    const briefing = await invoke(key, {
      mint: args.mint,
      include_holders: args.include_holders ?? false,
      format: 'llm',
    });
    return { content: [{ type: 'text' as const, text: briefing }] };
  },
);

// Tool 3: Transaction Parsing
server.registerTool(
  'parse_transaction',
  {
    title: 'Parse Transaction',
    description: 'Parse a Solana transaction: type, protocol, SOL/token transfers, accounts involved, and fee details.',
    inputSchema: {
      signature: z.string().describe('Transaction signature (base58, 87-88 chars)'),
    },
  },
  async (args) => {
    const briefing = await invoke('parse-transaction', {
      signature: args.signature,
      format: 'llm',
    });
    return { content: [{ type: 'text' as const, text: briefing }] };
  },
);

// Tool 4: Whale Watch
server.registerTool(
  'whale_watch',
  {
    title: 'Whale Watch',
    description: 'Track large token holders: identify whales, detect accumulation/distribution patterns, and measure whale activity volume.',
    inputSchema: {
      mint: z.string().describe('Token mint address (base58)'),
      threshold_usd: z.number().default(10000).describe('Minimum USD value to qualify as whale activity'),
      lookback_hours: z.number().default(24).describe('How many hours to look back (1-168)'),
    },
  },
  async (args) => {
    const briefing = await invoke('whale-watch', {
      mint: args.mint,
      threshold_usd: args.threshold_usd ?? 10000,
      lookback_hours: args.lookback_hours ?? 24,
      format: 'llm',
    });
    return { content: [{ type: 'text' as const, text: briefing }] };
  },
);

// Tool 5: Due Diligence
server.registerTool(
  'due_diligence',
  {
    title: 'Due Diligence',
    description: 'Comprehensive token research: security audit, whale activity, holder concentration, risk score, and SAFE/CAUTION/RISKY recommendation.',
    inputSchema: {
      mint: z.string().describe('Token mint address (base58)'),
    },
  },
  async (args) => {
    const briefing = await invoke('due-diligence', {
      mint: args.mint,
      format: 'llm',
    });
    return { content: [{ type: 'text' as const, text: briefing }] };
  },
);

// Tool 6: Wallet Graph
server.registerTool(
  'wallet_graph',
  {
    title: 'Wallet Graph',
    description: 'Map wallet connections: find counterparties, detect clusters of coordinated wallets, and identify suspicious patterns.',
    inputSchema: {
      address: z.string().describe('Solana wallet address (base58)'),
      depth: z.number().default(1).describe('Hop depth (1 or 2)'),
    },
  },
  async (args) => {
    const briefing = await invoke('wallet-graph', {
      address: args.address,
      depth: args.depth ?? 1,
      min_interactions: 1,
      format: 'llm',
    });
    return { content: [{ type: 'text' as const, text: briefing }] };
  },
);

// Tool 7: Copy Trade Signals
server.registerTool(
  'copy_trade_signals',
  {
    title: 'Copy Trade Signals',
    description: 'Analyze a wallet\'s trading performance: win rate, PnL, consistency, hold time, and smart_money classification.',
    inputSchema: {
      address: z.string().describe('Solana wallet address (base58)'),
      lookback_days: z.number().default(30).describe('Days to analyze (1-90)'),
    },
  },
  async (args) => {
    const briefing = await invoke('copy-trade-signals', {
      address: args.address,
      lookback_days: args.lookback_days ?? 30,
      format: 'llm',
    });
    return { content: [{ type: 'text' as const, text: briefing }] };
  },
);

// --- Start ---

const transport = new StdioServerTransport();
await server.connect(transport);
