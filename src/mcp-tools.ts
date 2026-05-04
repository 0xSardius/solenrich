/**
 * Shared MCP tool definitions for SolEnrich.
 * Used by both stdio (mcp/server.ts) and HTTP (src/lib/agent.ts) transports.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const AGENT_URL = process.env.SOLENRICH_URL ?? 'https://api.solenrich.com';

async function invoke(entrypointKey: string, input: Record<string, unknown>): Promise<string> {
  const url = `${AGENT_URL}/entrypoints/${entrypointKey}/invoke`;

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input }),
  });

  if (res.status === 402) {
    const paymentHeader = res.headers.get('Payment-Required');
    let paymentInfo = '';
    if (paymentHeader) {
      try {
        const decoded = JSON.parse(atob(paymentHeader));
        const accept = decoded.accepts?.[0];
        if (accept) {
          paymentInfo = `\n\nPayment details:\n- Amount: ${accept.amount} USDC base units ($${(Number(accept.amount) / 1_000_000).toFixed(4)})\n- Network: ${accept.network}\n- Pay to: ${accept.payTo}`;
        }
      } catch { /* ignore decode errors */ }
    }
    throw new Error(`SolEnrich ${entrypointKey} requires x402 payment. This endpoint is pay-per-request via USDC on Solana.${paymentInfo}`);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SolEnrich ${entrypointKey} returned ${res.status}: ${text}`);
  }

  const json = await res.json() as any;

  if (json.status === 'failed') {
    throw new Error(`SolEnrich ${entrypointKey} failed: ${json.error ?? 'unknown error'}`);
  }

  const output = json.output;
  if (typeof output?.briefing === 'string') {
    return output.briefing;
  }

  return JSON.stringify(output, null, 2);
}

export function createSolEnrichMcpServer(): McpServer {
  const server = new McpServer({
    name: 'SolEnrich',
    version: '1.0.0',
  });

  server.registerTool(
    'enrich_wallet',
    {
      title: 'Enrich Wallet',
      description: 'Get a Solana wallet profile: SOL balance, token holdings, DeFi positions, labels (whale, active_trader, defi_user), risk score, and risk level.',
      inputSchema: {
        address: z.string().describe('Solana wallet address (base58, 32-44 chars)'),
        depth: z.enum(['light', 'full']).default('light').describe('light = basic profile, full = includes DeFi positions and connected wallets'),
      },
    },
    async (args) => {
      const key = args.depth === 'full' ? 'enrich-wallet-full' : 'enrich-wallet-light';
      const briefing = await invoke(key, {
        address: args.address,
        depth: args.depth ?? 'light',
        format: 'llm',
      });
      return { content: [{ type: 'text' as const, text: briefing }] };
    },
  );

  server.registerTool(
    'enrich_token',
    {
      title: 'Enrich Token',
      description: 'Analyze a Solana SPL token: price, market cap, liquidity, holder concentration (top 1/5/10%), risk flags, and Jupiter verification.',
      inputSchema: {
        mint: z.string().describe('Token mint address (base58)'),
        include_holders: z.boolean().default(false).describe('Include top 20 holders with balances and % supply'),
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

  server.registerTool(
    'whale_watch',
    {
      title: 'Whale Watch',
      description: 'Track top token holders: balances, % supply, buy/sell volumes, accumulation vs distribution signals.',
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

  server.registerTool(
    'due_diligence',
    {
      title: 'Due Diligence',
      description: 'Comprehensive token research: security audit, holder concentration, whale activity, risk score with level (LOW-CRITICAL), and SAFE/CAUTION/RISKY verdict.',
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

  server.registerTool(
    'batch_enrich',
    {
      title: 'Batch Enrich',
      description: 'Enrich multiple wallets or tokens in a single call (1-25). Returns parallel results.',
      inputSchema: {
        addresses: z.array(z.string()).describe('Array of Solana addresses (1-25)'),
        type: z.enum(['wallet', 'token']).describe('Address type: wallet or token'),
        depth: z.enum(['light', 'full']).default('light').describe('Enrichment depth'),
      },
    },
    async (args) => {
      const briefing = await invoke('batch-enrich', {
        addresses: args.addresses,
        type: args.type,
        depth: args.depth ?? 'light',
        format: 'llm',
      });
      return { content: [{ type: 'text' as const, text: briefing }] };
    },
  );

  server.registerTool(
    'compare_tokens',
    {
      title: 'Compare Tokens',
      description: 'Side-by-side comparison of 2-3 tokens: price, liquidity, volatility, holder concentration, risk. Rankings and summary picks.',
      inputSchema: {
        mints: z.array(z.string()).describe('2-3 token mint addresses to compare'),
      },
    },
    async (args) => {
      const briefing = await invoke('compare-tokens', {
        mints: args.mints,
        format: 'llm',
      });
      return { content: [{ type: 'text' as const, text: briefing }] };
    },
  );

  server.registerTool(
    'compare_wallets',
    {
      title: 'Compare Wallets',
      description: 'Side-by-side comparison of 2-3 wallets: portfolio, activity, risk, labels. Rankings and summary picks.',
      inputSchema: {
        addresses: z.array(z.string()).describe('2-3 wallet addresses to compare'),
        depth: z.enum(['light', 'full']).default('light').describe('Enrichment depth'),
      },
    },
    async (args) => {
      const briefing = await invoke('compare-wallets', {
        addresses: args.addresses,
        depth: args.depth ?? 'light',
        format: 'llm',
      });
      return { content: [{ type: 'text' as const, text: briefing }] };
    },
  );

  server.registerTool(
    'token_trend',
    {
      title: 'Token Trend',
      description: 'Token metrics over time: daily snapshots with direction indicators (improving/declining/stable) per metric.',
      inputSchema: {
        mint: z.string().describe('Token mint address (base58)'),
        lookback: z.enum(['7d', '14d', '30d']).default('7d').describe('Lookback period'),
      },
    },
    async (args) => {
      const briefing = await invoke('token-trend', {
        mint: args.mint,
        lookback: args.lookback ?? '7d',
        format: 'llm',
      });
      return { content: [{ type: 'text' as const, text: briefing }] };
    },
  );

  server.registerTool(
    'wallet_history',
    {
      title: 'Wallet History',
      description: 'Wallet portfolio over time: snapshots with position changes (added/removed holdings) and direction indicators.',
      inputSchema: {
        address: z.string().describe('Solana wallet address (base58)'),
        lookback: z.enum(['7d', '14d', '30d']).default('7d').describe('Lookback period'),
      },
    },
    async (args) => {
      const briefing = await invoke('wallet-history', {
        address: args.address,
        lookback: args.lookback ?? '7d',
        format: 'llm',
      });
      return { content: [{ type: 'text' as const, text: briefing }] };
    },
  );

  server.registerTool(
    'new_tokens',
    {
      title: 'New Tokens',
      description: 'Discover recently launched Solana tokens. Filters by liquidity and risk score, ranked safest first.',
      inputSchema: {
        min_liquidity_usd: z.number().default(1000).describe('Minimum liquidity in USD'),
        max_risk_score: z.number().default(0.8).describe('Maximum risk score (0-1)'),
        limit: z.number().default(10).describe('Number of tokens to return (1-20)'),
      },
    },
    async (args) => {
      const briefing = await invoke('new-tokens', {
        min_liquidity_usd: args.min_liquidity_usd ?? 1000,
        max_risk_score: args.max_risk_score ?? 0.8,
        limit: args.limit ?? 10,
        format: 'llm',
      });
      return { content: [{ type: 'text' as const, text: briefing }] };
    },
  );

  server.registerTool(
    'protocol_profile',
    {
      title: 'Protocol Profile',
      description: 'DeFi protocol analytics: TVL, yield pools, on-chain activity, health signals. Supports Raydium, Orca, marginfi, Drift, Jupiter, Kamino, Marinade, Jito, and more.',
      inputSchema: {
        protocol: z.string().describe('Protocol slug (e.g. "raydium", "orca") or Solana program ID'),
        include_yields: z.boolean().default(true).describe('Include yield pool data'),
      },
    },
    async (args) => {
      const briefing = await invoke('protocol-profile', {
        protocol: args.protocol,
        include_yields: args.include_yields ?? true,
        format: 'llm',
      });
      return { content: [{ type: 'text' as const, text: briefing }] };
    },
  );

  server.registerTool(
    'query',
    {
      title: 'Query',
      description: 'Ask a plain English question about any Solana wallet, token, or protocol. Routes to the right enricher automatically. Example: "Is JUP safe?" or "What does this wallet do?"',
      inputSchema: {
        question: z.string().describe('Natural language question about a Solana wallet or token'),
      },
    },
    async (args) => {
      const briefing = await invoke('query', {
        question: args.question,
        format: 'llm',
      });
      return { content: [{ type: 'text' as const, text: briefing }] };
    },
  );

  server.registerTool(
    'perps_market_structure',
    {
      title: 'Jupiter Perps Market Structure',
      description: 'Per-market OI, utilization, borrow APR, skew, OI caps, and health flags across Jupiter Perps SOL/BTC/ETH. Reads on-chain Anchor accounts directly.',
      inputSchema: {},
    },
    async () => {
      const briefing = await invoke('perps-market-structure', { format: 'llm' });
      return { content: [{ type: 'text' as const, text: briefing }] };
    },
  );

  server.registerTool(
    'perps_trader_profile',
    {
      title: 'Jupiter Perps Trader Profile',
      description: 'Open Jupiter Perps positions for a wallet with size, leverage, entry, unrealized PnL, trader classification (scalper/swing/position), and risk flags.',
      inputSchema: {
        address: z.string().describe('Solana wallet address'),
      },
    },
    async (args) => {
      const briefing = await invoke('perps-trader-profile', {
        address: args.address,
        format: 'llm',
      });
      return { content: [{ type: 'text' as const, text: briefing }] };
    },
  );

  server.registerTool(
    'trending_signals',
    {
      title: 'Trending Signals',
      description: 'Ranked list of Solana tokens worth paying attention to right now. Composes DexScreener trending + risk scoring + whale-flow into a composite signal with reasoning.',
      inputSchema: {
        min_liquidity_usd: z.number().default(10_000).describe('Minimum liquidity in USD'),
        max_risk_score: z.number().min(0).max(1).default(0.7).describe('Maximum risk score (0-1)'),
        limit: z.number().int().min(1).max(20).default(10).describe('Number of tokens to return'),
        include_whale_watch: z.boolean().default(true).describe('Include whale flow signal'),
      },
    },
    async (args) => {
      const briefing = await invoke('trending-signals', {
        min_liquidity_usd: args.min_liquidity_usd ?? 10_000,
        max_risk_score: args.max_risk_score ?? 0.7,
        limit: args.limit ?? 10,
        include_whale_watch: args.include_whale_watch ?? true,
        format: 'llm',
      });
      return { content: [{ type: 'text' as const, text: briefing }] };
    },
  );

  server.registerTool(
    'smart_money_flow',
    {
      title: 'Smart Money Flow',
      description: 'Where high-performing Solana wallets are moving. Scores seed wallets by copy-trade metrics, surfaces tokens they\'re accumulating, and maps wallet clusters.',
      inputSchema: {
        wallets: z.array(z.string()).max(30).optional().describe('Optional wallet addresses to score (curated default used if omitted)'),
        lookback_days: z.number().int().min(1).max(90).default(14).describe('Copy-trade lookback window'),
        min_win_rate: z.number().min(0).max(1).default(0.55).describe('Minimum win rate to qualify'),
        top_n_tokens: z.number().int().min(1).max(20).default(10).describe('Max accumulated tokens to surface'),
        include_graph: z.boolean().default(true).describe('Include wallet cluster analysis'),
      },
    },
    async (args) => {
      const briefing = await invoke('smart-money-flow', {
        wallets: args.wallets,
        lookback_days: args.lookback_days ?? 14,
        min_win_rate: args.min_win_rate ?? 0.55,
        top_n_tokens: args.top_n_tokens ?? 10,
        include_graph: args.include_graph ?? true,
        format: 'llm',
      });
      return { content: [{ type: 'text' as const, text: briefing }] };
    },
  );

  server.registerTool(
    'feed_latest',
    {
      title: 'SolEnrich Daily Brief',
      description: 'Daily intelligence brief — pre-computed ranking of trending Solana tokens with composite-signal scoring. Cached 24h, lazy-populated on cache miss. Pass `since` (ISO 8601) to short-circuit on no-change polls.',
      inputSchema: {
        since: z.string().optional().describe('Optional ISO 8601 timestamp of last successful poll. If brief is not newer, response sets unchanged=true with empty payload.'),
      },
    },
    async (args) => {
      const briefing = await invoke('feed-latest', {
        ...(args.since ? { since: args.since } : {}),
        format: 'llm',
      });
      return { content: [{ type: 'text' as const, text: briefing }] };
    },
  );

  return server;
}
