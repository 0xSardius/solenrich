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
      description: 'Analyze a Solana SPL token: price, market cap, liquidity, holder concentration (top 1/5/10%), slippage estimates at 4 position sizes ($100/$1K/$10K/$100K), risk flags, and Jupiter verification.',
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
    'portfolio_history',
    {
      title: 'Portfolio History',
      description: 'Full portfolio time-series for a wallet: daily snapshots of value, balance, holdings, and risk score over 7/14/30 days, plus summary stats (peak, trough, max drawdown, average, change vs period start). For charting and PnL tracking.',
      inputSchema: {
        address: z.string().describe('Solana wallet address (base58)'),
        period: z.enum(['7d', '14d', '30d']).default('7d').describe('Lookback period'),
      },
    },
    async (args) => {
      const briefing = await invoke('portfolio-history', {
        address: args.address,
        period: args.period ?? '7d',
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
      description: 'Ask a plain English question about any Solana wallet, token, or market. Single-intent routes to one enricher; compound intents chain 2-3 in parallel and return a unified briefing. Examples: "should I buy <mint>?" (DD + trend + whales), "wallet deep dive on <addr>" (profile + history + perps), "is <mint> safe?", "what\'s trending right now", "SOL-PERP funding rate".',
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
      title: 'Multi-Venue Perps Trader Profile',
      description: 'Open positions across BOTH Jupiter Perps and Adrena for a wallet. Per-venue breakdown plus combined totals. Each position tagged with venue. Trader classification (scalper/swing/position), directional bias, multi-venue exposure flag, and risk flags (high leverage, approaching liquidation, concentrated market). Adrena PnL needs mark prices for jitoSOL/WBTC/BONK and is null when unavailable.',
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
    'hyperliquid_trader_profile',
    {
      title: 'Hyperliquid Trader Profile',
      description: "Live Hyperliquid perp positions for an EVM (0x) address, read from HL's public on-chain state. Per-position side, leverage, notional, entry, unrealized PnL, distance-to-liquidation, and risk flags. Account value, directional bias, profile (directional/market-neutral/diversified), and realized+unrealized PnL over week/month/all-time. The building block for HL smart-money tracking.",
      inputSchema: {
        address: z.string().describe('Hyperliquid EVM (0x) address'),
      },
    },
    async (args) => {
      const briefing = await invoke('hyperliquid-trader-profile', {
        address: args.address,
        format: 'llm',
      });
      return { content: [{ type: 'text' as const, text: briefing }] };
    },
  );

  server.registerTool(
    'hyperliquid_smart_money',
    {
      title: 'Hyperliquid Smart-Money Positioning',
      description: "Where Hyperliquid smart money is positioned. Filters the HL leaderboard to consistent directional traders (excludes market-makers + dust), then aggregates their live positions into a per-coin consensus (long/short counts, net notional, bias, conviction) plus a top-trader drill-down. Optionally focus one coin via `market`. A positioning signal, not a trade — use as confluence/risk context, not a standalone entry.",
      inputSchema: {
        market: z.string().optional().describe('Optional single-coin focus, e.g. HYPE/BTC/ETH'),
        top_traders: z.number().int().min(1).max(25).optional().describe('How many top traders to include (default 10)'),
      },
    },
    async (args) => {
      const briefing = await invoke('hyperliquid-smart-money', {
        ...(args.market ? { market: args.market } : {}),
        ...(args.top_traders ? { top_traders: args.top_traders } : {}),
        format: 'llm',
      });
      return { content: [{ type: 'text' as const, text: briefing }] };
    },
  );

  server.registerTool(
    'perps_basis_signal',
    {
      title: 'Net-Yield-After-Borrow Basis Signal',
      description: 'Computes perp mark vs spot price across venues and surfaces actually-earnable yield. Funding-rate venues (HL, dYdX) generate real yield; pool perps (Jupiter, Adrena) flagged as not viable because they charge borrow on both sides. Returns per-venue trade + filtered opportunities + best trade.',
      inputSchema: {
        asset: z.enum(['SOL', 'BTC', 'ETH', 'BONK']).describe('Asset to scan'),
        min_yield_apr_pct: z.number().min(0).max(100).default(5).describe('Minimum net yield (APR %) for an opportunity to surface'),
      },
    },
    async (args) => {
      const briefing = await invoke('perps-basis-signal', {
        asset: args.asset,
        min_yield_apr_pct: args.min_yield_apr_pct ?? 5,
        format: 'llm',
      });
      return { content: [{ type: 'text' as const, text: briefing }] };
    },
  );

  server.registerTool(
    'perps_market_trend',
    {
      title: 'Jupiter Perps Market Trend',
      description: 'Per-symbol (SOL/BTC/ETH) deltas for mark price, total open interest, long/short skew, utilization, and borrow APR over 7/14/30 days. Direction indicators per metric and per market. Overall direction excludes mark price. Use for regime detection — bots that adjust behavior based on whether markets are growing, stressed, or rebalancing.',
      inputSchema: {
        lookback: z.enum(['7d', '14d', '30d']).default('7d').describe('History window'),
      },
    },
    async (args) => {
      const briefing = await invoke('perps-market-trend', {
        lookback: args.lookback ?? '7d',
        format: 'llm',
      });
      return { content: [{ type: 'text' as const, text: briefing }] };
    },
  );

  server.registerTool(
    'perps_venue_comparison',
    {
      title: 'Cross-Venue Perps Comparison',
      description: 'Where to trade this market at this size. Builds on cross-venue funding with spot slippage, per-venue fee, OI cap headroom, and total entry cost. Returns rankings + recommendation with warnings.',
      inputSchema: {
        market: z.enum(['SOL', 'BTC', 'ETH', 'BONK']).describe('Asset to query'),
        size_usd: z.number().min(100).max(10_000_000).describe('Position size in USD'),
        side: z.enum(['long', 'short']).default('long').describe('Side being sized'),
      },
    },
    async (args) => {
      const briefing = await invoke('perps-venue-comparison', {
        market: args.market,
        size_usd: args.size_usd,
        side: args.side ?? 'long',
        format: 'llm',
      });
      return { content: [{ type: 'text' as const, text: briefing }] };
    },
  );

  server.registerTool(
    'perps_cross_venue_funding',
    {
      title: 'Cross-Venue Perps Funding',
      description: 'Compare borrow/funding APR + OI across Solana on-chain venues (Jupiter Perps, Adrena) and cross-chain reference (Hyperliquid, dYdX v4). Returns best entry per side, basis vs Hyperliquid, and arbitrage opportunities. SOL/BTC/ETH/BONK supported (with venue-specific availability).',
      inputSchema: {
        market: z.enum(['SOL', 'BTC', 'ETH', 'BONK']).describe('Asset to query'),
        include_reference: z.boolean().default(true).describe('Include Hyperliquid + dYdX v4 reference rates'),
      },
    },
    async (args) => {
      const briefing = await invoke('perps-cross-venue-funding', {
        market: args.market,
        include_reference: args.include_reference ?? true,
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

  server.registerTool(
    'check_alerts',
    {
      title: 'Check Alerts',
      description: 'Poll-based event detection covering spot + Jupiter Perps. Pass a watchlist (token mints + wallet addresses) and a since timestamp; receive alerts graded by severity. Spot alerts: price spike/drop, risk change, whale flow, concentration shift, portfolio value change, position add/remove. Jupiter Perps alerts per wallet: position opened, position closed, at-risk (high leverage or underwater), liquidation approaching, PnL swing. Stateless — caller owns the cursor.',
      inputSchema: {
        tokens: z.array(z.string()).max(10).default([]).describe('Token mints to watch (max 10)'),
        wallets: z.array(z.string()).max(10).default([]).describe('Wallet addresses to watch — spot + Jupiter Perps (max 10)'),
        since: z.string().describe('ISO 8601 timestamp — return alerts fired since this moment'),
      },
    },
    async (args) => {
      const briefing = await invoke('check-alerts', {
        tokens: args.tokens ?? [],
        wallets: args.wallets ?? [],
        since: args.since,
        format: 'llm',
      });
      return { content: [{ type: 'text' as const, text: briefing }] };
    },
  );

  server.registerTool(
    'consensus_signal',
    {
      title: 'Agent Attention Signal',
      description: 'What tokens or wallets are being queried by other agents right now. Proprietary data derived from SolEnrich\'s own query stream. Pass `address` for that entity\'s rank/percentile/trend; omit it for top-N. Windows: 1h, 6h, 24h.',
      inputSchema: {
        type: z.enum(['token', 'wallet']).default('token').describe('Entity type to query'),
        address: z.string().optional().describe('Optional Solana address — single-entity report when provided'),
        window: z.enum(['1h', '6h', '24h']).default('1h').describe('Lookback window'),
        limit: z.number().int().min(1).max(50).default(10).describe('Top-N size when address is omitted'),
      },
    },
    async (args) => {
      const briefing = await invoke('consensus-signal', {
        type: args.type ?? 'token',
        ...(args.address ? { address: args.address } : {}),
        window: args.window ?? '1h',
        limit: args.limit ?? 10,
        format: 'llm',
      });
      return { content: [{ type: 'text' as const, text: briefing }] };
    },
  );

  return server;
}
