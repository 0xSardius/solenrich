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
  'feed-latest': '0.005',
  'consensus-signal': '0.005',
  'portfolio-history': '0.006',
  'check-alerts': '0.008',
} as const;

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
  feedLatest: 86_400,    // 24 hours — daily intelligence brief, lazy-populated
} as const;
