// OpenAPI 3.1.0 discovery document for MPP/AgentCash
// Serves at GET /openapi.json — machine-readable payment terms + input schemas
// Reference: https://mpp.dev/advanced/discovery

import { PRICING } from './config';

// When MPP is enabled, all endpoints accept Stripe. Otherwise all use x402.

/** Endpoint metadata: description, summary, input schema */
const ENDPOINT_META: Record<string, {
  summary: string;
  description: string;
  schema: Record<string, unknown>;
}> = {
  'enrich-wallet-light': {
    summary: 'Light wallet profile',
    description: 'SOL balance, token holdings, labels, risk score. Fast and cheap.',
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
    description: 'Adds DeFi positions, connected wallets, enhanced transaction history to light profile.',
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
    description: 'Price (median of 3 sources), market cap, volume, liquidity, risk flags, verification status.',
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
    description: 'Adds top 20 holders, HHI concentration index, volatility metrics to light token analysis.',
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
    description: 'Plain English questions routed to the right enricher via keyword matching. Example: "Is JUP safe?"',
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
    description: 'Protocol TVL, yield pools, on-chain activity metrics, health signals. Supports Raydium, Orca, marginfi, Drift, Jupiter, Kamino, Marinade, Jito, and more.',
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

    // Amount in base units: USDC has 6 decimals, so $0.002 = 2000
    const amountBaseUnits = Math.round(parseFloat(price) * 1_000_000).toString();

    // When MPP enabled, endpoints accept both Stripe (fiat) and Solana USDC (crypto)
    const paymentInfo: Record<string, unknown> = mppEnabled
      ? {
          amount: amountBaseUnits,
          description: meta.summary,
          intent: 'charge',
          methods: [
            { method: 'stripe', currency: 'usd' },
            { method: 'solana', currency: 'USDC', network: 'solana:mainnet-beta' },
          ],
        }
      : {
          amount: amountBaseUnits,
          currency: 'USDC',
          description: meta.summary,
          intent: 'charge',
          method: 'x402',
          network: 'solana',
        };

    paths[`/entrypoints/${key}/invoke`] = {
      post: {
        operationId: key,
        summary: meta.summary,
        description: meta.description,
        'x-payment-info': paymentInfo,
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

  // Free endpoints
  paths['/health'] = {
    get: {
      operationId: 'health',
      summary: 'Health check',
      description: 'Returns service status. Free, no payment required.',
      responses: { '200': { description: 'Service is healthy' } },
    },
  };

  paths['/docs'] = {
    get: {
      operationId: 'docs',
      summary: 'API documentation',
      description: 'Agent-readable documentation with all endpoints, scoring methodology, and data sources. Free.',
      responses: { '200': { description: 'JSON documentation object' } },
    },
  };

  paths['/demo/enrich'] = {
    post: {
      operationId: 'demo-enrich',
      summary: 'Free demo enrichment',
      description: 'Rate-limited free enrichment (10 requests/hour). Auto-detects wallet vs token. No payment required.',
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: {
              type: 'object',
              required: ['address'],
              properties: {
                address: { type: 'string', description: 'Solana address (wallet or token mint)' },
              },
            },
          },
        },
      },
      responses: {
        '200': { description: 'Enrichment result with demo metadata' },
        '429': { description: 'Rate limit exceeded' },
      },
    },
  };

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
