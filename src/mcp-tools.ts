/**
 * Shared MCP tool definitions for SolEnrich.
 *
 * Tools are declared as plain data (MCP_TOOLS) so the two transports can share
 * them without sharing allocation strategy:
 *  - stdio (mcp/server.ts): createSolEnrichMcpServer() builds a real McpServer once.
 *  - HTTP (src/lib/mcp-http.ts): a lightweight JSON-RPC dispatcher reads the
 *    registry directly and allocates NOTHING per request. This is the 2026-08-02
 *    OOM fix — the per-request McpServer graph (~1.5-2MB retained per crawler
 *    POST) was refilling Railway's 8GB every ~3 days even after the 2026-07-21
 *    teardown fix. See docs/oom-rootcause-2026-07-21.md.
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

export interface McpToolDef {
  name: string;
  title: string;
  description: string;
  /** Zod raw shape — z.object() it for validation, z.toJSONSchema() for tools/list. */
  inputSchema: z.ZodRawShape;
  /** Returns the briefing text. Transports wrap it into MCP content format. */
  handler: (args: any) => Promise<string>;
}

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'enrich_wallet',
    title: 'Enrich Wallet',
    description: 'Get a Solana wallet profile: SOL balance, token holdings, DeFi positions, labels (whale, active_trader, defi_user), risk score, and risk level.',
    inputSchema: {
      address: z.string().describe('Solana wallet address (base58, 32-44 chars)'),
      depth: z.enum(['light', 'full']).default('light').describe('light = basic profile, full = includes DeFi positions and connected wallets'),
    },
    handler: async (args) => {
      const key = args.depth === 'full' ? 'enrich-wallet-full' : 'enrich-wallet-light';
      return invoke(key, {
        address: args.address,
        depth: args.depth ?? 'light',
        format: 'llm',
      });
    },
  },
  {
    name: 'enrich_token',
    title: 'Enrich Token',
    description: 'Analyze a Solana SPL token: price, market cap, liquidity, holder concentration (top 1/5/10%), slippage estimates at 4 position sizes ($100/$1K/$10K/$100K), risk flags, and Jupiter verification.',
    inputSchema: {
      mint: z.string().describe('Token mint address (base58)'),
      include_holders: z.boolean().default(false).describe('Include top 20 holders with balances and % supply'),
    },
    handler: async (args) => {
      const key = args.include_holders ? 'enrich-token-full' : 'enrich-token-light';
      return invoke(key, {
        mint: args.mint,
        include_holders: args.include_holders ?? false,
        format: 'llm',
      });
    },
  },
  {
    name: 'parse_transaction',
    title: 'Parse Transaction',
    description: 'Parse a Solana transaction: type, protocol, SOL/token transfers, accounts involved, and fee details.',
    inputSchema: {
      signature: z.string().describe('Transaction signature (base58, 87-88 chars)'),
    },
    handler: async (args) => invoke('parse-transaction', {
      signature: args.signature,
      format: 'llm',
    }),
  },
  {
    name: 'whale_watch',
    title: 'Whale Watch',
    description: 'Track top token holders: balances, % supply, buy/sell volumes, accumulation vs distribution signals.',
    inputSchema: {
      mint: z.string().describe('Token mint address (base58)'),
      threshold_usd: z.number().default(10000).describe('Minimum USD value to qualify as whale activity'),
      lookback_hours: z.number().default(24).describe('How many hours to look back (1-168)'),
    },
    handler: async (args) => invoke('whale-watch', {
      mint: args.mint,
      threshold_usd: args.threshold_usd ?? 10000,
      lookback_hours: args.lookback_hours ?? 24,
      format: 'llm',
    }),
  },
  {
    name: 'due_diligence',
    title: 'Due Diligence',
    description: 'Comprehensive token research: security audit, holder concentration, whale activity, risk score with level (LOW-CRITICAL), and SAFE/CAUTION/RISKY verdict.',
    inputSchema: {
      mint: z.string().describe('Token mint address (base58)'),
    },
    handler: async (args) => invoke('due-diligence', {
      mint: args.mint,
      format: 'llm',
    }),
  },
  {
    name: 'wallet_graph',
    title: 'Wallet Graph',
    description: 'Map wallet connections: find counterparties, detect clusters of coordinated wallets, and identify suspicious patterns.',
    inputSchema: {
      address: z.string().describe('Solana wallet address (base58)'),
      depth: z.number().default(1).describe('Hop depth (1 or 2)'),
    },
    handler: async (args) => invoke('wallet-graph', {
      address: args.address,
      depth: args.depth ?? 1,
      min_interactions: 1,
      format: 'llm',
    }),
  },
  {
    name: 'copy_trade_signals',
    title: 'Copy Trade Signals',
    description: 'Analyze a wallet\'s trading performance: win rate, PnL, consistency, hold time, and smart_money classification.',
    inputSchema: {
      address: z.string().describe('Solana wallet address (base58)'),
      lookback_days: z.number().default(30).describe('Days to analyze (1-90)'),
    },
    handler: async (args) => invoke('copy-trade-signals', {
      address: args.address,
      lookback_days: args.lookback_days ?? 30,
      format: 'llm',
    }),
  },
  {
    name: 'batch_enrich',
    title: 'Batch Enrich',
    description: 'Enrich multiple wallets or tokens in a single call (1-25). Returns parallel results.',
    inputSchema: {
      addresses: z.array(z.string()).describe('Array of Solana addresses (1-25)'),
      type: z.enum(['wallet', 'token']).describe('Address type: wallet or token'),
      depth: z.enum(['light', 'full']).default('light').describe('Enrichment depth'),
    },
    handler: async (args) => invoke('batch-enrich', {
      addresses: args.addresses,
      type: args.type,
      depth: args.depth ?? 'light',
      format: 'llm',
    }),
  },
  {
    name: 'compare_tokens',
    title: 'Compare Tokens',
    description: 'Side-by-side comparison of 2-3 tokens: price, liquidity, volatility, holder concentration, risk. Rankings and summary picks.',
    inputSchema: {
      mints: z.array(z.string()).describe('2-3 token mint addresses to compare'),
    },
    handler: async (args) => invoke('compare-tokens', {
      mints: args.mints,
      format: 'llm',
    }),
  },
  {
    name: 'compare_wallets',
    title: 'Compare Wallets',
    description: 'Side-by-side comparison of 2-3 wallets: portfolio, activity, risk, labels. Rankings and summary picks.',
    inputSchema: {
      addresses: z.array(z.string()).describe('2-3 wallet addresses to compare'),
      depth: z.enum(['light', 'full']).default('light').describe('Enrichment depth'),
    },
    handler: async (args) => invoke('compare-wallets', {
      addresses: args.addresses,
      depth: args.depth ?? 'light',
      format: 'llm',
    }),
  },
  {
    name: 'token_trend',
    title: 'Token Trend',
    description: 'Token metrics over time: daily snapshots with direction indicators (improving/declining/stable) per metric.',
    inputSchema: {
      mint: z.string().describe('Token mint address (base58)'),
      lookback: z.enum(['7d', '14d', '30d']).default('7d').describe('Lookback period'),
    },
    handler: async (args) => invoke('token-trend', {
      mint: args.mint,
      lookback: args.lookback ?? '7d',
      format: 'llm',
    }),
  },
  {
    name: 'wallet_history',
    title: 'Wallet History',
    description: 'Wallet portfolio over time: snapshots with position changes (added/removed holdings) and direction indicators.',
    inputSchema: {
      address: z.string().describe('Solana wallet address (base58)'),
      lookback: z.enum(['7d', '14d', '30d']).default('7d').describe('Lookback period'),
    },
    handler: async (args) => invoke('wallet-history', {
      address: args.address,
      lookback: args.lookback ?? '7d',
      format: 'llm',
    }),
  },
  {
    name: 'portfolio_history',
    title: 'Portfolio History',
    description: 'Full portfolio time-series for a wallet: daily snapshots of value, balance, holdings, and risk score over 7/14/30 days, plus summary stats (peak, trough, max drawdown, average, change vs period start). For charting and PnL tracking.',
    inputSchema: {
      address: z.string().describe('Solana wallet address (base58)'),
      period: z.enum(['7d', '14d', '30d']).default('7d').describe('Lookback period'),
    },
    handler: async (args) => invoke('portfolio-history', {
      address: args.address,
      period: args.period ?? '7d',
      format: 'llm',
    }),
  },
  {
    name: 'new_tokens',
    title: 'New Tokens',
    description: 'Discover recently launched Solana tokens. Filters by liquidity and risk score, ranked safest first.',
    inputSchema: {
      min_liquidity_usd: z.number().default(1000).describe('Minimum liquidity in USD'),
      max_risk_score: z.number().default(0.8).describe('Maximum risk score (0-1)'),
      limit: z.number().default(10).describe('Number of tokens to return (1-20)'),
    },
    handler: async (args) => invoke('new-tokens', {
      min_liquidity_usd: args.min_liquidity_usd ?? 1000,
      max_risk_score: args.max_risk_score ?? 0.8,
      limit: args.limit ?? 10,
      format: 'llm',
    }),
  },
  {
    name: 'protocol_profile',
    title: 'Protocol Profile',
    description: 'DeFi protocol analytics: TVL, yield pools, on-chain activity, health signals. Supports Raydium, Orca, marginfi, Drift, Jupiter, Kamino, Marinade, Jito, and more.',
    inputSchema: {
      protocol: z.string().describe('Protocol slug (e.g. "raydium", "orca") or Solana program ID'),
      include_yields: z.boolean().default(true).describe('Include yield pool data'),
    },
    handler: async (args) => invoke('protocol-profile', {
      protocol: args.protocol,
      include_yields: args.include_yields ?? true,
      format: 'llm',
    }),
  },
  {
    name: 'query',
    title: 'Query',
    description: 'Ask a plain English question about any Solana wallet, token, or market. Single-intent routes to one enricher; compound intents chain 2-3 in parallel and return a unified briefing. Examples: "should I buy <mint>?" (DD + trend + whales), "wallet deep dive on <addr>" (profile + history + perps), "is <mint> safe?", "what\'s trending right now", "SOL-PERP funding rate".',
    inputSchema: {
      question: z.string().describe('Natural language question about a Solana wallet or token'),
    },
    handler: async (args) => invoke('query', {
      question: args.question,
      format: 'llm',
    }),
  },
  {
    name: 'perps_market_structure',
    title: 'Jupiter Perps Market Structure',
    description: 'Per-market OI, utilization, borrow APR, skew, OI caps, and health flags across Jupiter Perps SOL/BTC/ETH. Reads on-chain Anchor accounts directly.',
    inputSchema: {},
    handler: async () => invoke('perps-market-structure', { format: 'llm' }),
  },
  {
    name: 'perps_trader_profile',
    title: 'Multi-Venue Perps Trader Profile',
    description: 'Open positions across BOTH Jupiter Perps and Adrena for a wallet. Per-venue breakdown plus combined totals. Each position tagged with venue. Trader classification (scalper/swing/position), directional bias, multi-venue exposure flag, and risk flags (high leverage, approaching liquidation, concentrated market). Adrena PnL needs mark prices for jitoSOL/WBTC/BONK and is null when unavailable.',
    inputSchema: {
      address: z.string().describe('Solana wallet address'),
    },
    handler: async (args) => invoke('perps-trader-profile', {
      address: args.address,
      format: 'llm',
    }),
  },
  {
    name: 'hyperliquid_trader_profile',
    title: 'Hyperliquid Trader Profile',
    description: "Live Hyperliquid perp positions for an EVM (0x) address, read from HL's public on-chain state. Per-position side, leverage, notional, entry, unrealized PnL, distance-to-liquidation, and risk flags. Account value, directional bias, profile (directional/market-neutral/diversified), and realized+unrealized PnL over week/month/all-time. The building block for HL smart-money tracking.",
    inputSchema: {
      address: z.string().describe('Hyperliquid EVM (0x) address'),
    },
    handler: async (args) => invoke('hyperliquid-trader-profile', {
      address: args.address,
      format: 'llm',
    }),
  },
  {
    name: 'hyperliquid_smart_money',
    title: 'Hyperliquid Smart-Money Positioning',
    description: "Where Hyperliquid smart money is positioned. Filters the HL leaderboard to consistent directional traders (excludes market-makers + dust), then aggregates their live positions into a per-coin consensus (long/short counts, net notional, bias, conviction) plus a top-trader drill-down. Optionally focus one coin via `market`. A positioning signal, not a trade — use as confluence/risk context, not a standalone entry.",
    inputSchema: {
      market: z.string().optional().describe('Optional single-coin focus, e.g. HYPE/BTC/ETH'),
      top_traders: z.number().int().min(1).max(25).optional().describe('How many top traders to include (default 10)'),
    },
    handler: async (args) => invoke('hyperliquid-smart-money', {
      ...(args.market ? { market: args.market } : {}),
      ...(args.top_traders ? { top_traders: args.top_traders } : {}),
      format: 'llm',
    }),
  },
  {
    name: 'perps_basis_signal',
    title: 'Net-Yield-After-Borrow Basis Signal',
    description: 'Computes perp mark vs spot price across venues and surfaces actually-earnable yield. Funding-rate venues (HL, dYdX) generate real yield; pool perps (Jupiter, Adrena) flagged as not viable because they charge borrow on both sides. Returns per-venue trade + filtered opportunities + best trade.',
    inputSchema: {
      asset: z.enum(['SOL', 'BTC', 'ETH', 'BONK']).describe('Asset to scan'),
      min_yield_apr_pct: z.number().min(0).max(100).default(5).describe('Minimum net yield (APR %) for an opportunity to surface'),
    },
    handler: async (args) => invoke('perps-basis-signal', {
      asset: args.asset,
      min_yield_apr_pct: args.min_yield_apr_pct ?? 5,
      format: 'llm',
    }),
  },
  {
    name: 'perps_market_trend',
    title: 'Jupiter Perps Market Trend',
    description: 'Per-symbol (SOL/BTC/ETH) deltas for mark price, total open interest, long/short skew, utilization, and borrow APR over 7/14/30 days. Direction indicators per metric and per market. Overall direction excludes mark price. Use for regime detection — bots that adjust behavior based on whether markets are growing, stressed, or rebalancing.',
    inputSchema: {
      lookback: z.enum(['7d', '14d', '30d']).default('7d').describe('History window'),
    },
    handler: async (args) => invoke('perps-market-trend', {
      lookback: args.lookback ?? '7d',
      format: 'llm',
    }),
  },
  {
    name: 'perps_venue_comparison',
    title: 'Cross-Venue Perps Comparison',
    description: 'Where to trade this market at this size. Builds on cross-venue funding with spot slippage, per-venue fee, OI cap headroom, and total entry cost. Returns rankings + recommendation with warnings.',
    inputSchema: {
      market: z.enum(['SOL', 'BTC', 'ETH', 'BONK']).describe('Asset to query'),
      size_usd: z.number().min(100).max(10_000_000).describe('Position size in USD'),
      side: z.enum(['long', 'short']).default('long').describe('Side being sized'),
    },
    handler: async (args) => invoke('perps-venue-comparison', {
      market: args.market,
      size_usd: args.size_usd,
      side: args.side ?? 'long',
      format: 'llm',
    }),
  },
  {
    name: 'perps_cross_venue_funding',
    title: 'Cross-Venue Perps Funding',
    description: 'Compare borrow/funding APR + OI across Solana on-chain venues (Jupiter Perps, Adrena) and cross-chain reference (Hyperliquid, dYdX v4). Returns best entry per side, basis vs Hyperliquid, and arbitrage opportunities. SOL/BTC/ETH/BONK supported (with venue-specific availability).',
    inputSchema: {
      market: z.enum(['SOL', 'BTC', 'ETH', 'BONK']).describe('Asset to query'),
      include_reference: z.boolean().default(true).describe('Include Hyperliquid + dYdX v4 reference rates'),
    },
    handler: async (args) => invoke('perps-cross-venue-funding', {
      market: args.market,
      include_reference: args.include_reference ?? true,
      format: 'llm',
    }),
  },
  {
    name: 'trending_signals',
    title: 'Trending Signals',
    description: 'Ranked list of Solana tokens worth paying attention to right now. Composes DexScreener trending + risk scoring + whale-flow into a composite signal with reasoning.',
    inputSchema: {
      min_liquidity_usd: z.number().default(10_000).describe('Minimum liquidity in USD'),
      max_risk_score: z.number().min(0).max(1).default(0.7).describe('Maximum risk score (0-1)'),
      limit: z.number().int().min(1).max(20).default(10).describe('Number of tokens to return'),
      include_whale_watch: z.boolean().default(true).describe('Include whale flow signal'),
    },
    handler: async (args) => invoke('trending-signals', {
      min_liquidity_usd: args.min_liquidity_usd ?? 10_000,
      max_risk_score: args.max_risk_score ?? 0.7,
      limit: args.limit ?? 10,
      include_whale_watch: args.include_whale_watch ?? true,
      format: 'llm',
    }),
  },
  {
    name: 'smart_money_flow',
    title: 'Smart Money Flow',
    description: 'Where high-performing Solana wallets are moving. Scores seed wallets by copy-trade metrics, surfaces tokens they\'re accumulating, and maps wallet clusters.',
    inputSchema: {
      wallets: z.array(z.string()).max(30).optional().describe('Optional wallet addresses to score (curated default used if omitted)'),
      lookback_days: z.number().int().min(1).max(90).default(14).describe('Copy-trade lookback window'),
      min_win_rate: z.number().min(0).max(1).default(0.55).describe('Minimum win rate to qualify'),
      top_n_tokens: z.number().int().min(1).max(20).default(10).describe('Max accumulated tokens to surface'),
      include_graph: z.boolean().default(true).describe('Include wallet cluster analysis'),
    },
    handler: async (args) => invoke('smart-money-flow', {
      wallets: args.wallets,
      lookback_days: args.lookback_days ?? 14,
      min_win_rate: args.min_win_rate ?? 0.55,
      top_n_tokens: args.top_n_tokens ?? 10,
      include_graph: args.include_graph ?? true,
      format: 'llm',
    }),
  },
  {
    name: 'smart_money_trenches',
    title: 'Smart Money in the Trenches',
    description: 'Which proven-winner wallets are aping fresh (<6h) memecoin launches right now, and what are they buying? Vetted realized-PnL winner seed set (bot-filtered), recent buys overlaid against token launch times, ranked by distinct smart buyers + recency. Pre-ape attention signal.',
    inputSchema: {
      hours_back: z.number().int().min(1).max(48).default(12).describe('How far back to scan seed-wallet buys (hours)'),
      max_token_age_hours: z.number().min(1).max(72).default(6).describe('Max token age in hours to count as fresh'),
      min_buyers: z.number().int().min(1).max(14).default(1).describe('Min distinct smart buyers per token'),
      limit: z.number().int().min(1).max(25).default(10).describe('Max tokens to return'),
    },
    handler: async (args) => invoke('smart-money-trenches', {
      hours_back: args.hours_back ?? 12,
      max_token_age_hours: args.max_token_age_hours ?? 6,
      min_buyers: args.min_buyers ?? 1,
      limit: args.limit ?? 10,
      format: 'llm',
    }),
  },
  {
    name: 'runner_scan',
    title: 'Runner Scan (on-chain velocity)',
    description: 'Which fresh Solana memecoins are ACCELERATING right now? Measures buy-rate acceleration (5m vs 1h, 1h vs 6h), buy pressure, volume/price velocity, holder growth and liquidity trend, then classifies each token RUNNING / IGNITING / PARABOLIC_LATE / FADING with a 0-1 score and reasoning. Flags already-ran tokens as entry risk and liquidity pulls as rugs.',
    inputSchema: {
      max_token_age_hours: z.number().min(0.1).max(168).default(24).describe('Max token age in hours since first pair'),
      min_liquidity_usd: z.number().min(0).max(10_000_000).default(10_000).describe('Minimum pool liquidity in USD'),
      min_volume_h1_usd: z.number().min(0).max(10_000_000).default(5_000).describe('Minimum 1h volume in USD'),
      limit: z.number().int().min(1).max(25).default(15).describe('Max tokens to return'),
    },
    handler: async (args) => invoke('runner-scan', {
      max_token_age_hours: args.max_token_age_hours ?? 24,
      min_liquidity_usd: args.min_liquidity_usd ?? 10_000,
      min_volume_h1_usd: args.min_volume_h1_usd ?? 5_000,
      limit: args.limit ?? 15,
      format: 'llm',
    }),
  },
  {
    name: 'feed_latest',
    title: 'SolEnrich Daily Brief',
    description: 'Daily intelligence brief — pre-computed ranking of trending Solana tokens with composite-signal scoring. Cached 24h, lazy-populated on cache miss. Pass `since` (ISO 8601) to short-circuit on no-change polls.',
    inputSchema: {
      since: z.string().optional().describe('Optional ISO 8601 timestamp of last successful poll. If brief is not newer, response sets unchanged=true with empty payload.'),
    },
    handler: async (args) => invoke('feed-latest', {
      ...(args.since ? { since: args.since } : {}),
      format: 'llm',
    }),
  },
  {
    name: 'check_alerts',
    title: 'Check Alerts',
    description: 'Poll-based event detection covering spot + Jupiter Perps. Pass a watchlist (token mints + wallet addresses) and a since timestamp; receive alerts graded by severity. Spot alerts: price spike/drop, risk change, whale flow, concentration shift, portfolio value change, position add/remove. Jupiter Perps alerts per wallet: position opened, position closed, at-risk (high leverage or underwater), liquidation approaching, PnL swing. Stateless — caller owns the cursor.',
    inputSchema: {
      tokens: z.array(z.string()).max(10).default([]).describe('Token mints to watch (max 10)'),
      wallets: z.array(z.string()).max(10).default([]).describe('Wallet addresses to watch — spot + Jupiter Perps (max 10)'),
      since: z.string().describe('ISO 8601 timestamp — return alerts fired since this moment'),
    },
    handler: async (args) => invoke('check-alerts', {
      tokens: args.tokens ?? [],
      wallets: args.wallets ?? [],
      since: args.since,
      format: 'llm',
    }),
  },
  {
    name: 'consensus_signal',
    title: 'Agent Attention Signal',
    description: 'What tokens or wallets are being queried by other agents right now. Proprietary data derived from SolEnrich\'s own query stream. Pass `address` for that entity\'s rank/percentile/trend; omit it for top-N. Windows: 1h, 6h, 24h.',
    inputSchema: {
      type: z.enum(['token', 'wallet']).default('token').describe('Entity type to query'),
      address: z.string().optional().describe('Optional Solana address — single-entity report when provided'),
      window: z.enum(['1h', '6h', '24h']).default('1h').describe('Lookback window'),
      limit: z.number().int().min(1).max(50).default(10).describe('Top-N size when address is omitted'),
    },
    handler: async (args) => invoke('consensus-signal', {
      type: args.type ?? 'token',
      ...(args.address ? { address: args.address } : {}),
      window: args.window ?? '1h',
      limit: args.limit ?? 10,
      format: 'llm',
    }),
  },
  {
    name: 'trenches_scan',
    title: 'Trenches Scan (Three-Signal Confluence)',
    description: 'The full memecoin pre-ape scan in one call: on-chain velocity (runner detection), proven-winner wallet buys (smart-money), and agent attention, composited into a ranked list with per-token reasoning and HIGH_CONFLUENCE / MODERATE / SINGLE_SIGNAL verdicts. Confluence across independent signals is the edge. NFA.',
    inputSchema: {
      max_token_age_hours: z.number().min(1).max(72).optional().describe('Max token age in hours (default 24)'),
      min_liquidity_usd: z.number().min(0).optional().describe('Liquidity floor in USD (default 5000)'),
      limit: z.number().int().min(1).max(20).optional().describe('Max picks returned (default 10)'),
    },
    handler: async (args) => invoke('trenches-scan', {
      ...(args.max_token_age_hours != null ? { max_token_age_hours: args.max_token_age_hours } : {}),
      ...(args.min_liquidity_usd != null ? { min_liquidity_usd: args.min_liquidity_usd } : {}),
      ...(args.limit != null ? { limit: args.limit } : {}),
      format: 'llm',
    }),
  },
  {
    name: 'attention_momentum',
    title: 'Agent Attention Momentum',
    description: 'Tokens ranked by ACCELERATION of agent attention (query velocity change across three consecutive windows), overlaid with price change over the same window. Divergence classes: early_signal (attention up, price flat — agents researching before the market moves), confirmed_momentum, distribution_risk (attention cooling while price pumps), fading. Proprietary — derived from SolEnrich\'s own query stream. Windows: 1h, 6h, 24h.',
    inputSchema: {
      window: z.enum(['1h', '6h', '24h']).default('6h').describe('Window size — acceleration compares three consecutive windows of this size'),
      limit: z.number().int().min(1).max(25).default(10).describe('Max ranked entries'),
    },
    handler: async (args) => invoke('attention-momentum', {
      window: args.window ?? '6h',
      limit: args.limit ?? 10,
      format: 'llm',
    }),
  },
  {
    name: 'gacha_ev_scan',
    title: 'Jupiter Gacha EV Scan',
    description: 'Scan Jupiter Gacha (Collector Crypt) tokenized-card packs for net-of-exit expected value. Per machine: gross insured EV vs the guaranteed instant-buyback floor (85-93% of insured value, ≤72h) vs a marketplace sale (insured value minus 2% fee, fill-risk). Returns a POSITIVE_EV / HOUSE_EDGE / NEGATIVE_EV verdict — the realizable EV the platform hides behind its gross-EV headline. NFA.',
    inputSchema: {
      machine: z.string().optional().describe('Restrict to one machine code (e.g. pokemon_50); omit to scan all'),
      franchise: z.enum(['pokemon', 'onepiece', 'all']).default('all').describe('Franchise filter'),
      exit_strategy: z.enum(['buyback', 'marketplace', 'both']).default('both').describe('Which exit path to rank/verdict against'),
      min_edge_pct: z.number().min(-100).max(100).optional().describe('Only surface machines with net edge ≥ this %'),
    },
    handler: async (args) => invoke('gacha-ev-scan', {
      ...(args.machine ? { machine: args.machine } : {}),
      franchise: args.franchise ?? 'all',
      exit_strategy: args.exit_strategy ?? 'both',
      ...(args.min_edge_pct !== undefined ? { min_edge_pct: args.min_edge_pct } : {}),
      format: 'llm',
    }),
  },
];

export function createSolEnrichMcpServer(): McpServer {
  const server = new McpServer({
    name: 'SolEnrich',
    version: '1.0.0',
  });

  for (const tool of MCP_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args: any) => ({
        content: [{ type: 'text' as const, text: await tool.handler(args) }],
      }),
    );
  }

  return server;
}
