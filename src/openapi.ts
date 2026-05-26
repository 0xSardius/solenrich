// OpenAPI 3.1.0 discovery document for MPP/AgentCash
// Serves at GET /openapi.json — machine-readable payment terms + input schemas
// Reference: https://mpp.dev/advanced/discovery

import { PRICING, CONFIG } from './config';

// Agent wallet that receives payments
const RECIPIENT = CONFIG.solana.walletAddress;

// When MPP is enabled, all endpoints accept Stripe. Otherwise all use x402.

/** Endpoint metadata: description, summary, input schema */
export const ENDPOINT_META: Record<string, {
  summary: string;
  description: string;
  schema: Record<string, unknown>;
}> = {
  'enrich-wallet-light': {
    summary: 'Light wallet profile',
    description: 'SOL balance, token holdings, labels (including behavioral flags: regular_intervals, high_frequency, 24_7_active, repetitive_actions — algorithmic signals from tx timing that indicate automated activity), risk score. Fast and cheap.',
    schema: {
      type: 'object',
      required: ['address'],
      properties: {
        address: { type: 'string', description: 'Solana base58 wallet address', minLength: 32, maxLength: 44 },
        format: { type: 'string', enum: ['json', 'llm', 'both'], default: 'json' },
      },
    },
  },
  'enrich-wallet-full': {
    summary: 'Full wallet profile',
    description: 'Adds DeFi positions, connected wallets, enhanced transaction history, and automated-activity behavioral signals to light profile.',
    schema: {
      type: 'object',
      required: ['address'],
      properties: {
        address: { type: 'string', description: 'Solana base58 wallet address', minLength: 32, maxLength: 44 },
        depth: { type: 'string', enum: ['light', 'full'], default: 'full' },
        format: { type: 'string', enum: ['json', 'llm', 'both'], default: 'json' },
      },
    },
  },
  'enrich-token-light': {
    summary: 'Light token analysis',
    description: 'Price (median of 3 sources), market cap, volume, liquidity, slippage estimates at 4 position sizes, risk flags, verification status.',
    schema: {
      type: 'object',
      required: ['mint'],
      properties: {
        mint: { type: 'string', description: 'Solana token mint address', minLength: 32, maxLength: 44 },
        format: { type: 'string', enum: ['json', 'llm', 'both'], default: 'json' },
      },
    },
  },
  'enrich-token-full': {
    summary: 'Full token analysis',
    description: 'Adds top 20 holders, HHI concentration index, volatility metrics, slippage estimates to light token analysis.',
    schema: {
      type: 'object',
      required: ['mint'],
      properties: {
        mint: { type: 'string', description: 'Solana token mint address', minLength: 32, maxLength: 44 },
        include_holders: { type: 'boolean', default: true, description: 'Include top 20 holder breakdown' },
        format: { type: 'string', enum: ['json', 'llm', 'both'], default: 'json' },
      },
    },
  },
  'parse-transaction': {
    summary: 'Parse a Solana transaction',
    description: 'Type detection, protocol identification, transfer breakdown, account roles.',
    schema: {
      type: 'object',
      required: ['signature'],
      properties: {
        signature: { type: 'string', description: 'Solana transaction signature (base58)', minLength: 86, maxLength: 90 },
        format: { type: 'string', enum: ['json', 'llm', 'both'], default: 'json' },
      },
    },
  },
  'whale-watch': {
    summary: 'Whale activity tracker',
    description: 'Top holders with accumulation/distribution tracking, balance context, supply percentage.',
    schema: {
      type: 'object',
      required: ['mint'],
      properties: {
        mint: { type: 'string', description: 'Solana token mint address', minLength: 32, maxLength: 44 },
        threshold_usd: { type: 'number', minimum: 100, default: 10000, description: 'Minimum USD value to qualify as whale' },
        lookback_hours: { type: 'number', minimum: 1, maximum: 168, default: 24, description: 'Hours of history to analyze' },
        format: { type: 'string', enum: ['json', 'llm', 'both'], default: 'json' },
      },
    },
  },
  'batch-enrich': {
    summary: 'Batch enrichment',
    description: 'Parallel enrichment of 1-25 wallets or tokens in a single call.',
    schema: {
      type: 'object',
      required: ['addresses', 'type'],
      properties: {
        addresses: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 25, description: 'Solana addresses to enrich' },
        type: { type: 'string', enum: ['wallet', 'token'], description: 'Address type' },
        depth: { type: 'string', enum: ['light', 'full'], default: 'light' },
        format: { type: 'string', enum: ['json', 'llm', 'both'], default: 'json' },
      },
    },
  },
  'wallet-graph': {
    summary: 'Wallet connection graph',
    description: 'Transaction connection mapping, suspicious cluster detection, depth-1 or depth-2 hops.',
    schema: {
      type: 'object',
      required: ['address'],
      properties: {
        address: { type: 'string', description: 'Solana base58 wallet address', minLength: 32, maxLength: 44 },
        depth: { type: 'number', minimum: 1, maximum: 2, default: 1, description: 'Hop depth (1 or 2)' },
        min_interactions: { type: 'number', minimum: 1, default: 1, description: 'Minimum interactions to include connection' },
        format: { type: 'string', enum: ['json', 'llm', 'both'], default: 'json' },
      },
    },
  },
  'copy-trade-signals': {
    summary: 'Copy-trade analysis',
    description: 'Trading PnL, win rate, Sharpe/Sortino ratios, max drawdown, profit factor.',
    schema: {
      type: 'object',
      required: ['address'],
      properties: {
        address: { type: 'string', description: 'Solana base58 wallet address', minLength: 32, maxLength: 44 },
        lookback_days: { type: 'number', minimum: 1, maximum: 90, default: 30, description: 'Days of trading history' },
        format: { type: 'string', enum: ['json', 'llm', 'both'], default: 'json' },
      },
    },
  },
  'due-diligence': {
    summary: 'Token due diligence report',
    description: 'Composite risk: token analysis + whale activity + holder concentration. Returns SAFE/CAUTION/RISKY verdict.',
    schema: {
      type: 'object',
      required: ['mint'],
      properties: {
        mint: { type: 'string', description: 'Solana token mint address', minLength: 32, maxLength: 44 },
        format: { type: 'string', enum: ['json', 'llm', 'both'], default: 'json' },
      },
    },
  },
  'query': {
    summary: 'Natural language query',
    description: 'Plain English questions routed to the right enricher(s). Single-intent ("is X safe?") hits one enricher; compound intents chain 2-3 in parallel: "should I buy X?" → DD + trend + whales; "wallet deep dive" → profile + history + perps; "what\'s trending?" → trending-signals; "SOL-PERP funding rate" → perps-market.',
    schema: {
      type: 'object',
      required: ['question'],
      properties: {
        question: { type: 'string', minLength: 3, maxLength: 500, description: 'Natural language question about a Solana wallet or token' },
        format: { type: 'string', enum: ['json', 'llm', 'both'], default: 'json' },
      },
    },
  },
  'compare-tokens': {
    summary: 'Side-by-side token comparison',
    description: 'Compare 2-3 tokens: price, liquidity, volatility, HHI, risk. Rankings + summary picks.',
    schema: {
      type: 'object',
      required: ['mints'],
      properties: {
        mints: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 3, description: 'Token mint addresses to compare' },
        format: { type: 'string', enum: ['json', 'llm', 'both'], default: 'json' },
      },
    },
  },
  'compare-wallets': {
    summary: 'Side-by-side wallet comparison',
    description: 'Compare 2-3 wallets: portfolio, activity, risk, labels. Rankings + summary picks.',
    schema: {
      type: 'object',
      required: ['addresses'],
      properties: {
        addresses: { type: 'array', items: { type: 'string' }, minItems: 2, maxItems: 3, description: 'Wallet addresses to compare' },
        depth: { type: 'string', enum: ['light', 'full'], default: 'light' },
        format: { type: 'string', enum: ['json', 'llm', 'both'], default: 'json' },
      },
    },
  },
  'token-trend': {
    summary: 'Token trend over time',
    description: 'Daily snapshots with direction indicators (improving/declining/stable) per metric.',
    schema: {
      type: 'object',
      required: ['mint'],
      properties: {
        mint: { type: 'string', description: 'Solana token mint address', minLength: 32, maxLength: 44 },
        lookback: { type: 'string', enum: ['7d', '14d', '30d'], default: '7d' },
        format: { type: 'string', enum: ['json', 'llm', 'both'], default: 'json' },
      },
    },
  },
  'wallet-history': {
    summary: 'Wallet history over time',
    description: 'Portfolio snapshots with position changes (added/removed holdings), direction indicators.',
    schema: {
      type: 'object',
      required: ['address'],
      properties: {
        address: { type: 'string', description: 'Solana base58 wallet address', minLength: 32, maxLength: 44 },
        lookback: { type: 'string', enum: ['7d', '14d', '30d'], default: '7d' },
        format: { type: 'string', enum: ['json', 'llm', 'both'], default: 'json' },
      },
    },
  },
  'portfolio-history': {
    summary: 'Full portfolio time-series',
    description: 'Daily portfolio snapshots (value, SOL balance, token count, risk score) for a wallet over 7/14/30 days, plus summary stats: peak, trough, max drawdown, average value, change vs period start. Designed for charting and PnL tracking; complements wallet-history which returns two-point deltas. Today\'s live point is appended automatically.',
    schema: {
      type: 'object',
      required: ['address'],
      properties: {
        address: { type: 'string', description: 'Solana base58 wallet address', minLength: 32, maxLength: 44 },
        period: { type: 'string', enum: ['7d', '14d', '30d'], default: '7d' },
        format: { type: 'string', enum: ['json', 'llm', 'both'], default: 'json' },
      },
    },
  },
  'new-tokens': {
    summary: 'Discover new Solana tokens',
    description: 'Recently launched tokens from DexScreener, filtered by liquidity and risk, ranked safest first.',
    schema: {
      type: 'object',
      properties: {
        min_liquidity_usd: { type: 'number', default: 1000, description: 'Minimum liquidity in USD' },
        max_risk_score: { type: 'number', minimum: 0, maximum: 1, default: 0.8, description: 'Maximum risk score (0-1)' },
        limit: { type: 'number', minimum: 1, maximum: 20, default: 10, description: 'Number of tokens to return' },
        format: { type: 'string', enum: ['json', 'llm', 'both'], default: 'json' },
      },
    },
  },
  'protocol-profile': {
    summary: 'DeFi protocol analytics',
    description: 'Protocol TVL, yield pools, on-chain activity metrics, health signals, and automated_activity_pct (% of top signers with regular-interval or high-frequency tx patterns — surfaces agent-driven protocol usage). Supports Raydium, Orca, marginfi, Drift, Jupiter, Kamino, Marinade, Jito, and more.',
    schema: {
      type: 'object',
      required: ['protocol'],
      properties: {
        protocol: { type: 'string', description: 'Protocol slug (e.g. "raydium", "orca") or Solana program ID', minLength: 1, maxLength: 64 },
        include_yields: { type: 'boolean', default: true, description: 'Include yield pool data' },
        format: { type: 'string', enum: ['json', 'llm', 'both'], default: 'json' },
      },
    },
  },
  'perps-market-structure': {
    summary: 'Jupiter Perps market structure',
    description: 'Per-market open interest, utilization, borrow APR, skew, OI caps, and health flags across Jupiter Perps SOL/BTC/ETH markets. Reads on-chain Anchor accounts directly.',
    schema: {
      type: 'object',
      properties: {
        format: { type: 'string', enum: ['json', 'llm', 'both'], default: 'json' },
      },
    },
  },
  'perps-trader-profile': {
    summary: 'Jupiter Perps trader profile',
    description: 'Open Jupiter Perps positions for a wallet with size, leverage, entry price, unrealized PnL, position age, trader classification (scalper/swing/position), and risk flags.',
    schema: {
      type: 'object',
      required: ['address'],
      properties: {
        address: { type: 'string', description: 'Solana wallet address', minLength: 32, maxLength: 44 },
        format: { type: 'string', enum: ['json', 'llm', 'both'], default: 'json' },
      },
    },
  },
  'perps-basis-signal': {
    summary: 'Net-yield-after-borrow basis trade scanner',
    description: 'Computes perp mark vs spot price across venues and surfaces actually-earnable yield (funding APR on Hyperliquid + dYdX, not viable on pool perps Jupiter + Adrena). Returns per-venue trade economics, opportunities above threshold, and best trade. Threshold defaults to 5% APR.',
    schema: {
      type: 'object',
      required: ['asset'],
      properties: {
        asset: { type: 'string', enum: ['SOL', 'BTC', 'ETH', 'BONK'], description: 'Asset to scan' },
        min_yield_apr_pct: { type: 'number', minimum: 0, maximum: 100, default: 5, description: 'Minimum net yield (APR %) for an opportunity to be surfaced' },
        format: { type: 'string', enum: ['json', 'llm', 'both'], default: 'json' },
      },
    },
  },
  'perps-market-trend': {
    summary: 'Jupiter Perps market trend (SOL/BTC/ETH)',
    description: 'Per-symbol deltas for mark price, total OI, long/short skew, utilization, and borrow APR over 7/14/30 days. Direction indicators per metric and per market. Overall direction excludes mark price (price moves are not health signals). Required for regime-detection strategies and any bot that adjusts behavior based on whether markets are growing, stressed, or rebalancing. Mirror of token-trend for perps.',
    schema: {
      type: 'object',
      properties: {
        lookback: { type: 'string', enum: ['7d', '14d', '30d'], default: '7d', description: 'History window to compare current state against' },
        format: { type: 'string', enum: ['json', 'llm', 'both'], default: 'json' },
      },
    },
  },
  'perps-venue-comparison': {
    summary: 'Cross-venue perps comparison at a given size',
    description: 'Builds on cross-venue funding with size-aware fields: Jupiter Quote spot slippage at requested size, per-venue fee, OI cap headroom, first-hour borrow cost, and total entry cost. Returns rankings by entry cost / borrow APR / headroom plus a recommendation venue with warnings. Use when sizing a real position; use perps-cross-venue-funding for rates-only context.',
    schema: {
      type: 'object',
      required: ['market', 'size_usd'],
      properties: {
        market: { type: 'string', enum: ['SOL', 'BTC', 'ETH', 'BONK'], description: 'Asset to query' },
        size_usd: { type: 'number', minimum: 100, maximum: 10_000_000, description: 'Position size in USD' },
        side: { type: 'string', enum: ['long', 'short'], default: 'long', description: 'Side being sized' },
        format: { type: 'string', enum: ['json', 'llm', 'both'], default: 'json' },
      },
    },
  },
  'perps-cross-venue-funding': {
    summary: 'Cross-venue perps funding aggregator',
    description: 'Aggregates borrow/funding APR + open interest across Solana on-chain venues (Jupiter Perps, Adrena) and cross-chain reference venues (Hyperliquid, dYdX v4). Returns per-venue quotes, best entry per side, basis vs Hyperliquid, and arbitrage opportunities. Adrena routes SOL through jitoSOL and BTC through WBTC (wrapped collateral). ETH not supported on Adrena. BONK not tradable on Jupiter Perps. Foundation endpoint — new venues fold in additively as they go live (Phoenix Perps, Bullet).',
    schema: {
      type: 'object',
      required: ['market'],
      properties: {
        market: { type: 'string', enum: ['SOL', 'BTC', 'ETH', 'BONK'], description: 'Asset to query' },
        include_reference: { type: 'boolean', default: true, description: 'Include Hyperliquid + dYdX v4 reference rates' },
        format: { type: 'string', enum: ['json', 'llm', 'both'], default: 'json' },
      },
    },
  },
  'trending-signals': {
    summary: 'Orchestrated trending-token intelligence',
    description: 'Composes token-discovery + whale-watch + risk scoring across DexScreener trending. Returns a composite-signal ranked list (liquidity, risk, concentration, whale flow) with per-token reasoning and overall sentiment (accumulation/distribution/mixed). "What\'s worth paying attention to right now?"',
    schema: {
      type: 'object',
      properties: {
        min_liquidity_usd: { type: 'number', default: 10000, description: 'Minimum liquidity in USD for candidates' },
        max_risk_score: { type: 'number', minimum: 0, maximum: 1, default: 0.7, description: 'Maximum token risk score (0-1)' },
        limit: { type: 'number', minimum: 1, maximum: 20, default: 10, description: 'Number of tokens to return' },
        include_whale_watch: { type: 'boolean', default: true, description: 'Layer whale-watch flow signal per token (slower but higher signal)' },
        format: { type: 'string', enum: ['json', 'llm', 'both'], default: 'json' },
      },
    },
  },
  'smart-money-flow': {
    summary: 'Orchestrated smart-money intelligence',
    description: 'Scores seed wallets via copy-trade metrics (win rate, Sharpe, consistency), filters to qualifying winners, then surfaces tokens they\'re accumulating and wallet clusters. Pass your own `wallets` array or use the curated default seed list.',
    schema: {
      type: 'object',
      properties: {
        wallets: { type: 'array', items: { type: 'string', minLength: 32, maxLength: 44 }, maxItems: 30, description: 'Optional Solana wallet addresses to score (uses curated default if omitted)' },
        lookback_days: { type: 'number', minimum: 1, maximum: 90, default: 14, description: 'Copy-trade lookback window in days' },
        min_win_rate: { type: 'number', minimum: 0, maximum: 1, default: 0.55, description: 'Minimum win rate to qualify as smart money (0-1)' },
        top_n_tokens: { type: 'number', minimum: 1, maximum: 20, default: 10, description: 'Max tokens to surface as accumulated' },
        include_graph: { type: 'boolean', default: true, description: 'Include cluster analysis via wallet-graph (adds latency)' },
        format: { type: 'string', enum: ['json', 'llm', 'both'], default: 'json' },
      },
    },
  },
  'feed-latest': {
    summary: 'Daily SolEnrich intelligence brief',
    description: 'Pre-computed ranking of trending Solana tokens with composite-signal scoring. Cached 24h, lazy-populated on cache miss. Designed for recurring polling at lower per-call cost than direct orchestration. Pass `since` (ISO 8601) to short-circuit on no-change polls.',
    schema: {
      type: 'object',
      properties: {
        since: { type: 'string', format: 'date-time', description: 'Optional ISO 8601 timestamp of last successful poll. If brief is not newer, response sets unchanged=true with empty payload.' },
        format: { type: 'string', enum: ['json', 'llm', 'both'], default: 'json' },
      },
    },
  },
  'consensus-signal': {
    summary: 'Agent attention signal (proprietary)',
    description: 'What tokens or wallets are being queried by other agents right now. Derived from SolEnrich\'s own query stream — not market volume. Two modes: pass `address` for that entity\'s rank/percentile/trend; omit it for the top-N most-queried entities in the window. Windows: 1h, 6h, 24h. Unique data — only available because we serve agents directly.',
    schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['token', 'wallet'], default: 'token' },
        address: { type: 'string', description: 'Optional Solana address — single-entity report when provided', minLength: 32, maxLength: 44 },
        window: { type: 'string', enum: ['1h', '6h', '24h'], default: '1h' },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 10, description: 'Top-N size when address is omitted' },
        format: { type: 'string', enum: ['json', 'llm', 'both'], default: 'json' },
      },
    },
  },
  'check-alerts': {
    summary: 'Poll-based event detection (spot + Jupiter Perps)',
    description: 'Pass a watchlist (tokens + wallets, max 10 of each) and a `since` ISO 8601 timestamp; receive alerts fired since that time. Token alerts: price_spike, price_drop, whale_inflow, whale_outflow, concentration_shift. Spot wallet alerts: risk_increase, risk_decrease, portfolio_value_change, new_positions, removed_positions. Jupiter Perps alerts per wallet: perp_position_added, perp_position_closed, perp_at_risk, liquidation_approaching, pnl_swing — critical for perps trading bots that need real-time position state. Stateless — the agent owns the cursor. Step 1 of an alerts trio (poll → SSE → webhooks).',
    schema: {
      type: 'object',
      required: ['since'],
      properties: {
        tokens: { type: 'array', items: { type: 'string', minLength: 32, maxLength: 44 }, maxItems: 10, description: 'Token mints to monitor' },
        wallets: { type: 'array', items: { type: 'string', minLength: 32, maxLength: 44 }, maxItems: 10, description: 'Wallet addresses to monitor (spot + Jupiter Perps)' },
        since: { type: 'string', format: 'date-time', description: 'ISO 8601 timestamp — return alerts fired since this moment' },
        criteria: {
          type: 'object',
          description: 'Optional alert thresholds',
          properties: {
            min_price_change_pct: { type: 'number', minimum: 0, description: 'Default 10 — fire on token price moves ≥ this percentage' },
            min_risk_score_delta: { type: 'number', minimum: 0, maximum: 1, description: 'Default 0.15 — fire on risk score deltas ≥ this magnitude' },
            min_whale_volume_usd: { type: 'number', minimum: 0, description: 'Default 50000 — fire on whale net flow ≥ this USD value' },
            min_portfolio_change_pct: { type: 'number', minimum: 0, description: 'Default 20 — fire on wallet portfolio moves ≥ this percentage' },
            min_concentration_shift_pct: { type: 'number', minimum: 0, description: 'Default 5 — fire on top-1 holder concentration shifts ≥ this magnitude' },
            perp_max_leverage: { type: 'number', minimum: 1, maximum: 100, description: 'Default 10 — fire perp_at_risk when position leverage ≥ this' },
            perp_min_pnl_swing_pts: { type: 'number', minimum: 0, description: 'Default 25 — fire pnl_swing when unrealized PnL%% moves by this many points since prior snapshot' },
            perp_liquidation_buffer_pct: { type: 'number', minimum: 0, maximum: 100, description: 'Default 15 — fire liquidation_approaching when collateral buffer (100%% + PnL%%) drops below this' },
          },
        },
        format: { type: 'string', enum: ['json', 'llm', 'both'], default: 'json' },
      },
    },
  },
};

const BASE_URL = 'https://api.solenrich.com';

/**
 * Generate the full OpenAPI 3.1.0 discovery document.
 * Includes x-payment-info per the MPP discovery spec and x-service-info for registries.
 */
export function generateOpenApiDoc(mppEnabled: boolean): Record<string, unknown> {
  const paths: Record<string, unknown> = {};

  for (const [key, price] of Object.entries(PRICING)) {
    const meta = ENDPOINT_META[key];
    if (!meta) continue;

    // Price in decimal USD (e.g. "0.002000" for $0.002)
    const priceDecimal = parseFloat(price).toFixed(6);

    // MPPScan x-payment-info format: price object + protocols array
    const protocols: Record<string, unknown>[] = [
      { x402: { network: 'solana', recipient: RECIPIENT } },
    ];
    if (mppEnabled) {
      protocols.push({ mpp: { method: 'stripe', intent: 'charge', currency: 'usd', recipient: RECIPIENT } });
    }

    paths[`/entrypoints/${key}/invoke`] = {
      post: {
        operationId: key,
        summary: meta.summary,
        description: meta.description,
        'x-payment-info': {
          price: {
            mode: 'fixed',
            currency: 'USD',
            amount: priceDecimal,
          },
          protocols,
        },
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: meta.schema,
            },
          },
        },
        responses: {
          '200': {
            description: 'Enrichment result. Shape depends on `format` parameter.',
            content: {
              'application/json': {
                schema: { type: 'object' },
              },
            },
          },
          '402': {
            description: 'Payment Required. Returns payment instructions.',
          },
        },
      },
    };
  }

  // Free endpoints omitted from OpenAPI discovery — MPPScan is a payment registry,
  // free routes (/health, /docs, /demo/enrich) are discoverable via GET /docs instead.

  return {
    openapi: '3.1.0',
    info: {
      title: 'SolEnrich',
      version: '1.0.0',
      description: 'Solana onchain data enrichment agent. Wallet profiling, token analysis, transaction parsing, risk scoring. All scoring is deterministic — no LLM inference in the pipeline. Returns JSON (for agents) or natural language briefings (for LLMs).',
      'x-guidance': [
        'All paid endpoints are at POST /entrypoints/{key}/invoke with JSON body.',
        'Set "format" to "json" for structured data, "llm" for natural language briefings, or "both" for JSON + llm_summary.',
        'All endpoints accept both Stripe cards (fiat) and Solana USDC (crypto) via MPP.',
        'Use "enrich-wallet-light" or "enrich-token-light" for quick lookups. Use "due-diligence" for comprehensive risk reports.',
        'The "query" endpoint accepts plain English questions and routes to the right enricher automatically.',
        'Try the free /demo/enrich endpoint first to test (10 requests/hour, no payment needed).',
      ].join(' '),
    },
    servers: [{ url: BASE_URL }],
    'x-service-info': {
      categories: ['ai', 'blockchain', 'solana', 'data-enrichment', 'risk-scoring'],
      docs: {
        homepage: 'https://solenrich.com',
        apiReference: `${BASE_URL}/docs`,
        llms: `${BASE_URL}/docs`,
      },
    },
    paths,
  };
}
