# BaseEnrich — Claude Code PRD

> **What this document is:** A sequential, actionable implementation plan for Claude Code.
> Execute top-to-bottom. Dependencies are listed per file. All architectural decisions
> are made — implement, don't re-decide.
>
> **Product:** Wallet intelligence for autonomous agents on Base. Pay-per-query via x402.
> JSON for agents, natural language for LLMs.

---

## PROJECT IDENTITY

- **Name:** BaseEnrich (parent brand: Enrich)
- **What it does:** Base/EVM wallet + token + transaction enrichment. Accepts USDC micropayments via x402. Returns enriched onchain intelligence with behavioral labels and risk scores.
- **Stack:** Lucid Agents SDK (Hono adapter) + manual x402 middleware + ERC-8004 + Alchemy + GeckoTerminal + DexScreener + Etherscan + DeFi Llama + viem
- **Runtime:** Bun
- **Deploy:** Railway (Bun-native via Docker) — proven path. Cloudflare Workers is a later optimization for the genuinely-stateless read endpoints only (see Phase 11 caveat on `alchemy-sdk`).
- **Payment:** USDC on Base via x402, **Coinbase CDP facilitator** (`@coinbase/x402`). Base is Coinbase's chain and CDP's primary x402 network — best-supported, lowest-risk choice. Optional MPP/Stripe fiat fallback (infra ports directly from SolEnrich).
- **Settlement chain:** Base (always). Other chains are read-only data sources.

> **Build-fidelity note (read first):** This PRD is adapted from SolEnrich. Where it describes
> payments, the facilitator, the entrypoint-registration API, or pricing format, it follows
> SolEnrich's **production code** (`src/lib/agent.ts`, `src/config.ts`) — NOT SolEnrich's
> original PRD, which diverged from what actually shipped. Specifically: payments are wired as
> **manual `@x402/hono` middleware**, not Lucid's `.use(payments())` plugin (that plugin caused
> a registration-order bug even on EVM); entrypoints register via `addEntrypoint({ key })` from
> `createAgentApp(agent)`, not `agent.entrypoint({ name })`; prices are **decimal strings**
> (`'0.005'`), not base units (`5000`).

---

## PHASE 0: SETUP & SCAFFOLD

### 0.1 — Install lucid-agent-creator Claude Code skill

```bash
mkdir -p .claude/skills/lucid-agent-creator && \
curl -fsSL https://raw.githubusercontent.com/daydreamsai/skills-market/main/plugins/lucid-agent-creator/skills/SKILL.md \
  -o .claude/skills/lucid-agent-creator/SKILL.md
```

Read the skill file after downloading. Follow its patterns throughout.

### 0.2 — Scaffold with Lucid CLI

```bash
bunx @lucid-agents/cli baseenrich --adapter=hono
cd baseenrich
```

If prompted: adapter `hono`, template `blank`, payments `yes`, network `base`.

### 0.3 — Install dependencies

```bash
# Core Lucid packages — NOTE: no @lucid-agents/payments.
# We do NOT use Lucid's payments plugin. SolEnrich proved it causes a
# registration-order bug (memory: "Lucid's EVM payments plugin was registered
# per-route before our middleware. Fix: remove .use(payments(...))"). We wire
# x402 manually below, which is the production-hardened path.
bun add @lucid-agents/core @lucid-agents/http @lucid-agents/hono

# Validation
bun add zod

# x402 payment middleware (manual pipeline — mirrors SolEnrich's src/lib/agent.ts,
# swapping the Solana scheme @x402/svm for the EVM scheme @x402/evm)
bun add @x402/hono @x402/core @x402/evm @x402/extensions @coinbase/x402

# EVM data + RPC
bun add alchemy-sdk viem

# Caching
bun add @upstash/redis

# Server
bun add hono

# Dev
bun add -d typescript @types/bun wrangler

# Identity (ERC-8004 on EVM) — verify before installing. The Solana build used
# `8004-solana`; on EVM this is the actual ERC-8004 on-chain registry contracts,
# NOT a package port. Check whether Lucid's identity extension handles EVM
# registration, or interact with the ERC-8004 contracts directly via viem.
# Defer this to Phase 8 — it is not on the critical path to first paid query.

# Optional (fiat fallback — defer to post-launch; infra ports 1:1 from SolEnrich):
# bun add mppx stripe
```

**IMPORTANT:** If a `@lucid-agents/*` package name fails, check the current namespace on npm / the Lucid repo. If the x402 EVM scheme package name differs (`@x402/evm` vs `@x402/evm-exact` vs an `ExactEvmScheme` export under a different path), check `node_modules/@x402/*` — the SolEnrich equivalent is `import { ExactSvmScheme } from "@x402/svm/exact/server"`; you want the EVM analog.

### 0.4 — Environment variables

Create `.env`:

```env
# EVM RPC + data
ALCHEMY_API_KEY=your_alchemy_key
BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
ETH_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
ETHERSCAN_API_KEY=your_etherscan_key
BASESCAN_API_KEY=your_basescan_key
GECKOTERMINAL_BASE_URL=https://api.geckoterminal.com/api/v2

# Agent wallet (Base)
AGENT_PRIVATE_KEY=0x_your_private_key
AGENT_WALLET_ADDRESS=0x_your_usdc_receive_address

# Caching
UPSTASH_REDIS_REST_URL=your_upstash_url
UPSTASH_REDIS_REST_TOKEN=your_upstash_token

# Identity (defer — Phase 8)
PINATA_JWT=your_pinata_jwt

# x402 / Payments — Coinbase CDP facilitator (the production choice).
# Base is Coinbase's chain; CDP is its primary x402 network and auto-registers
# us on the x402 bazaar on every settlement. Do NOT use PayAI (memory: schema
# drift vs @x402/core 2.6) or Daydreams for Base.
PAYMENTS_ENABLED=true
CDP_API_KEY_ID=your_cdp_api_key_id
CDP_API_KEY_SECRET=your_cdp_api_key_secret
NETWORK=base
USDC_ADDRESS=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
# AGENT_WALLET_ADDRESS doubles as the x402 payTo address.

# Optional MPP/Stripe fiat fallback (defer to post-launch):
# MPP_SECRET_KEY=...
# STRIPE_SECRET_KEY=...

# Optional: Daydreams Router (for /query endpoint, Phase 9 — build last)
# DREAMS_ROUTER_URL=https://ai.xgate.run/v1
```

Note: `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` is USDC on Base — verify before use.
The Base mainnet x402 network identifier (CAIP-2 `eip155:8453`) is what the resource
server registers against — confirm the exact string the EVM scheme expects.

Create `.env.example` with placeholder values.

### 0.5 — TypeScript config

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "resolveJsonModule": true,
    "types": ["bun-types"],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### 0.6 — Project structure

```bash
mkdir -p src/{entrypoints,enrichers,formatters,sources,cache,schemas,utils}
mkdir -p src/realtime identity mcp deploy .well-known
```

### 0.7 — Verify scaffold

```bash
bun run dev
curl http://localhost:3000/health
curl http://localhost:3000/.well-known/agent.json
# Ctrl+C before continuing
```

---

## PHASE 1: CORE INFRASTRUCTURE

### 1.1 — Config (`src/config.ts`)

**Dependencies:** none

```typescript
// src/config.ts
export const CONFIG = {
  evm: {
    alchemyKey: process.env.ALCHEMY_API_KEY!,
    baseRpc: process.env.BASE_RPC_URL!,
    ethRpc: process.env.ETH_RPC_URL!,
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY!,
    baseUrl: 'https://api.etherscan.io/api',
  },
  basescan: {
    apiKey: process.env.BASESCAN_API_KEY!,
    baseUrl: 'https://api.basescan.org/api',
  },
  geckoterminal: {
    baseUrl: 'https://api.geckoterminal.com/api/v2',
  },
  dexscreener: {
    // DexScreener is multichain — SolEnrich's client only needs the chain slug
    // swapped (`/tokens/v1/solana/{mint}` → `/tokens/v1/base/{address}`).
    // Near-free reuse. Keep it as a SECOND price source so we preserve
    // SolEnrich's median-of-multiple-sources price (resists single-DEX outliers).
    baseUrl: 'https://api.dexscreener.com',
  },
  defiLlama: {
    baseUrl: 'https://api.llama.fi',
    yieldsUrl: 'https://yields.llama.fi',
  },
  zeroEx: {
    baseUrl: 'https://base.api.0x.org',
  },
  agent: {
    privateKey: process.env.AGENT_PRIVATE_KEY!,
    walletAddress: process.env.AGENT_WALLET_ADDRESS!,
  },
  cache: {
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  },
  // Payments use the Coinbase CDP facilitator via `@coinbase/x402` (reads
  // CDP_API_KEY_ID / CDP_API_KEY_SECRET). No facilitator URL to configure —
  // the `@coinbase/x402` `facilitator` export carries the endpoint + auth.
  payments: {
    enabled: process.env.PAYMENTS_ENABLED?.toLowerCase() === 'true',
    cdpKeyId: process.env.CDP_API_KEY_ID ?? '',
    cdpKeySecret: process.env.CDP_API_KEY_SECRET ?? '',
  },
  network: process.env.NETWORK || 'base',
  usdcAddress: process.env.USDC_ADDRESS!,
} as const;

// Supported chains for cross-chain enrichment (read-only sources).
// Payments always settle on Base.
export const CHAINS = {
  base: { id: 8453, name: 'Base', alchemyNetwork: 'base-mainnet' },
  ethereum: { id: 1, name: 'Ethereum', alchemyNetwork: 'eth-mainnet' },
  // Added in roadmap Phase D:
  // arbitrum: { id: 42161, name: 'Arbitrum', alchemyNetwork: 'arb-mainnet' },
  // optimism: { id: 10, name: 'Optimism', alchemyNetwork: 'opt-mainnet' },
  // polygon: { id: 137, name: 'Polygon', alchemyNetwork: 'polygon-mainnet' },
} as const;

// Prices are USDC DECIMAL STRINGS (Lucid SDK format), NOT base units.
// Confirmed from SolEnrich production config.ts — e.g. '0.002', not 5000.
export const PRICING = {
  'enrich-wallet-light': '0.003',
  'enrich-wallet-full': '0.005',
  'enrich-wallet-cross-chain': '0.010', // headline differentiator
  'enrich-token': '0.003',
  'enrich-transaction': '0.002',
  // Premium endpoints — registered only after the core is validated (see Phase 9):
  'enrich-wallet-defi': '0.008',
  'enrich-whale-watch': '0.010',
  'enrich-batch': '0.003',              // per address
  'enrich-graph': '0.015',
  'enrich-copy-trade': '0.020',
  'enrich-due-diligence': '0.025',
  'query': '0.010',
} as const;

export const CACHE_TTL = {
  tokenPrice: 60,
  tokenMetadata: 300,
  walletProfile: 300,
  walletDefi: 300,
  transaction: 3600,
  graph: 1800,
  holderData: 300,
  crossChain: 300,
} as const;
```

### 1.2 — Shared Schemas (`src/schemas/common.ts`)

**Dependencies:** none

```typescript
// src/schemas/common.ts
import { z } from 'zod';

export const FormatSchema = z.enum(['json', 'llm', 'both']).default('json');
export type Format = z.infer<typeof FormatSchema>;

export const DepthSchema = z.enum(['light', 'full']).default('light');
export type Depth = z.infer<typeof DepthSchema>;

// EVM address validation (0x + 40 hex chars)
export const EvmAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/);

// EVM transaction hash (0x + 64 hex chars)
export const TxHashSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/);

// Chain selector for cross-chain endpoints
export const ChainSchema = z.enum(['base', 'ethereum']).default('base');

export const TimestampSchema = z.string().datetime();
```

### 1.3 — Cache Layer (`src/cache/index.ts`)

**Dependencies:** `src/config.ts`

```typescript
// src/cache/index.ts
// Cache class: get<T>(key), set<T>(key, value, ttl), del(key).
// Upstash Redis REST client for prod; Map-based in-memory fallback if no Upstash URL.
// Prefix keys with "baseenrich:". JSON.stringify on set, parse on get.
// Wrap everything in try/catch — cache failure NEVER blocks enrichment.
```

### 1.4 — Parallel Fetcher (`src/utils/parallel.ts`)

**Dependencies:** none

```typescript
// src/utils/parallel.ts
// parallelFetch<T>(tasks: Array<{ name, fn, fallback? }>): Promise<Record<string, T>>
// Promise.allSettled, 10s timeout per task, fallback on failure, log warnings.
// Enrichment must not fail because one upstream is slow.
```

### 1.5 — Normalize (`src/utils/normalize.ts`)

**Dependencies:** none

```typescript
// src/utils/normalize.ts
// Helpers:
// - shortenAddress(addr): "0x7a3f...9c2d" (first 6, last 4 for 0x addresses)
// - formatUsd(value): "$1,234.56" / "$0.0000245"
// - formatNumber(value): "1.2M", "450K", "23"
// - formatPercent(value): "3.2%"
// - formatTimestamp(): ISO 8601 UTC
// - weiToEth(wei: bigint | string): number
// - tokenAmountToDecimal(raw, decimals): number
// - isContractAddress: helper used after bytecode check (see enrichers)
```

---

## PHASE 2: DATA SOURCE CLIENTS

### 2.1 — Alchemy Client (`src/sources/alchemy.ts`)

**Dependencies:** `src/config.ts`, `src/cache/index.ts`
**Purpose:** Primary EVM data source. Multi-chain via network parameter.

```typescript
// src/sources/alchemy.ts
// Use alchemy-sdk. Instantiate one Alchemy client per chain (base, ethereum).
//
// import { Alchemy, Network } from 'alchemy-sdk';
//
// Export class AlchemyClient with methods (all accept a `chain` param defaulting to 'base'):
//
// getTokenBalances(address, chain): Promise<TokenBalance[]>
//   - alchemy.core.getTokenBalances(address)
//   - Returns ERC-20 balances; filter zero balances
//
// getTokenMetadata(contractAddress, chain): Promise<TokenMetadata>
//   - alchemy.core.getTokenMetadata(contractAddress)
//   - name, symbol, decimals, logo
//
// getNativeBalance(address, chain): Promise<number>
//   - alchemy.core.getBalance(address) → convert wei to ETH
//
// getNfts(address, chain): Promise<Nft[]>
//   - alchemy.nft.getNftsForOwner(address)
//
// getAssetTransfers(address, chain, opts): Promise<Transfer[]>
//   - alchemy.core.getAssetTransfers({ fromAddress/toAddress, category: ['erc20','external','erc721','erc1155'] })
//   - For transaction history and activity analysis
//
// getTransactionReceipt(txHash, chain): Promise<TxReceipt>
//   - alchemy.core.getTransactionReceipt(txHash)
//   - Includes logs for event decoding
//
// getTransaction(txHash, chain): Promise<Transaction>
//   - alchemy.core.getTransaction(txHash)
//
// isContract(address, chain): Promise<boolean>
//   - alchemy.core.getCode(address) → returns '0x' for EOA, bytecode for contract
//
// CACHING: every method checks cache first (key: "alchemy:{chain}:{method}:{params}"),
// caches result with CACHE_TTL value. Handle rate limits (Alchemy throughput varies by tier).
// On 429, wait 1s and retry once.
//
// Define TypeScript interfaces for all return types.
```

### 2.2 — GeckoTerminal Client (`src/sources/geckoterminal.ts`)

**Dependencies:** `src/config.ts`, `src/cache/index.ts`
**Purpose:** Token prices, liquidity pools, market data. Free, no key.

```typescript
// src/sources/geckoterminal.ts
// Base API: https://api.geckoterminal.com/api/v2
// Network slug for Base is "base", for Ethereum is "eth".
//
// Export class GeckoTerminalClient with methods:
//
// getTokenPrice(network, tokenAddress): Promise<{ price_usd: number }>
//   - GET /networks/{network}/tokens/{address}
//   - Returns attributes.price_usd, market data
//
// getTokenInfo(network, tokenAddress): Promise<TokenInfo>
//   - GET /networks/{network}/tokens/{address}/info
//   - name, symbol, decimals, total_supply, holder data when available
//
// getTokenPools(network, tokenAddress): Promise<Pool[]>
//   - GET /networks/{network}/tokens/{address}/pools
//   - Returns DEX pools with reserve_usd (liquidity), volume, price change
//   - Use for liquidity assessment and risk flags
//
// getMultipleTokenPrices(network, addresses[]): Promise<Record<string, number>>
//   - GET /networks/{network}/tokens/multi/{addresses joined by comma}
//   - Batch price lookup, up to 30 addresses
//
// CACHING: standard pattern. Rate limit: 30 calls/min on free tier — cache aggressively.
// No API key needed. Add a small delay between rapid calls to respect rate limit.
```

### 2.2b — DexScreener Client (`src/sources/dexscreener.ts`)

**Dependencies:** `src/config.ts`, `src/cache/index.ts`
**Purpose:** Second price/liquidity source so token price = median of multiple sources.

```typescript
// src/sources/dexscreener.ts
// PORT SolEnrich's DexScreenerClient almost verbatim — DexScreener is multichain.
// Only change: the chain slug in the path. Solana used
//   GET https://api.dexscreener.com/tokens/v1/solana/{mint}
// Base uses
//   GET https://api.dexscreener.com/tokens/v1/base/{address}
// (and `eth` for Ethereum). The response shape (pairs[] with priceUsd, volume,
// priceChange{h1,h6,h24}, liquidity.usd, fdv, marketCap) is identical — the
// existing aggregation logic carries over unchanged.
//
// Why keep this alongside GeckoTerminal: SolEnrich computes token price as the
// MEDIAN of up to 3 sources via PriceAggregator (see 2.6) specifically to resist
// outliers from any single DEX. A single GeckoTerminal price loses that robustness.
```

### 2.6 — Price Aggregator (`src/utils/price-aggregator.ts`)

**Dependencies:** `src/sources/geckoterminal.ts`, `src/sources/dexscreener.ts`
**Purpose:** Port SolEnrich's `PriceAggregator` — returns the MEDIAN of available
price sources (GeckoTerminal + DexScreener, optionally a 0x quote) for a token,
so token enrichment is robust to a single bad source. The token-analyzer consumes
this instead of any single client's price. Same pattern as SolEnrich's
`PriceAggregator(dexscreener, jupiter)`, here `PriceAggregator(geckoterminal, dexscreener)`.

### 2.3 — Etherscan/Basescan Client (`src/sources/explorer.ts`)

**Dependencies:** `src/config.ts`, `src/cache/index.ts`
**Purpose:** Verified contract data, token info, ABI.

```typescript
// src/sources/explorer.ts
// Etherscan-family APIs share the same interface. Base uses Basescan.
// Use the v2 multichain API if available (api.etherscan.io/v2 with chainid param),
// otherwise per-chain endpoints.
//
// Export class ExplorerClient with methods:
//
// getContractSource(address, chain): Promise<{ verified: boolean, name?: string, abi?: any }>
//   - module=contract&action=getsourcecode
//   - Determine if contract is verified (security signal)
//
// getTokenSupply(contractAddress, chain): Promise<string>
//   - module=stats&action=tokensupply
//
// getTokenInfo(contractAddress, chain): Promise<TokenInfo>
//   - module=token&action=tokeninfo (Pro endpoint — may require paid tier; fallback to Alchemy metadata)
//
// CACHING: contract source rarely changes — cache 1 hour. Standard error handling.
// Rate limit: 5 calls/sec free tier.
```

### 2.4 — DeFi Llama Client (`src/sources/defi-llama.ts`)

**Dependencies:** `src/config.ts`, `src/cache/index.ts`
**Purpose:** Protocol TVL and yields. Already multi-chain. Free.

```typescript
// src/sources/defi-llama.ts
// Export class DefiLlamaClient with methods:
//
// getProtocolTvl(slug): Promise<{ tvl: number, chainTvls: Record<string, number> }>
//   - GET https://api.llama.fi/protocol/{slug}
//
// getBaseProtocols(): Promise<Protocol[]>
//   - GET https://api.llama.fi/protocols → filter chains includes "Base"
//   - Cache 30 min
//
// getYields(chain): Promise<YieldPool[]>
//   - GET https://yields.llama.fi/pools → filter by chain
//   - For matching DeFi positions to APY
//
// No auth. Cache TTL 600s.
```

### 2.5 — Base/EVM RPC via viem (`src/sources/rpc.ts`)

**Dependencies:** `src/config.ts`
**Purpose:** Direct chain reads, event decoding, multicall.

```typescript
// src/sources/rpc.ts
// Use viem. Create a publicClient per chain.
//
// import { createPublicClient, http } from 'viem';
// import { base, mainnet } from 'viem/chains';
//
// Export class RpcClient with methods:
//
// getBalance(address, chain): Promise<bigint>  — native balance in wei
//
// getBytecode(address, chain): Promise<string> — for contract detection
//
// decodeLogs(logs, abi): DecodedLog[] — decode event logs from tx receipts
//   - Use viem's decodeEventLog for ERC-20 Transfer, Uniswap Swap, etc.
//
// multicall(calls, chain): Promise<any[]> — batch contract reads (balances, etc.)
//
// readContract(address, abi, functionName, args, chain): Promise<any>
//
// viem handles ABIs and decoding natively — prefer it for any on-chain logic.
```

---

## PHASE 3: ENRICHMENT ENGINE

### 3.1 — Labeling Engine (`src/enrichers/labeler.ts`)

**Dependencies:** none (pure logic)

```typescript
// src/enrichers/labeler.ts
//
// Export function labelWallet(data: WalletData): string[]
// WalletData includes: native_balance, portfolio_value_usd, token_count, nft_count,
// tx_count_30d, first_tx_date, defi_positions[], top_holdings[], swap_count_30d,
// daily_tx_counts[], protocols_interacted[], stablecoin_pct, is_contract, bridge_tx_count.
//
// EVM label rules (apply all that match):
// "whale"          → any single holding > $100,000 (cross-chain aggregate when available)
// "active_trader"  → swap_count_30d > 50
// "defi_user"      → positions in 2+ distinct protocols
// "nft_trader"     → nft activity (mints/sales) high OR nft_count >= 10
// "new_wallet"     → first_tx_date within 30 days
// "dormant"        → tx_count_30d === 0 AND last tx > 90 days ago
// "airdrop_farmer" → interacted with 5+ new/unverified protocols in 30d, low retention
// "mev_bot"        → sandwich patterns OR many sequential same-block txs
// "sniper"         → buys within N blocks of liquidity add
// "bridge_user"    → bridge_tx_count > 3 in 30d
// "stablecoin_heavy" → stablecoin_pct > 60 (USDC, USDT, DAI on Base)
// "lp_provider"    → 2+ LP positions (Aerodrome, Uniswap V3)
// "contract"       → is_contract === true
// "multisig"       → Gnosis Safe bytecode pattern
//
// Known Base protocol addresses to detect (for protocols_interacted):
// - Aerodrome Router: 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43
// - Uniswap V3 Router (Base): 0x2626664c2603336E57B271c5C0b26F421741e481
// - Aave V3 Pool (Base): 0xA238Dd80C259a72e81d7e4664a9801593F98d1c5
// - Compound, Morpho, etc. — add as needed
//
// Return sorted alphabetically.
```

### 3.2 — Risk Scorer (`src/enrichers/risk-scorer.ts`)

**Dependencies:** none

```typescript
// src/enrichers/risk-scorer.ts
// Export scoreWalletRisk(data): { score: number, factors: string[] }
// Same scoring framework as the Solana design:
// - wallet age < 7d: +0.20; < 30d: +0.10
// - concentration > 80%: +0.20; > 50%: +0.10
// - flagged_associations > 0: +0.25
// - labels includes "mev_bot": +0.15
// - labels includes "airdrop_farmer": +0.10
// - tx_diversity < 0.1: +0.10
// - protocol_breadth < 2: +0.05
// Clamp [0,1]. Return score + contributing factor descriptions.
//
// EVM addition: maintain a small set of known scam/exploit/sanctioned addresses
// (e.g., Tornado Cash sanctioned addresses, known drainer contracts) for
// flagged_associations. Keep this list in a constant; expand over time.
```

### 3.3 — Wallet Profiler (`src/enrichers/wallet-profiler.ts`)

**Dependencies:** `src/sources/alchemy.ts`, `src/sources/geckoterminal.ts`, `src/sources/rpc.ts`, `src/sources/explorer.ts`, `src/enrichers/labeler.ts`, `src/enrichers/risk-scorer.ts`, `src/utils/parallel.ts`, `src/cache/index.ts`

```typescript
// src/enrichers/wallet-profiler.ts
//
// Export class WalletProfiler with:
// async enrich(address, depth, chain = 'base'): Promise<WalletEnrichment>
// async enrichCrossChain(address, depth): Promise<CrossChainWalletEnrichment>
//
// SINGLE-CHAIN FLOW (enrich):
// 1. Check cache "wallet:{chain}:{address}:{depth}"
// 2. parallelFetch:
//    a. native balance (RpcClient.getBalance → convert to ETH/USD)
//    b. token balances (Alchemy.getTokenBalances)
//    c. NFTs (Alchemy.getNfts) — count only for light, details for full
//    d. asset transfers / tx history (Alchemy.getAssetTransfers, last ~100)
//    e. isContract check (Alchemy.isContract)
// 3. For each token balance, fetch metadata + price:
//    - Alchemy.getTokenMetadata for decimals/symbol
//    - GeckoTerminal.getMultipleTokenPrices for USD values (batch)
// 4. Compute portfolio stats: total USD, top holdings, token/nft counts, stablecoin %
// 5. Compute activity stats from transfers: tx_count_30d, first_tx_date, swap_count_30d,
//    daily_tx_counts, protocols_interacted (map to-addresses against known protocol set),
//    bridge_tx_count (detect bridge contract interactions)
// 6. If depth === "full": parse DeFi positions against Base protocols
//    (Aerodrome, Aave V3, Uniswap V3, Compound, Morpho) using contract reads via viem
// 7. labelWallet() + scoreWalletRisk()
// 8. Identify connected wallets from frequent transfer counterparties
// 9. Assemble, cache, return
//
// CROSS-CHAIN FLOW (enrichCrossChain):
// - Run enrich() for each chain in CHAINS in parallel
// - Aggregate holdings across chains (same address)
// - Whale/portfolio labels computed on aggregate, not per-chain
// - Return per-chain breakdown + aggregate summary
//
// WalletEnrichment type:
// { address, chain, native_balance, native_balance_usd, portfolio_value_usd,
//   token_count, top_holdings[], nft_count, defi_positions[], tx_count_30d,
//   first_tx_date, labels[], risk_score, risk_factors[], connected_wallets[],
//   is_contract, last_updated }
//
// CrossChainWalletEnrichment type:
// { address, total_portfolio_value_usd, chains: Record<string, WalletEnrichment>,
//   aggregate_labels[], aggregate_risk_score, bridge_activity, last_updated }
//
// light vs full: light skips DeFi parsing + connected wallets, top 5 holdings only.
```

### 3.4 — Token Analyzer (`src/enrichers/token-analyzer.ts`)

**Dependencies:** `src/sources/alchemy.ts`, `src/sources/geckoterminal.ts`, `src/sources/explorer.ts`, `src/utils/parallel.ts`, `src/cache/index.ts`

```typescript
// src/enrichers/token-analyzer.ts
//
// Export class TokenAnalyzer with:
// async enrich(address, chain = 'base', includeHolders?): Promise<TokenEnrichment>
//
// FLOW:
// 1. Cache "token:{chain}:{address}"
// 2. parallelFetch:
//    a. GeckoTerminal.getTokenInfo + getTokenPrice (price, mcap, volume, supply)
//    b. GeckoTerminal.getTokenPools (liquidity assessment)
//    c. Alchemy.getTokenMetadata (decimals, symbol, name, logo)
//    d. Explorer.getContractSource (verified status)
// 3. Compute risk_flags:
//    - "low_liquidity" → total pool reserve_usd < $50K
//    - "unverified_contract" → not verified on Basescan
//    - "high_volatility" → abs(price_change_24h) > 20%
//    - "low_holder_count" → if holder data available and < 100
//    - "honeypot_risk" → if buy/sell tax detected or transfer restrictions (check pools)
//    - "new_token" → pool created < 7 days ago
// 4. Assemble, cache, return
//
// TokenEnrichment type:
// { address, chain, symbol, name, decimals, total_supply, price_usd, market_cap,
//   volume_24h, price_change_24h, liquidity_pools[], holder_count?, top_holders?,
//   verified, risk_flags[], last_updated }
```

### 3.5 — Transaction Parser (`src/enrichers/tx-parser.ts`)

**Dependencies:** `src/sources/alchemy.ts`, `src/sources/rpc.ts`, `src/cache/index.ts`

```typescript
// src/enrichers/tx-parser.ts
//
// Export class TxParser with:
// async enrich(txHash, chain = 'base'): Promise<TransactionEnrichment>
//
// FLOW:
// 1. Cache "tx:{chain}:{txHash}" (immutable once confirmed)
// 2. Alchemy.getTransaction + getTransactionReceipt
// 3. Decode logs via viem decodeEventLog:
//    - ERC-20 Transfer events → token transfers
//    - Uniswap/Aerodrome Swap events → swap detection
//    - Approval events
// 4. Classify type: swap, transfer, mint, approval, contract_deploy, nft_trade, bridge
// 5. Identify protocol from `to` address against known contract set
// 6. Extract: value (ETH), gas used, gas price, effective fee, status (success/revert)
// 7. Assemble, cache, return
//
// TransactionEnrichment type:
// { hash, chain, type, protocol, value_eth, value_usd, gas_used, fee_eth, fee_usd,
//   from, to, status, timestamp, token_transfers[], event_summary, last_updated }
```

---

## PHASE 4: LLM FORMATTERS

### 4.1 — Format Router (`src/formatters/index.ts`)

**Dependencies:** none

```typescript
// src/formatters/index.ts
export type Format = 'json' | 'llm' | 'both';

export function formatResponse<T>(data: T, format: Format, formatter: (d: T) => string) {
  switch (format) {
    case 'json': return data;
    case 'llm': return { briefing: formatter(data), content_type: 'text/markdown' };
    case 'both': return { ...data, llm_summary: formatter(data) };
  }
}
```

### 4.2 — Wallet Formatter (`src/formatters/llm-wallet.ts`)

**Dependencies:** `src/utils/normalize.ts`

```typescript
// src/formatters/llm-wallet.ts
// formatWalletBriefing(data: WalletEnrichment): string
// formatCrossChainBriefing(data: CrossChainWalletEnrichment): string
//
// Single-chain template:
// ## Wallet Profile: {shortenAddress(address)} ({chain})
// {walletAge} EVM wallet. Holds {native_balance} ETH ({formatUsd}) and {token_count} tokens.
// Portfolio value: ~{formatUsd(portfolio_value_usd)}.
// Top holdings: {top 3-5 as "SYMBOL ($VALUE)"}. {nft note if any}.
// {defi summary if positions}. Classified as {labels.join(', ')}.
// {tx_count_30d} txs in 30 days. Risk score: {risk_score}/1.0 ({level}).
// {risk factors}. {connected wallets note}.
// Data as of: {last_updated}
//
// Cross-chain template adds: holdings broken down per chain, aggregate value,
// bridge activity summary. This is the differentiator — make it shine.
//
// Rules: risk levels (<0.2 low, <0.5 moderate, <0.75 elevated, else high),
// under 300 tokens, always timestamp.
```

### 4.3 — Token Formatter (`src/formatters/llm-token.ts`)

```typescript
// formatTokenBriefing(data: TokenEnrichment): string
// ## Token: {symbol} ({name}) on {chain}
// Price: {formatUsd} ({change} 24h). Market cap: {formatUsd}. Volume: {formatUsd}.
// Liquidity: {top pool, reserve_usd}. {Deep/Moderate/Thin assessment}.
// {verified note}. Risk flags: {flags or "None identified"}.
// Data as of: {last_updated}
```

### 4.4 — Transaction Formatter (`src/formatters/llm-transaction.ts`)

```typescript
// formatTransactionBriefing(data: TransactionEnrichment): string
// ## Transaction: {shortenHash} ({chain})
// Type: {type}. {protocol note}. Value: {value_eth} ETH ({formatUsd}).
// Fee: {fee_eth} ETH. Status: {success/reverted}. Time: {timestamp}.
// {token transfers summary}. {event summary}.
// Data as of: {last_updated}
```

---

## PHASE 5: ENTRYPOINTS

### 5.1 — Schemas (`src/schemas/wallet.ts`, `src/schemas/token.ts`)

```typescript
// src/schemas/wallet.ts
import { z } from 'zod';
import { FormatSchema, DepthSchema, EvmAddressSchema, ChainSchema } from './common';

export const EnrichWalletInput = z.object({
  address: EvmAddressSchema,
  chain: ChainSchema,
  depth: DepthSchema,
  format: FormatSchema,
});

export const EnrichWalletCrossChainInput = z.object({
  address: EvmAddressSchema,
  depth: DepthSchema,
  format: FormatSchema,
});
// Plus WalletEnrichment + CrossChainWalletEnrichment output schemas (Zod).

// src/schemas/token.ts — EnrichTokenInput { address, chain, include_holders, format }
//                         TokenEnrichment output schema
```

### 5.2 — Wallet Entrypoint (`src/entrypoints/wallet.ts`)

**Dependencies:** wallet-profiler, formatters, schemas

```typescript
// src/entrypoints/wallet.ts
// USE THE PRODUCTION SDK SHAPE (from SolEnrich src/entrypoints/wallet.ts), NOT
// agent.entrypoint(). Each register fn receives the `addEntrypoint` function
// returned by createAgentApp(agent) plus its enricher, and the handler returns
// { output }.
//
// export function registerWalletEntrypoints(addEntrypoint, profiler) {
//   addEntrypoint({
//     key: 'enrich-wallet-full',          // `key`, not `name`
//     description: 'EVM wallet profile: holdings, DeFi positions, labels, risk score',
//     input: EnrichWalletInput,           // Zod schema
//     output: WalletEnrichmentSchema,     // Zod schema
//     price: PRICING['enrich-wallet-full'], // decimal string '0.005' — pricing also
//                                           // lives in the x402 route config (agent.ts)
//     handler: async (ctx) => {
//       const input = ctx.input as z.infer<typeof EnrichWalletInput>;
//       const data = await profiler.enrich(input.address, input.depth, input.chain);
//       return { output: formatResponse(data, input.format, formatWalletBriefing) };
//     },
//   });
//
//   // Separate KEYS for light vs full (SolEnrich does this — pricing rides per-key,
//   // so a single endpoint with a `depth` param can't price-discriminate):
//   //   'enrich-wallet-light' → profiler.enrich(..., 'light'), price '0.003'
//   //   'enrich-wallet-cross-chain' → profiler.enrichCrossChain, price '0.010',
//   //       formatCrossChainBriefing — the headline differentiator (Base + Ethereum)
// }
```

### 5.3 — Token Entrypoint (`src/entrypoints/token.ts`)

```typescript
// name: 'enrich-token', price 3000, handler: tokenAnalyzer.enrich → formatResponse
```

### 5.4 — Transaction Entrypoint (`src/entrypoints/transaction.ts`)

```typescript
// name: 'enrich-transaction', price 2000, handler: txParser.enrich → formatResponse
```

---

## PHASE 6: AGENT ASSEMBLY

### 6.1 — Agent Definition (`src/lib/agent.ts`)

> Place this at `src/lib/agent.ts` to match SolEnrich's layout (the manual x402 wiring,
> metrics middleware, and discovery routes all live alongside it there).

**MIRROR SolEnrich's production `src/lib/agent.ts` exactly — only the payment scheme
(SVM→EVM), the data clients, and the network identifier change.** Do NOT use
`.use(payments())`. Build the agent with `http()` only, then wire x402 as manual
middleware.

```typescript
// src/lib/agent.ts
// import { createAgent } from '@lucid-agents/core';
// import { createAgentApp } from '@lucid-agents/hono';
// import { http } from '@lucid-agents/http';
//
// // x402 — EVM scheme (the analog of SolEnrich's @x402/svm ExactSvmScheme)
// import { paymentMiddleware, x402ResourceServer } from '@x402/hono';
// import { ExactEvmScheme } from '@x402/evm/exact/server';   // verify path in node_modules
// import { HTTPFacilitatorClient } from '@x402/core/server';
// import type { RoutesConfig } from '@x402/core/server';
//
// // 1. Build agent with HTTP only — NO payments plugin.
// const agent = await createAgent({
//   name: 'BaseEnrich',
//   version: '1.0.0',
//   description: 'EVM wallet intelligence for agents. Wallet profiling, token analysis, risk scoring, cross-chain. JSON for agents, natural language for LLMs.',
// }).use(http()).build();
//
// const { app, addEntrypoint } = await createAgentApp(agent);
//
// // 2. x402 middleware (Base USDC). Mirror SolEnrich agent.ts:83-176.
// const PAYMENT_NETWORK = 'eip155:8453' as `${string}:${string}`;  // Base mainnet — confirm string
// const PAY_TO = process.env.AGENT_WALLET_ADDRESS!;
// const PAYMENTS_ENABLED = process.env.PAYMENTS_ENABLED?.toLowerCase() === 'true' && PAY_TO !== '';
//
// let resourceServer: x402ResourceServer | null = null;
// if (PAYMENTS_ENABLED) {
//   // Coinbase CDP facilitator — speaks current @x402/core schema, native to Base,
//   // auto-registers us on the x402 bazaar. Reads CDP_API_KEY_ID + CDP_API_KEY_SECRET.
//   const { facilitator } = await import('@coinbase/x402');
//   const facilitatorClient = new HTTPFacilitatorClient(facilitator);
//   try {
//     const rs = new x402ResourceServer(facilitatorClient).register(PAYMENT_NETWORK, new ExactEvmScheme());
//     await rs.initialize();          // catch auth/network failure BEFORE the restart loop
//     resourceServer = rs;
//   } catch (err) {
//     console.error('[x402] Facilitator init failed — paid endpoints disabled this process.', err);
//   }
// }
//
// if (PAYMENTS_ENABLED && resourceServer) {
//   const routeConfig = (key, price) => ({
//     accepts: [{ scheme: 'exact' as const, price, network: PAYMENT_NETWORK, payTo: PAY_TO }],
//     description: ENDPOINT_META[key]?.description ?? 'BaseEnrich enrichment endpoint',
//     mimeType: 'application/json',
//     // extensions.bazaar: declareDiscoveryExtension({...})  — copy SolEnrich's bazaar block
//   });
//   const x402Routes: RoutesConfig = Object.fromEntries(
//     Object.entries(PRICING).map(([key, price]) => [`POST /entrypoints/${key}/invoke`, routeConfig(key, price)])
//   );
//   app.use('/entrypoints/*', paymentMiddleware(x402Routes, resourceServer));
//   // (If you also add MPP/Stripe later, port SolEnrich's Authorization:Payment
//   //  gating verbatim — without it MPP overwrites x402's 200 responses.)
// }
//
// // 3. Init clients
// const cache = new Cache();
// const alchemy = new AlchemyClient(cache);
// const gecko = new GeckoTerminalClient(cache);
// const dexscreener = new DexScreenerClient(cache);
// const explorer = new ExplorerClient(cache);
// const defiLlama = new DefiLlamaClient(cache);
// const rpc = new RpcClient();
// const priceAggregator = new PriceAggregator(gecko, dexscreener);
//
// // 4. Init enrichers (DI — enrichers never construct their own clients)
// const walletProfiler = new WalletProfiler(alchemy, gecko, rpc, explorer, cache, priceAggregator);
// const tokenAnalyzer  = new TokenAnalyzer(alchemy, gecko, dexscreener, explorer, cache, priceAggregator);
// const txParser       = new TxParser(alchemy, rpc, cache);
//
// // 5. Register entrypoints (pass addEntrypoint, not agent)
// registerWalletEntrypoints(addEntrypoint, walletProfiler);
// registerTokenEntrypoints(addEntrypoint, tokenAnalyzer);
// registerTransactionEntrypoint(addEntrypoint, txParser);
//
// export { app, addEntrypoint, agent };
//
// If Lucid SDK / @x402 APIs differ, adapt to the installed package types
// (check node_modules/@lucid-agents/* and node_modules/@x402/*).
```

### 6.2 — Server Entry (`src/index.ts`)

```typescript
// src/index.ts
// import { app } from './lib/agent';
// Add /health: { status: 'ok', agent: 'BaseEnrich', version: '1.0.0' }
// Export a Bun fetch server for Railway (the proven SolEnrich pattern):
//   export default { port: Number(process.env.PORT ?? 3000), fetch: app.fetch };
// NOTE: SolEnrich binds hostname '127.0.0.1' locally to dodge a Windows IPv6
// dual-stack issue — carry that over if developing on Windows.
// (A Workers `export default { fetch }` is also possible later, but only after
// the alchemy-sdk→viem rewrite — see Phase 11.2.)
```

---

## PHASE 7: VERIFICATION

```bash
bun run dev

# Health
curl http://localhost:3000/health
curl http://localhost:3000/.well-known/agent.json

# 402 without payment
curl -X POST http://localhost:3000/entrypoints/enrich-wallet/invoke \
  -H "Content-Type: application/json" \
  -d '{"input": {"address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "chain": "base", "format": "json"}}'
# Expect HTTP 402 with payment instructions
```

Create `test/test-enrichment.ts` that calls enrichers directly with known addresses:
- Wallet: `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045` (vitalik.eth — rich history on mainnet, test cross-chain)
- A known Base-active wallet for Base-specific test
- Token (Base): a known Base token contract (e.g., a major token on Aerodrome)
- Tx: a recent Base transaction hash from Basescan

```bash
bun run test/test-enrichment.ts
```

**Acceptance criteria:**
- [ ] Server starts, /health 200, Agent Card generated
- [ ] Entrypoints return 402 without payment
- [ ] Wallet enrichment returns complete data for a Base address
- [ ] Cross-chain enrichment aggregates Base + Ethereum holdings
- [ ] Token enrichment returns price, liquidity, risk flags
- [ ] Transaction enrichment decodes type and transfers
- [ ] LLM format produces clean markdown under 300 tokens
- [ ] `format: "both"` includes llm_summary
- [ ] Cache hit on repeat request (check response time)

---

## PHASE 8: IDENTITY & DISCOVERY

### 8.1 — Register 8004 Identity (`identity/register.ts`)

```typescript
// identity/register.ts
// Register BaseEnrich on the 8004 EVM registry.
// VERIFY the correct 8004 EVM package/contract addresses on Base first —
// the Solana flow used 8004-solana; the EVM flow uses the ERC-8004 contracts.
// If Lucid's identity extension handles registration, use that instead of a manual script.
//
// Register with:
// - name: BaseEnrich
// - description: EVM wallet intelligence for agents (Base-native, cross-chain)
// - services: MCP endpoint, A2A agent-card URL
// - skills/domains: blockchain_analysis, technology/blockchain
// Save the resulting agent ID to .env.
```

### 8.2 — Optimize Agent Card

Verify `/.well-known/agent.json`. Ensure it includes:
- All entrypoints with descriptions, input schemas, prices
- `capabilities`: wallet-enrichment, token-analysis, transaction-parsing, risk-scoring, cross-chain-intelligence, llm-optimized-data
- `chains`: ["base", "ethereum"] (primary: base)
- `formats`: ["json", "llm", "both"]
- `pricing`: min/max, USDC
- `identity.erc8004`: agent ID from registration

### 8.3 — Seed Reputation

Have Parallax's other agents call BaseEnrich and leave 8004 feedback after successful queries.

---

## PHASE 9: PREMIUM & AMBITIOUS ENDPOINTS

> **VALIDATION GATE — do not skip.** Everything below (Phase 9, 9B, 9C) is **post-launch,
> demand-gated.** Ship and validate the core first: wallet (light/full), token, transaction,
> and the cross-chain wallet endpoint, then get the milestone the launch checklist names —
> **first external paid query.** This is SolEnrich's own hardest-won lesson (CLAUDE.md
> 2026-05-25: *"API additions become demand-driven — build what own bots need, not
> speculative endpoints"*). SolEnrich shipped 29 endpoints and still sees ~0.5 paid calls/day;
> the bottleneck was never supply. Do NOT rebuild all of SolEnrich's surface area on spec.
> Add a premium endpoint when a real caller asks for it, or when a BaseEnrich-consuming bot
> you own needs it. Build order below is priority *if and when* you build them.

Same build pattern (enricher → formatter → schema → entrypoint → register). In priority order:

1. **`/enrich/wallet/defi`** — Aave V3, Aerodrome, Uniswap V3, Compound, Morpho positions on Base. Price 8000.
2. **`/enrich/whale-watch`** — large transfers for a token, whale labeling, net flow. Price 10000.
3. **`/enrich/batch`** — bulk wallet/token enrichment, parallel, concurrency limit 5. Price 3000/addr.
4. **`/enrich/graph`** — cross-chain wallet relationship mapping, cluster detection. Price 15000.
5. **`/enrich/copy-trade-check`** — composite: trade history, win rate, PnL, hold time, consistency. Price 20000.
6. **`/enrich/token-due-diligence`** — composite research memo. Price 25000.
7. **`/query`** — natural language endpoint via Daydreams Router. Price 10000. Build LAST.

---

## PHASE 9B: REAL-TIME ENDPOINTS (deferred — SolEnrich hasn't validated these either)

> **Re-tier note:** "Full SolEnrich parity" overstates it — SolEnrich's own realtime is still
> **`check-alerts` poll-only**; SSE (`subscribe-alerts`) and webhooks were scoped but deferred
> pending poll-v1 validation (CLAUDE.md Priority 13). BaseEnrich should NOT lead with streaming
> infra SolEnrich hasn't shipped. Start with the same poll-based `/check-alerts` (stateless,
> agent owns the cursor, no persistent connections, deployable anywhere) and only build SSE +
> webhooks if poll-v1 shows demand. The Alchemy Notify mapping below is correct and worth
> keeping as the design — just don't build it before there's a caller.

These two endpoints carry over from the SolEnrich spec. They need persistent connections,
so they deploy to Railway/Fly.io, NOT Cloudflare Workers (Workers can't hold long-lived
SSE connections or run a webhook receiver loop). Split deployment — stateless enrichment on
Workers, real-time on Railway — is intended.

### 9b.1 — Real-time infrastructure (`src/realtime/`)

On Solana this used Helius webhooks. On EVM/Base, use **Alchemy** for the same role.

**Source adaptation:**
- Solana: Helius webhook subscriptions → EVM: **Alchemy Notify** (Address Activity Webhooks) for push, OR **Alchemy WebSocket subscriptions** (`alchemy_minedTransactions`, `alchemy_pendingTransactions` filtered by address) for streaming.
- Address Activity Webhooks fire on any ERC-20/native/NFT activity for watched addresses — ideal for both the streaming and webhook-condition use cases.

Build these files (mirror the SolEnrich realtime design):
- `src/realtime/webhook-receiver.ts` — HTTP endpoint that receives Alchemy Notify callbacks, verifies the signing key, normalizes the event
- `src/realtime/event-bus.ts` — internal pub/sub; fans incoming events to SSE subscribers and the condition engine
- `src/realtime/condition-engine.ts` — evaluates registered alert conditions against incoming events
- `src/realtime/sse-manager.ts` — manages SSE connections + fan-out
- `src/realtime/callback-dispatcher.ts` — POSTs enriched alerts to registered webhook URLs
- `src/realtime/alchemy-notify.ts` — wraps the Alchemy Notify API to create/update/delete address-activity webhooks programmatically as users subscribe/unsubscribe

### 9b.2 — `/stream/wallet` (SSE subscription)

```typescript
// src/entrypoints/stream-wallet.ts
// Input: { address, chain?, events?: ["swap","transfer","defi","nft","all"], format?: "json"|"llm" }
// Price: 10000 ($0.01) per hour (x402 time-windowed subscription)
//
// FLOW:
// 1. On subscribe: register the address with Alchemy Notify (alchemy-notify.ts)
// 2. Open an SSE stream (sse-manager.ts) for the caller
// 3. When Alchemy pushes activity → webhook-receiver → event-bus → enrich the event
//    (reuse TxParser + relevant enricher) → push enriched event down the SSE stream
// 4. Events are fully parsed/labeled/contextualized, NOT raw — format per `format` param
// 5. On disconnect/expiry: deregister the Alchemy webhook if no other subscribers
//
// Deploy on Railway (persistent connection). Lucid supports SSE — use its streaming entrypoint
// pattern if available; otherwise a Hono SSE route guarded by the x402 payment check.
```

### 9b.3 — `/webhook/register` (push-based alerts)

```typescript
// src/entrypoints/webhook.ts
// Input: {
//   target: { type: "wallet"|"token", address, chain? },
//   condition: { type: "transfer_above"|"holder_drop"|"price_change"|"whale_move"|"custom",
//                params: { threshold_usd?, ... } },
//   callback_url: string,
//   format?: "json"|"llm",
//   expires_hours?: number  // default 168
// }
// Price: 5000 ($0.005) registration + 2000 ($0.002) per triggered alert
//
// FLOW:
// 1. Store the registration (Turso/Upstash) with a generated webhook_id
// 2. Ensure the target address is registered with Alchemy Notify
// 3. On incoming event → condition-engine evaluates against stored registrations
// 4. On match → enrich the event → callback-dispatcher POSTs to callback_url (format applied)
// 5. Charge the per-alert fee (track in Lucid payments)
// 6. Auto-expire after expires_hours; deregister Alchemy webhook if orphaned
//
// Also expose /webhook/unregister { webhook_id } to cancel early.
// Deploy on Railway. Persist registrations so they survive restarts.
```

### 9b.4 — LLM formatters for real-time events

Add `src/formatters/llm-event.ts` — `formatEventBriefing(event)` produces a one-to-two
sentence enriched briefing for streamed/pushed events, e.g.:
"Wallet 0x7a3f…9c2d swapped 5 ETH ($12,400) for USDC on Aerodrome. Labeled active_trader.
2026-04-16T14:22:00Z"

---

## PHASE 9C: PERPS SUITE (DEFER — strongest differentiator, weakest terrain on Base)

> **Re-tier note — read before committing to this.** This is the most expensive section
> (8 endpoints) and the one most in tension with the validation gate. Two reasons to hold:
>
> 1. **Venue depth is thin.** This PRD itself admits Base perps are thinner than Solana's
>    Jupiter/Adrena, and that the real perps home on EVM is **Arbitrum (GMX/Vertex/Gains)**.
>    You'd be porting your strongest differentiator onto your weakest venue set.
> 2. **It contradicts why SolEnrich's perps suite worked.** That suite was built *because*
>    perps agents were proven high-frequency paying buyers on Solana — demand-driven, not
>    speculative. There is no equivalent demand signal on Base yet. Building 8 perps endpoints
>    against Avantis/Synthetix before a single external paid query repeats exactly the
>    speculative-breadth trap SolEnrich learned to avoid.
>
> **Recommendation:** cut Phase 9C from launch scope entirely. If perps prove to be the demand
> driver on BaseEnrich (watch for it via metrics + own-bot needs), strongly prefer making
> **Arbitrum the second chain** and building the perps suite there (GMX/Vertex/Gains give it
> real depth) rather than forcing it onto Base. The design below is sound and worth keeping as
> a reference — it is just not a launch-phase build.

SolEnrich's perps suite is its strongest differentiator. It maps to Base/EVM with the same
architecture — only the venue set changes. SolEnrich uses Jupiter Perps + Adrena (Solana-only)
as native venues with Hyperliquid + dYdX as cross-venue references. BaseEnrich would use
**Avantis + Synthetix V3** (Base-native) with Hyperliquid + dYdX as the same cross-references.

### Venue set & data sources (`src/sources/perps/`)

- `src/sources/perps/avantis.ts` — Base-native pool-based perps. Read positions, OI,
  borrow/funding rates, and market params from Avantis contracts via viem. This is the
  Jupiter-Perps analog (pool-based → flagged non-viable for basis trades).
- `src/sources/perps/synthetix.ts` — Synthetix Perps V3 on Base. Oracle-based. Read
  market structure, funding, and account positions via viem.
- `src/sources/perps/hyperliquid.ts` — cross-venue reference. Use Hyperliquid's public
  info API (REST) for funding, OI, mark price. Orderbook → viable for basis.
- `src/sources/perps/dydx.ts` — cross-venue reference. dYdX v4 indexer API for funding,
  OI, markets. Orderbook → viable for basis.
- When the roadmap expands to Arbitrum (Phase D), add `gmx.ts`, `vertex.ts`, `gains.ts`.

Each source exposes a normalized interface so the enrichers are venue-agnostic:
`getMarketStructure(symbol)`, `getFunding(symbol)`, `getOpenInterest(symbol)`,
`getPositions(address)`, `getMarkPrice(symbol)`, `isPoolBased(): boolean`.

### 9c.1 — `perps-market-structure` ($0.012)

```typescript
// src/entrypoints/perps-market-structure.ts + src/enrichers/perps/market-structure.ts
// Input: { symbol?: "SOL"|"BTC"|"ETH"|"all", venue?: "avantis"|"synthetix", format }
// Primary venue: Avantis (Base-native). Per-market OI, utilization, borrow APR, skew,
// OI cap headroom, health flags. Read on-chain via viem (replaces Solana Anchor reads).
// Output mirrors SolEnrich: per-market OI, utilization, borrow_apr, skew, oi_cap, health_flags.
```

### 9c.2 — `perps-trader-profile` ($0.010)

```typescript
// Multi-venue: Avantis + Synthetix positions for a wallet in one call.
// Per-venue breakdown + combined totals. Every position tagged with venue + multi_venue flag.
// Fields: size, leverage, entry_price, mark_price, unrealized_pnl, liquidation_price,
// trader_classification (scalper/swing/position), risk_flags (high_leverage, near_liquidation).
// This is the high-value endpoint — feeds copy-trade and risk agents.
```

### 9c.3 — `perps-cross-venue-funding` ($0.015)

```typescript
// Borrow/funding APR + OI aggregated across Avantis, Synthetix, Hyperliquid, dYdX in one call.
// Returns best entry per side (long/short), basis vs Hyperliquid, arbitrage opportunities
// surfaced above a 5pt spread. parallelFetch across the four venue sources.
```

### 9c.4 — `perps-venue-comparison` ($0.020)

```typescript
// "Where to trade at a given size." Adds spot slippage from 0x quote (replaces Jupiter Quote),
// per-venue fee, OI cap headroom, first-hour borrow cost. Returns total entry cost rankings
// + recommendation with warnings (insufficient_headroom, stressed_health).
// Input: { symbol, side, size_usd, format }
```

### 9c.5 — `perps-basis-signal` ($0.015)

```typescript
// Net-yield-after-borrow basis trade scanner. Computes perp mark vs spot, surfaces real
// funding APR earnable on Hyperliquid + dYdX (orderbook → viable), correctly flags
// Avantis (pool-based) as not-viable — same logic SolEnrich uses for Jupiter/Adrena.
// Synthetix (oracle-based) handled per its funding mechanics.
// Returns per-venue trade + filtered opportunities + best trade.
```

### 9c.6 — `perps-market-trend` ($0.008)

```typescript
// Trend across BTC/ETH/SOL on the primary Base venue (Avantis/Synthetix). Per-symbol deltas
// for mark price, total OI, long/short skew, utilization, borrow APR over 7/14/30d.
// Direction indicators per metric/market. Built for regime-detection bots.
// Requires snapshot accumulation (same temporal pattern as token-trend/wallet-history).
```

### 9c.7 — Perps alerts (fold into `/check-alerts`)

```typescript
// Extend the check-alerts condition set (Phase 9B) with perp position events:
// position_opened, position_closed, at_risk, liquidation_approaching, pnl_swing.
// Watchlist supports wallet addresses; condition-engine evaluates against perps-trader-profile.
```

### 9c.8 — Perps LLM formatters (`src/formatters/perps/`)

One formatter per endpoint, deterministic templates, e.g. trader-profile briefing:
"PERPS PROFILE: 0x7a3f…9c2d — 2 venues. Avantis: 10x long ETH, $24K size, entry $3,180,
liq $2,910 (8.5% away), +$1,240 unrealized. Synthetix: 3x short BTC, $8K. Classification:
swing trader. Risk: high_leverage on ETH position. As of 2026-04-16T14:22:00Z"

### Strategic note on venue depth

Base's perps ecosystem is thinner than Solana's Jupiter/Adrena or Arbitrum's GMX/Vertex.
Avantis is the main Base-native venue; Synthetix V3 adds a second. Hyperliquid and dYdX
provide cross-venue reference data on both products. If perps prove to be the strongest
demand driver (as they appear to be on SolEnrich), prioritize the Arbitrum expansion in
roadmap Phase D — GMX, Vertex, and Gains Network make the perps suite materially deeper
there. The perps suite is a strong argument for Arbitrum being the second EVM chain, not
just a generic L2 add-on.

---

## PHASE 10: MCP SERVER

```bash
bun add @modelcontextprotocol/sdk
```

```typescript
// mcp/server.ts
// Thin MCP wrapper exposing BaseEnrich endpoints as tools:
// - enrich_wallet (format=llm)
// - enrich_wallet_cross_chain (format=llm) ← the standout tool
// - enrich_token (format=llm)
// - enrich_transaction (format=llm)
// - query_evm (if /query implemented)
// MCP server holds its own wallet to pay x402 under the hood.
// List on Smithery, mcp.run, and other directories.
```

---

## PHASE 11: DEPLOYMENT

### 11.1 — Railway (primary deploy — the proven path)

**Deploy everything to Railway first (Bun-native via Docker), exactly like SolEnrich.**
SolEnrich's CLAUDE.md/memory is explicit: *"Railway over Cloudflare Workers (Bun native via
Docker)"* — the Workers split in the original PRD was aspirational and never the production
deploy. One Railway service hosting all endpoints is the lowest-risk path to first paid query.

Set the same secrets as SolEnrich, EVM-flavored:
```bash
# Railway env: ALCHEMY_API_KEY, BASE_RPC_URL, ETH_RPC_URL, ETHERSCAN_API_KEY,
# BASESCAN_API_KEY, AGENT_PRIVATE_KEY, AGENT_WALLET_ADDRESS,
# UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN,
# PAYMENTS_ENABLED=true, CDP_API_KEY_ID, CDP_API_KEY_SECRET, NETWORK=base, USDC_ADDRESS
```

### 11.2 — Cloudflare Workers (LATER, optional, read-endpoints only)

Workers is a *post-launch optimization*, not a launch requirement, and it has a real blocker:
**`alchemy-sdk` leans on Node/websocket APIs that are not Workers-friendly, and Alchemy is the
workhorse.** viem *is* Workers-compatible. So if you ever move the stateless read endpoints to
Workers, you must first replace `alchemy-sdk` calls there with raw viem/`fetch` against the
Alchemy JSON-RPC + Data API. Until then, Railway-all. Don't spend launch time on this.

```toml
# deploy/wrangler.toml (only if/when you do the viem-only rewrite)
name = "baseenrich"
main = "src/index.ts"
compatibility_date = "2024-12-01"
node_compat = true
[vars]
NETWORK = "base"
```

### 11.3 — Real-time services (only if Phase 9B is built)

If/when the streaming and webhook endpoints get built (gated — see Phase 9B), they need
persistent connections and run as a separate Railway/Fly.io service. Deploy `src/realtime/` +
the `/stream/wallet` and `/webhook/*` entrypoints there.

```bash
# Railway service holds: webhook-receiver, sse-manager, event-bus, condition-engine,
# callback-dispatcher, and the Alchemy Notify integration.
# Set the same secrets as Workers, plus a public URL for Alchemy Notify callbacks.
```

The Alchemy Notify webhook callback URL must point at the Railway service's public
`/realtime/alchemy-callback` route. Register that URL in the Alchemy dashboard or via
the Notify API in `alchemy-notify.ts`.

### 11.4 — Verify production

```bash
# Railway public URL (or custom domain once mapped)
curl https://baseenrich.<subdomain>.up.railway.app/health
curl https://baseenrich.<subdomain>.up.railway.app/.well-known/agent.json
```

---

## PHASE 12: LAUNCH CHECKLIST

**Must-ship (lean launch — gets you to the only milestone that matters):**
- [ ] Phase 7 acceptance criteria pass on production
- [ ] Core 3 endpoints live (wallet light/full, token, transaction)
- [ ] Cross-chain wallet endpoint live (the headline feature)
- [ ] x402 payments live via CDP — endpoints return 402 without payment, settle on Base with it
- [ ] LLM format tested
- [ ] Deployed Railway-all (one service)
- [ ] README with API docs, examples, pricing
- [ ] Listed on x402 Bazaar (auto via CDP settlement) + XGATE
- [ ] Launch thread published
- [ ] **First external paid query — the only milestone that matters week 1**

**Post-launch (do NOT block launch on these — most are demand-gated, see Phase 9):**
- [ ] ERC-8004 identity registered + Agent Card optimized (capabilities, chains, cross-chain flag)
- [ ] Reputation seeded (Parallax agents call BaseEnrich, leave feedback)
- [ ] MCP server live + listed on directories (Smithery, mcp.run, Glama)
- [ ] Premium endpoints — added per real demand, not on spec
- [ ] Real-time (`/check-alerts` poll-first; SSE/webhooks only if poll validates)
- [ ] Perps suite — only if demand appears, and prefer Arbitrum terrain (Phase 9C note)
- [ ] Optional MPP/Stripe fiat fallback

---

## IMPLEMENTATION NOTES

1. **Follow SolEnrich's production code, not its PRD.** Where this doc and the installed packages disagree, the installed packages win — check `node_modules/@lucid-agents/*/dist/index.d.ts` and `node_modules/@x402/*`. The reference implementation is SolEnrich `src/lib/agent.ts` + `src/config.ts`.
2. **Payments = manual `@x402/hono` middleware, NOT `.use(payments())`.** Lucid's payments plugin caused a registration-order bug even on EVM (memory: *"remove .use(payments(...))"*). Build the agent with `http()` only; wire x402 + `ExactEvmScheme` + CDP facilitator manually. This is the single most important fidelity point.
3. **Facilitator = Coinbase CDP (`@coinbase/x402`).** Not PayAI (schema drift vs `@x402/core`), not Daydreams. Base is CDP's home network — best-supported, and it auto-registers you on the x402 bazaar.
4. **Entrypoints register via `addEntrypoint({ key })`** from `createAgentApp(agent)`, handler returns `{ output }`. Not `agent.entrypoint({ name })`.
5. **Pricing = USDC decimal strings** (`'0.005'`), confirmed from SolEnrich `config.ts`. NOT base units. Use separate keys for light/full (pricing rides per-key).
6. **Verify the ERC-8004 EVM registry** before Phase 8 — it's the on-chain contracts, not a port of `8004-solana`. Off the critical path; defer past first paid query.
7. **Happy path first.** Get wallet enrichment on Base returning data before error handling, caching, or premium endpoints.
8. **Test addresses:** `0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045` (vitalik.eth) for cross-chain; find a Base-active wallet and a Base token on Basescan for chain-specific tests.
9. **Cross-chain is the differentiator.** Prioritize the cross-chain wallet endpoint — it's what competitors bolting Base onto a Solana product can't match. It's the one thing worth building beyond the bare core *before* the validation gate.
10. **Median price across sources.** Keep GeckoTerminal + DexScreener (+ optional 0x quote) feeding `PriceAggregator`, mirroring SolEnrich's median-of-3. A single price source is a regression.
11. **viem over ethers + over `alchemy-sdk` where Workers-bound.** viem is lighter, faster, better TS, and Workers-compatible; `alchemy-sdk` is not Workers-friendly. Use viem for all on-chain logic/event decoding; use `alchemy-sdk` for the Data API (balances/transfers/NFTs) on Railway.
12. **GeckoTerminal rate limits** (30/min free). Cache aggressively. For production volume, consider a paid price feed.
13. **Alchemy is the workhorse.** Most wallet data flows through it. Get the API key tier right for expected volume.
14. **Payments settle on Base only.** Other chains are read-only data sources. Never accept payment on a chain where gas would exceed the query price.
15. **The LLM formatter is pure string interpolation.** No LLM calls except `/query`.
16. **Deploy Railway-all first.** Workers + the realtime split are post-launch optimizations, not launch requirements (Phase 11).
17. **`/query` (Phase 9) and all premium/perps/realtime endpoints are post-validation.** Ship the core + cross-chain, get the first external paid query, then let demand pull the rest.
18. **`mev_bot` / `sniper` labels are v2 / best-effort.** Sandwich detection and buy-within-N-blocks-of-liquidity-add need far heavier data than `getAssetTransfers` returns — don't let them block the labeler shipping.
