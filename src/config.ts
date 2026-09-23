// Central configuration — env vars, pricing, cache TTLs

export const CONFIG = {
  solana: {
    rpcUrl: process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com',
    privateKey: process.env.SOLANA_PRIVATE_KEY ?? '',
    walletAddress: process.env.AGENT_WALLET_ADDRESS ?? '',
  },
  identity: {
    agentAsset: process.env.AGENT_ASSET ?? '',
    operationalWallet: process.env.OPERATIONAL_WALLET_ADDRESS ?? '',
  },
  helius: {
    apiKey: process.env.HELIUS_API_KEY ?? '',
    baseUrl: 'https://api.helius.xyz/v0',
    rpcUrl: `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY ?? ''}`,
  },
  birdeye: {
    apiKey: process.env.BIRDEYE_API_KEY ?? '',
    baseUrl: 'https://public-api.birdeye.so',
  },
  defiLlama: {
    baseUrl: 'https://api.llama.fi',
    yieldsUrl: 'https://yields.llama.fi',
  },
  jupiter: {
    apiKey: process.env.JUPITER_API_KEY ?? '',
    baseUrl: 'https://api.jup.ag',
  },
  cache: {
    url: process.env.UPSTASH_REDIS_REST_URL ?? '',
    token: process.env.UPSTASH_REDIS_REST_TOKEN ?? '',
  },
} as const;

/** Per-entrypoint pricing in USDC decimal strings (Lucid SDK format) */
export const PRICING = {
  'enrich-wallet-light': '0.002',
  'enrich-wallet-full': '0.005',
  'enrich-token-light': '0.002',
  'enrich-token-full': '0.004',
  'parse-transaction': '0.001',
  'whale-watch': '0.008',
  'batch-enrich': '0.015',
  'wallet-graph': '0.010',
  'copy-trade-signals': '0.010',
  'due-diligence': '0.020',
  'query': '0.003',
  'compare-tokens': '0.006',
  'compare-wallets': '0.006',
  'token-trend': '0.006',
  'wallet-history': '0.006',
  'new-tokens': '0.012',
  'protocol-profile': '0.008',
  'perps-market-structure': '0.012',
  'perps-trader-profile': '0.010',
  'hyperliquid-trader-profile': '0.012',
  'hyperliquid-smart-money': '0.05',
  'perps-cross-venue-funding': '0.015',
  'perps-venue-comparison': '0.020',
  'perps-basis-signal': '0.015',
  'perps-market-trend': '0.008',
  'trending-signals': '0.050',
  'smart-money-flow': '0.100',
  'smart-money-trenches': '0.05',
  'runner-scan': '0.04',
  'feed-latest': '0.005',
  'consensus-signal': '0.005',
  'attention-momentum': '0.02',
  'trenches-scan': '0.08',
  'trenches-check': '0.03',
  'exit-signal': '0.04',
  'portfolio-history': '0.006',
  'check-alerts': '0.008',
  'gacha-ev-scan': '0.02',
  // StonkFun product line (quote-paired + reward-mode coins). stonk-pairs is free (FREE_ENDPOINTS).
  'stonk-reward-risk': '0.005',
  'stonk-yield': '0.005',
  'stonk-screener': '0.01',
  'stonk-launch-preflight': '0.25',
  'stonk-gems': '0.03',
  'stonk-launch-intel': '0.02',
  'stonk-quote': '0.005',
  // Up to 25 coins per call, from the index (no per-coin upstream reads). Cheaper than screener + N × stonk-yield.
  'stonk-yield-batch': '0.05',
} as const;

/** Entrypoints served without a paywall. Kept out of PRICING so x402/MPP never gate them. */
export const FREE_ENDPOINTS = ['stonk-pairs'] as const;

/**
 * Endpoints whose cold handler can outlive the payer's Solana blockhash (~60s).
 * These settle BEFORE the handler runs (src/lib/settle-first.ts). Measured cold
 * 2026-09-20, local vs prod upstreams: smart-money-flow 30s (60s on Railway),
 * smart-money-trenches 27s, trenches-scan 26s, trenches-check 24s. Everything
 * else is under 5s cold and keeps the stock verify → handler → settle order.
 */
export const SETTLE_FIRST_ENDPOINTS = new Set([
  'smart-money-flow',
  'smart-money-trenches',
  'trenches-scan',
  'trenches-check',
]);

/**
 * Cache warmer: keep a default-input result warm only while the endpoint was
 * called within this window. 30 min (was 2h, trimmed 2026-09-20): an agent
 * polling more often than that renews it; a single one-off call costs at most
 * 15 re-runs of smart-money-trenches instead of 60.
 */
export const WARM_DEMAND_WINDOW_SEC = 30 * 60;

/** Cache TTL in seconds per data type */
export const CACHE_TTL = {
  tokenPrice: 60,
  tokenMetadata: 600,
  walletProfile: 300,
  transaction: 3600,
  defiProtocol: 600,
  jupiterPrice: 60,
  holderData: 300,
  whaleWatch: 300,
  graph: 1800,
  copyTrade: 600,
  dueDiligence: 600,
  snapshot: 2_592_000,  // 30 days
  trend: 300,           // 5 minutes
  protocolProfile: 1800, // 30 minutes — activity data is RPC-heavy
  perpsMarket: 30,       // 30 seconds — on-chain state changes every block
  perpsTrader: 60,       // 1 minute — positions update on tx
  hlSmartMoney: 300,     // 5 minutes — leaderboard + aggregate positioning (orchestration)
  trendingSignals: 300,  // 5 minutes — trending shifts fast
  smartMoney: 600,       // 10 minutes — smart money shifts over days
  trenches: 120,         // 2 minutes — fresh-launch buys are a live signal
  runnerScan: 60,        // 1 minute — velocity is the whole point; stale = wrong
  trenchesScan: 90,      // orchestrator blend — legs have their own caches underneath
  trenchesCheck: 60,     // per-token verdict — velocity freshness matters
  exitSignal: 60,        // sell-side verdict — a stale exit call is a wrong one
  feedLatest: 86_400,    // 24 hours — daily intelligence brief, lazy-populated
  gacha: 60,             // 1 minute — pack EV/stock drift as packs are opened
  stonkPairs: 300,       // 5 minutes — quote-pair catalog changes rarely
  stonkToken: 60,        // 1 minute — token record + reward totals
  stonkPricing: 60,      // 1 minute — LaunchLab curve constants (raise drifts with price)
  stonkRewardRisk: 120,  // 2 minutes — on-chain fee config + rewards read
  stonkYield: 300,       // 5 minutes — window math over daily snapshots
  stonkQuote: 120,       // 2 minutes — composed cost/payback at one size
} as const;
