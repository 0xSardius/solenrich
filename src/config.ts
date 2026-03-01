// Central configuration — env vars, pricing, cache TTLs

export const CONFIG = {
  solana: {
    rpcUrl: process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com',
    privateKey: process.env.SOLANA_PRIVATE_KEY ?? '',
    walletAddress: process.env.AGENT_WALLET_ADDRESS ?? '',
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
    baseUrl: 'https://api.jup.ag',
    priceUrl: 'https://price.jup.ag/v6',
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
} as const;
