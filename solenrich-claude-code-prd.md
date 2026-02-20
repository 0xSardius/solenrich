# SolEnrich — Claude Code PRD

> **What this document is:** A sequential, actionable implementation plan for Claude Code.
> Every block is ordered by dependency. Execute top-to-bottom. Do not skip ahead.
> All architectural decisions are made. Your job is to implement, not decide.

---

## PROJECT IDENTITY

- **Name:** SolEnrich
- **What it does:** Solana onchain data enrichment agent. Accepts USDC micropayments via x402 protocol. Returns enriched wallet/token/transaction data in JSON (for agents) or natural language (for LLMs).
- **Stack:** Lucid Agents SDK + Hono adapter + 8004-solana + Helius + Birdeye + DeFi Llama
- **Runtime:** Bun
- **Deploy target:** Cloudflare Workers (stateless endpoints), Railway (streaming)
- **Payment:** USDC on Solana via x402, Daydreams facilitator

---

## PHASE 0: SETUP & SCAFFOLD (Do this first, do not write any code yet)

### 0.1 — Install lucid-agent-creator Claude Code skill

```bash
mkdir -p .claude/skills/lucid-agent-creator && \
curl -fsSL https://raw.githubusercontent.com/daydreamsai/skills-market/main/plugins/lucid-agent-creator/skills/SKILL.md \
  -o .claude/skills/lucid-agent-creator/SKILL.md
```

Read the skill file after downloading. Follow any patterns it specifies throughout this PRD.

### 0.2 — Scaffold with Lucid CLI

```bash
bunx @lucid-agents/cli solenrich --adapter=hono
cd solenrich
```

If the CLI prompts interactively, select:
- Adapter: `hono`
- Template: `blank` (we're building custom entrypoints)
- Payments: yes
- Network: `solana`

### 0.3 — Install all dependencies

```bash
# Core Lucid packages (some may already be installed by CLI)
bun add @lucid-agents/core @lucid-agents/http @lucid-agents/payments @lucid-agents/identity @lucid-agents/a2a @lucid-agents/hono @lucid-agents/types

# Validation
bun add zod

# Data sources
bun add helius-sdk @solana/web3.js

# Caching
bun add @upstash/redis

# Identity
bun add 8004-solana

# Utilities
bun add hono

# Dev
bun add -d typescript @types/bun wrangler
```

**IMPORTANT:** If any `@lucid-agents/*` package fails to install, check npm for the correct package name. The ecosystem is actively developing — package names may have changed. Fallback: check `https://github.com/daydreamsai/lucid-agents/tree/master/packages` for the current list. If the packages use a different namespace like `@lucid-dreams/*`, use that instead.

### 0.4 — Environment variables

Create `.env`:

```env
# Solana
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY
SOLANA_PRIVATE_KEY=base58_encoded_private_key
AGENT_WALLET_ADDRESS=your_solana_usdc_receive_address

# Data sources
HELIUS_API_KEY=your_helius_api_key
BIRDEYE_API_KEY=your_birdeye_api_key

# Caching
UPSTASH_REDIS_REST_URL=your_upstash_url
UPSTASH_REDIS_REST_TOKEN=your_upstash_token

# Identity
PINATA_JWT=your_pinata_jwt_for_ipfs

# x402 / Payments
FACILITATOR_URL=https://facilitator.daydreams.systems
NETWORK=solana
DEFAULT_PRICE=5000

# Optional: Daydreams Router (for /query endpoint only)
# DREAMS_ROUTER_URL=https://ai.xgate.run/v1
```

Create `.env.example` with the same keys but placeholder values.

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
    "paths": {
      "@/*": ["./src/*"]
    }
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### 0.6 — Project structure

Create all directories (files will be created in subsequent phases):

```bash
mkdir -p src/{entrypoints,enrichers,formatters,sources,cache,schemas,utils}
mkdir -p src/realtime
mkdir -p identity
mkdir -p mcp
mkdir -p deploy
mkdir -p .well-known
```

### 0.7 — Verify scaffold works

```bash
bun run dev
# Should start Hono server on port 3000
# Verify: curl http://localhost:3000/health
# Verify: curl http://localhost:3000/.well-known/agent.json
# Kill the server (Ctrl+C) before continuing
```

---

## PHASE 1: CORE INFRASTRUCTURE (Build these files in order)

All files below have dependencies listed. Do not build a file before its dependencies exist.

### 1.1 — Config (`src/config.ts`)

**Dependencies:** none
**Purpose:** Central configuration. Every other file imports from here.

```typescript
// src/config.ts
// Load environment variables and export typed config.
// Export a PRICING object with per-endpoint prices as string amounts in USDC.
// Export a CACHE_TTL object with TTL values in seconds per data type.
// Export data source URLs/keys.

export const CONFIG = {
  solana: {
    rpcUrl: process.env.SOLANA_RPC_URL!,
    privateKey: process.env.SOLANA_PRIVATE_KEY!,
    walletAddress: process.env.AGENT_WALLET_ADDRESS!,
  },
  helius: {
    apiKey: process.env.HELIUS_API_KEY!,
    baseUrl: 'https://api.helius.xyz/v0',
    rpcUrl: `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`,
  },
  birdeye: {
    apiKey: process.env.BIRDEYE_API_KEY!,
    baseUrl: 'https://public-api.birdeye.so',
  },
  defiLlama: {
    baseUrl: 'https://api.llama.fi',
    yieldsUrl: 'https://yields.llama.fi',
  },
  jupiter: {
    baseUrl: 'https://api.jup.ag',
    priceUrl: 'https://api.jup.ag/price/v2',
  },
  cache: {
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
  },
  facilitator: {
    url: process.env.FACILITATOR_URL || 'https://facilitator.daydreams.systems',
  },
  network: process.env.NETWORK || 'solana',
} as const;

export const PRICING = {
  'enrich-wallet-light': '3000',    // $0.003 in USDC base units (6 decimals)
  'enrich-wallet-full': '5000',     // $0.005
  'enrich-token': '3000',           // $0.003
  'enrich-transaction': '2000',     // $0.002
  'enrich-wallet-defi': '8000',     // $0.008
  'enrich-whale-watch': '10000',    // $0.01
  'enrich-batch': '3000',           // $0.003 per address
  'enrich-graph': '15000',          // $0.015
  'enrich-copy-trade': '20000',     // $0.02
  'enrich-due-diligence': '25000',  // $0.025
  'query': '10000',                 // $0.01
  'stream-wallet': '10000',         // $0.01/hour
  'webhook-register': '5000',       // $0.005
} as const;

export const CACHE_TTL = {
  tokenPrice: 60,        // 1 minute
  tokenMetadata: 300,    // 5 minutes
  walletProfile: 300,    // 5 minutes
  walletDefi: 300,       // 5 minutes
  transaction: 3600,     // 1 hour (immutable once confirmed)
  graph: 1800,           // 30 minutes
  holderData: 300,       // 5 minutes
} as const;
```

### 1.2 — Shared Schemas (`src/schemas/common.ts`)

**Dependencies:** none
**Purpose:** Zod schemas used across multiple entrypoints.

```typescript
// src/schemas/common.ts
import { z } from 'zod';

export const FormatSchema = z.enum(['json', 'llm', 'both']).default('json');
export type Format = z.infer<typeof FormatSchema>;

export const DepthSchema = z.enum(['light', 'full']).default('light');
export type Depth = z.infer<typeof DepthSchema>;

// Solana address validation (base58, 32-44 chars)
export const SolanaAddressSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

// Transaction signature validation (base58, 87-88 chars)
export const TxSignatureSchema = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{87,88}$/);

// Timestamp for responses
export const TimestampSchema = z.string().datetime();
```

### 1.3 — Cache Layer (`src/cache/index.ts`)

**Dependencies:** `src/config.ts`
**Purpose:** Unified cache interface. Upstash Redis for prod, in-memory LRU for dev.

```typescript
// src/cache/index.ts
// Export a Cache class with get<T>(key: string): Promise<T | null>
// and set<T>(key: string, value: T, ttlSeconds: number): Promise<void>
// and del(key: string): Promise<void>
//
// Implementation: Use @upstash/redis REST client.
// If UPSTASH_REDIS_REST_URL is not set, fall back to a simple Map-based in-memory cache.
// Keys should be prefixed with "solenrich:" to namespace.
// Always JSON.stringify on set, JSON.parse on get.
// Wrap all operations in try/catch — cache failures should NEVER block enrichment.
// Log cache errors but return null/void gracefully.
```

### 1.4 — Utility: Parallel Fetcher (`src/utils/parallel.ts`)

**Dependencies:** none
**Purpose:** Fetch from multiple data sources in parallel with timeouts and fallbacks.

```typescript
// src/utils/parallel.ts
// Export a function: parallelFetch<T>(tasks: Array<{ name: string, fn: () => Promise<T>, fallback?: T }>)
// Returns: Promise<Record<string, T>>
//
// Behavior:
// - Runs all tasks in parallel using Promise.allSettled
// - For rejected promises, uses fallback value if provided, otherwise null
// - Applies a 10-second timeout per task (AbortController or Promise.race)
// - Logs warnings for failed/timed-out tasks with task name
// - Returns a record keyed by task name
//
// This is critical — enrichment must not fail because one upstream API is slow.
```

### 1.5 — Utility: Normalize (`src/utils/normalize.ts`)

**Dependencies:** none
**Purpose:** Shared helpers for formatting numbers, dates, addresses.

```typescript
// src/utils/normalize.ts
// Export helpers:
// - shortenAddress(address: string): string  → "7xK9...3nFp" (first 4, last 4)
// - formatUsd(value: number): string → "$1,234.56" or "$0.0000245" for small values
// - formatNumber(value: number): string → "1.2M", "450K", "23"
// - formatPercent(value: number): string → "3.2%" (input is already a percentage)
// - formatTimestamp(): string → ISO 8601 UTC timestamp
// - lamportsToSol(lamports: number): number
// - tokenAmountToDecimal(rawAmount: string | number, decimals: number): number
```

---

## PHASE 2: DATA SOURCE CLIENTS (Build in any order, all depend on Phase 1)

### 2.1 — Helius Client (`src/sources/helius.ts`)

**Dependencies:** `src/config.ts`, `src/cache/index.ts`
**Purpose:** Wraps all Helius API calls. This is the primary data source.

```typescript
// src/sources/helius.ts
// Import CONFIG, Cache
//
// Export class HeliusClient with methods:
//
// getAssetsByOwner(address: string): Promise<HeliusAsset[]>
//   - Calls: GET {baseUrl}/addresses/{address}/balances?api-key={key}
//   - Also: POST {rpcUrl} with method "getAssetsByOwner" (DAS API)
//   - Returns: token balances, NFTs, metadata
//
// getTokenAccounts(address: string): Promise<TokenAccount[]>
//   - DAS API: method "getTokenAccountsByOwner"
//   - Returns: all SPL token accounts with balances
//
// getSignaturesForAddress(address: string, limit?: number): Promise<TransactionSignature[]>
//   - Standard Solana RPC via Helius
//   - Default limit: 100
//
// getEnhancedTransaction(signature: string): Promise<EnhancedTransaction>
//   - Calls: GET {baseUrl}/transactions/?api-key={key}&transactions={signature}
//   - Helius enhanced transaction format — pre-parsed with type, description, fee, etc.
//   - This is the key differentiator vs raw RPC — Helius labels swap, transfer, NFT, etc.
//
// getEnhancedTransactions(signatures: string[]): Promise<EnhancedTransaction[]>
//   - Batch version, max 100 per call
//
// searchAssets(params: object): Promise<HeliusAsset[]>
//   - DAS API: method "searchAssets"
//   - For finding NFTs, compressed NFTs, fungible tokens by various filters
//
// IMPORTANT: Every method should:
// 1. Check cache first (key pattern: "helius:{method}:{params_hash}")
// 2. On cache miss, fetch from API
// 3. Cache the result with appropriate TTL from CACHE_TTL
// 4. Handle rate limits gracefully (Helius Pro = 50 RPS). If 429, wait 1s and retry once.
// 5. All API errors should throw typed errors (not swallow silently)
//
// Type definitions: Define interfaces for HeliusAsset, EnhancedTransaction, TokenAccount
// based on Helius API docs. Key fields:
// - EnhancedTransaction: { signature, type, description, fee, feePayer, timestamp,
//     nativeTransfers, tokenTransfers, accountData, events }
// - HeliusAsset: { id, content, authorities, compression, grouping, royalty, creators,
//     ownership, supply, token_info }
```

### 2.2 — Birdeye Client (`src/sources/birdeye.ts`)

**Dependencies:** `src/config.ts`, `src/cache/index.ts`
**Purpose:** Token market data — prices, volume, holder counts.

```typescript
// src/sources/birdeye.ts
// Import CONFIG, Cache
//
// Export class BirdeyeClient with methods:
//
// getTokenPrice(mint: string): Promise<{ value: number, updateUnixTime: number }>
//   - GET {baseUrl}/defi/price?address={mint}
//   - Headers: { "X-API-KEY": apiKey, "x-chain": "solana" }
//   - Cache: tokenPrice TTL
//
// getTokenOverview(mint: string): Promise<TokenOverview>
//   - GET {baseUrl}/defi/token_overview?address={mint}
//   - Returns: price, priceChange24h, volume24h, marketCap, holder, supply, etc.
//   - This is the main token data endpoint
//
// getTokenSecurity(mint: string): Promise<TokenSecurity>
//   - GET {baseUrl}/defi/token_security?address={mint}
//   - Returns: top10HolderPercent, freezeAuthority, mintAuthority, etc.
//   - Critical for risk scoring
//
// getTokenHolders(mint: string, limit?: number): Promise<Holder[]>
//   - GET {baseUrl}/defi/v3/token/holder?address={mint}&limit={limit}
//   - Returns: address, amount, percentage, uiAmount
//
// getWalletPortfolio(address: string): Promise<WalletPortfolio>
//   - GET {baseUrl}/v1/wallet/token_list?wallet={address}
//   - Returns: all tokens held with prices, values, 24h changes
//   - Alternative to Helius for portfolio view (includes USD values directly)
//
// getOHLCV(mint: string, timeframe: string): Promise<OHLCV[]>
//   - GET {baseUrl}/defi/ohlcv?address={mint}&type={timeframe}
//   - For price history analysis in copy-trade-check
//
// All methods: same caching and error handling pattern as HeliusClient.
// Birdeye rate limits: check your plan. Pro = higher limits.
// Headers always include: "X-API-KEY" and "x-chain": "solana"
```

### 2.3 — DeFi Llama Client (`src/sources/defi-llama.ts`)

**Dependencies:** `src/config.ts`, `src/cache/index.ts`
**Purpose:** Protocol TVL and yield data. Free API, no key needed.

```typescript
// src/sources/defi-llama.ts
// Export class DefiLlamaClient with methods:
//
// getProtocolTvl(slug: string): Promise<{ tvl: number, chains: Record<string, number> }>
//   - GET https://api.llama.fi/protocol/{slug}
//   - Returns TVL breakdown by chain
//
// getSolanaProtocols(): Promise<Protocol[]>
//   - GET https://api.llama.fi/protocols
//   - Filter by chain === "Solana"
//   - Cache aggressively (30 min TTL) — this list doesn't change often
//
// getYields(): Promise<YieldPool[]>
//   - GET https://yields.llama.fi/pools
//   - Filter by chain === "Solana"
//   - For matching wallet DeFi positions to current APY
//
// No auth needed. Rate limit is generous (~300/5min).
// Cache TTL: 600 seconds for all DeFi Llama data.
```

### 2.4 — Jupiter Client (`src/sources/jupiter.ts`)

**Dependencies:** `src/config.ts`, `src/cache/index.ts`
**Purpose:** Token prices (backup/cross-reference) and liquidity pool data.

```typescript
// src/sources/jupiter.ts
// Export class JupiterClient with methods:
//
// getPrice(mints: string[]): Promise<Record<string, { price: number }>>
//   - GET https://api.jup.ag/price/v2?ids={mints.join(',')}
//   - Batch price lookup, up to 100 mints per call
//   - Good cross-reference for Birdeye prices
//
// getTokenInfo(mint: string): Promise<JupiterToken>
//   - GET https://tokens.jup.ag/token/{mint}
//   - Returns: name, symbol, decimals, tags, verified status
//
// No auth needed. Very generous rate limits.
```

### 2.5 — Solana RPC Client (`src/sources/solana-rpc.ts`)

**Dependencies:** `src/config.ts`
**Purpose:** Direct Solana RPC calls for SOL balance and basic account info.

```typescript
// src/sources/solana-rpc.ts
// Uses @solana/web3.js Connection class pointed at Helius RPC URL.
//
// Export class SolanaRpc with methods:
//
// getBalance(address: string): Promise<number>
//   - Returns SOL balance in SOL (not lamports)
//
// getAccountInfo(address: string): Promise<AccountInfo | null>
//
// getTransaction(signature: string): Promise<ParsedTransactionWithMeta | null>
//   - Fallback if Helius enhanced tx API is down
//
// getRecentBlockhash(): Promise<string>
//
// Use Helius RPC URL from CONFIG — it's a full Solana RPC node.
```

---

## PHASE 3: ENRICHMENT ENGINE (Build in order — later enrichers depend on earlier ones)

### 3.1 — Labeling Engine (`src/enrichers/labeler.ts`)

**Dependencies:** none (pure logic, receives data as input)
**Purpose:** Takes wallet data, returns label strings. This is proprietary — keep logic tight.

```typescript
// src/enrichers/labeler.ts
//
// Export function labelWallet(data: WalletData): string[]
// where WalletData is:
// {
//   balance_sol: number,
//   portfolio_value_usd: number,
//   token_count: number,
//   nft_count: number,
//   tx_count_30d: number,
//   first_tx_date: string | null,
//   defi_positions: { protocol: string, type: string, value_usd: number }[],
//   top_holdings: { symbol: string, usd_value: number, pct_portfolio: number }[],
//   swap_count_30d: number,
//   daily_tx_counts: number[],  // array of tx counts per day over 30d
//   protocols_interacted: string[],
//   stablecoin_pct: number,
// }
//
// Label rules (apply all that match, return as string array):
//
// "whale"           → any single token holding > $100,000 USD
// "active_trader"   → swap_count_30d > 50
// "defi_user"       → defi_positions from 2+ distinct protocols
// "nft_collector"   → nft_count >= 10
// "new_wallet"      → first_tx_date is within last 30 days
// "dormant"         → tx_count_30d === 0 AND last tx > 90 days ago
// "airdrop_farmer"  → protocols_interacted includes 5+ unverified/new protocols in 30d
// "bot_suspect"     → any day in daily_tx_counts > 500 OR stddev of tx timing < 2 seconds
// "stablecoin_heavy"→ stablecoin_pct > 60
// "lp_provider"     → defi_positions includes 2+ LP type positions
// "smart_money"     → (computed externally by copy-trade analyzer, not here)
//
// Return array sorted alphabetically.
```

### 3.2 — Risk Scorer (`src/enrichers/risk-scorer.ts`)

**Dependencies:** none (pure logic)
**Purpose:** Returns 0.0–1.0 risk score for a wallet. Higher = riskier.

```typescript
// src/enrichers/risk-scorer.ts
//
// Export function scoreWalletRisk(data: RiskInput): { score: number, factors: string[] }
// where RiskInput includes:
// {
//   wallet_age_days: number,
//   tx_diversity: number,         // unique program IDs interacted with / total txs
//   protocol_breadth: number,     // count of distinct protocols
//   concentration: number,        // % of portfolio in top holding
//   flagged_associations: number, // count of txs with known scam/exploit addresses
//   labels: string[],             // from labeler
// }
//
// Scoring (each factor adds to a 0-1 range):
// - wallet_age_days < 7: +0.20
// - wallet_age_days < 30: +0.10
// - concentration > 80%: +0.20
// - concentration > 50%: +0.10
// - flagged_associations > 0: +0.25
// - labels includes "bot_suspect": +0.15
// - labels includes "airdrop_farmer": +0.10
// - tx_diversity < 0.1: +0.10
// - protocol_breadth < 2: +0.05
//
// Clamp final score to [0.0, 1.0].
// Return both score and array of factor descriptions that contributed.
```

### 3.3 — Wallet Profiler (`src/enrichers/wallet-profiler.ts`)

**Dependencies:** `src/sources/helius.ts`, `src/sources/birdeye.ts`, `src/sources/solana-rpc.ts`, `src/sources/jupiter.ts`, `src/enrichers/labeler.ts`, `src/enrichers/risk-scorer.ts`, `src/utils/parallel.ts`, `src/cache/index.ts`
**Purpose:** The core enrichment function for wallet data.

```typescript
// src/enrichers/wallet-profiler.ts
//
// Export class WalletProfiler with method:
// async enrich(address: string, depth: "light" | "full"): Promise<WalletEnrichment>
//
// FLOW:
// 1. Check cache for "wallet:{address}:{depth}" — return if fresh
// 2. Use parallelFetch to simultaneously fetch:
//    a. SOL balance (SolanaRpc.getBalance)
//    b. Token accounts (Helius DAS getAssetsByOwner)
//    c. Portfolio with prices (Birdeye getWalletPortfolio)
//    d. Recent signatures (Helius getSignaturesForAddress, limit 100)
//    e. If depth === "full": enhanced transactions for last 50 sigs (Helius)
// 3. Cross-reference Helius assets with Birdeye prices for USD values
// 4. Compute portfolio stats:
//    - total portfolio value USD
//    - top holdings (top 10 by USD value)
//    - token count, NFT count
//    - stablecoin percentage (USDC, USDT, UXD, PYUSD mints)
// 5. Compute activity stats from signatures:
//    - tx_count_30d
//    - first_tx_date (from oldest signature, limited by fetch depth)
//    - swap_count_30d (from enhanced tx type === "SWAP")
//    - daily_tx_counts (group by day)
//    - protocols_interacted (unique program IDs)
// 6. If depth === "full": identify DeFi positions:
//    - Parse enhanced transactions for staking, LP, lending interactions
//    - Match against known Solana protocol program IDs:
//      * Marinade: MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD
//      * Jito: Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb
//      * Raydium: 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8
//      * Orca: whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc
//      * Kamino: 6LtLpnUFNByNXLyCoK9wA2MykKAmQNZKBdY8s47dehDc
//      * Jupiter: JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4
//      * marginfi: MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA
//      * Drift: dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH
//    - Estimate position values from token accounts + known pool structures
// 7. Run labelWallet() with computed data
// 8. Run scoreWalletRisk() with computed data
// 9. Identify connected wallets (from transfer patterns in enhanced txs)
// 10. Assemble WalletEnrichment object, cache it, return it
//
// WalletEnrichment type:
// {
//   address: string,
//   sol_balance: number,
//   portfolio_value_usd: number,
//   token_count: number,
//   top_holdings: Array<{ mint: string, symbol: string, balance: number, usd_value: number }>,
//   nft_count: number,
//   defi_positions: Array<{ protocol: string, type: string, value_usd: number }>,
//   tx_count_30d: number,
//   first_tx_date: string | null,
//   labels: string[],
//   risk_score: number,
//   risk_factors: string[],
//   connected_wallets: string[],
//   last_updated: string,
// }
//
// LIGHT vs FULL:
// - light: skip DeFi position parsing, skip connected wallet detection, limit to top 5 holdings
// - full: everything above
```

### 3.4 — Token Analyzer (`src/enrichers/token-analyzer.ts`)

**Dependencies:** `src/sources/helius.ts`, `src/sources/birdeye.ts`, `src/sources/jupiter.ts`, `src/utils/parallel.ts`, `src/cache/index.ts`

```typescript
// src/enrichers/token-analyzer.ts
//
// Export class TokenAnalyzer with method:
// async enrich(mint: string, includeHolders?: boolean): Promise<TokenEnrichment>
//
// FLOW:
// 1. Check cache for "token:{mint}"
// 2. parallelFetch:
//    a. Birdeye getTokenOverview(mint)
//    b. Birdeye getTokenSecurity(mint)
//    c. Jupiter getTokenInfo(mint) — for verified status, metadata
//    d. Jupiter getPrice([mint]) — cross-reference
//    e. If includeHolders: Birdeye getTokenHolders(mint, 20)
// 3. Compute risk_flags array:
//    - "high_concentration" → top 10 holders > 40% supply
//    - "low_liquidity" → total pool TVL < $50K
//    - "mint_authority_active" → mintAuthority is not null
//    - "freeze_authority_active" → freezeAuthority is not null
//    - "unverified" → not in Jupiter verified token list
//    - "low_holder_count" → holder_count < 100
//    - "high_volatility" → abs(price_change_24h) > 20%
// 4. Assemble TokenEnrichment, cache, return
//
// TokenEnrichment type:
// {
//   mint: string,
//   symbol: string,
//   name: string,
//   decimals: number,
//   supply: number,
//   holder_count: number,
//   price_usd: number,
//   market_cap: number,
//   volume_24h: number,
//   price_change_24h: number,
//   top_holders?: Array<{ address: string, balance: number, pct_supply: number }>,
//   liquidity_pools: Array<{ dex: string, pair: string, tvl: number }>,
//   risk_flags: string[],
//   verified: boolean,
//   last_updated: string,
// }
```

### 3.5 — Transaction Parser (`src/enrichers/tx-parser.ts`)

**Dependencies:** `src/sources/helius.ts`, `src/cache/index.ts`

```typescript
// src/enrichers/tx-parser.ts
//
// Export class TxParser with method:
// async enrich(signature: string): Promise<TransactionEnrichment>
//
// FLOW:
// 1. Check cache for "tx:{signature}"
// 2. Fetch Helius enhanced transaction (getEnhancedTransaction)
// 3. Map to clean structure:
//    - type: the Helius type (SWAP, TRANSFER, NFT_SALE, NFT_LISTING, etc.)
//    - description: Helius description field (human-readable)
//    - Detect protocol from programIds in accountData
//    - Extract token transfers with amounts and directions
//    - Extract native (SOL) transfers
// 4. Cache forever (transactions are immutable), return
//
// TransactionEnrichment type:
// {
//   signature: string,
//   type: string,
//   description: string,
//   protocol: string | null,
//   fee_sol: number,
//   fee_payer: string,
//   timestamp: string,
//   success: boolean,
//   native_transfers: Array<{ from: string, to: string, amount_sol: number }>,
//   token_transfers: Array<{ from: string, to: string, mint: string, symbol?: string, amount: number }>,
//   accounts_involved: string[],
//   last_updated: string,
// }
```

---

## PHASE 4: LLM FORMATTERS (Build after Phase 3)

### 4.1 — Format Router (`src/formatters/index.ts`)

**Dependencies:** none
**Purpose:** Routes enrichment output to the appropriate format.

```typescript
// src/formatters/index.ts

export type Format = 'json' | 'llm' | 'both';

export function formatResponse<T>(
  data: T,
  format: Format,
  formatter: (d: T) => string
): T | { briefing: string; content_type: string } | (T & { llm_summary: string }) {
  switch (format) {
    case 'json':
      return data;
    case 'llm':
      return { briefing: formatter(data), content_type: 'text/markdown' };
    case 'both':
      return { ...data, llm_summary: formatter(data) };
  }
}
```

### 4.2 — Wallet Formatter (`src/formatters/llm-wallet.ts`)

**Dependencies:** `src/utils/normalize.ts`
**Purpose:** Transforms WalletEnrichment into a 150-300 token markdown briefing.

```typescript
// src/formatters/llm-wallet.ts
//
// Export function formatWalletBriefing(data: WalletEnrichment): string
//
// Template (deterministic, no LLM calls):
// ---
// ## Wallet Profile: {shortenAddress(address)}
//
// {walletAge} Solana wallet. Holds {sol_balance} SOL ({formatUsd(sol_value)}) and {token_count} SPL tokens.
// Portfolio value: ~{formatUsd(portfolio_value_usd)} across tokens, NFTs, and DeFi positions.
//
// Top holdings: {top 3-5 holdings as "SYMBOL ($VALUE)"}.{ if nft_count > 0: " Holds {nft_count} NFTs." }
//
// {if defi_positions.length > 0: "DeFi activity: " + summarize positions}
// Classified as {labels.join(', ')}.
//
// {tx_count_30d} transactions in 30 days. Risk score: {risk_score}/1.0 ({risk_level}).
// {if risk_factors.length > 0: summarize top factors}
// {if connected_wallets.length > 0: "{connected_wallets.length} connected wallets identified."}
//
// Data as of: {last_updated}
// ---
//
// Rules:
// - risk_level: < 0.2 = "low", < 0.5 = "moderate", < 0.75 = "elevated", >= 0.75 = "high"
// - walletAge: computed from first_tx_date ("Active since March 2022" or "New wallet (created 5 days ago)")
// - Always include timestamp
// - Keep under 300 tokens
```

### 4.3 — Token Formatter (`src/formatters/llm-token.ts`)

**Dependencies:** `src/utils/normalize.ts`

```typescript
// src/formatters/llm-token.ts
//
// Export function formatTokenBriefing(data: TokenEnrichment): string
//
// Template:
// ---
// ## Token: {symbol} ({name})
//
// Solana SPL token. Price: {formatUsd(price_usd)} ({price_change direction} {abs(price_change_24h)}% 24h).
// Market cap: {formatUsd(market_cap)}. 24h volume: {formatUsd(volume_24h)}. {formatNumber(holder_count)} holders.
//
// Liquidity: {summarize top pool — dex, pair, TVL}. {assessment: "Deep" / "Moderate" / "Thin" relative to mcap}.
//
// {if top_holders: "Top holder controls {pct}% of supply." or "Well distributed."}
// {if verified: "Verified on Jupiter." else "Not verified on Jupiter — exercise caution."}
//
// Risk flags: {risk_flags.join(', ') or "None identified."}.
//
// Data as of: {last_updated}
// ---
```

### 4.4 — Transaction Formatter (`src/formatters/llm-transaction.ts`)

**Dependencies:** `src/utils/normalize.ts`

```typescript
// src/formatters/llm-transaction.ts
//
// Export function formatTransactionBriefing(data: TransactionEnrichment): string
//
// Template:
// ---
// ## Transaction: {shortenSignature(signature)}
//
// Type: {type}. {description}.
// {if protocol: "Protocol: {protocol}."} Fee: {fee_sol} SOL. Payer: {shortenAddress(fee_payer)}.
// Status: {success ? "Confirmed" : "Failed"}. Time: {timestamp}.
//
// {if native_transfers.length > 0: summarize SOL movements}
// {if token_transfers.length > 0: summarize token movements}
// {accounts_involved.length} accounts involved.
//
// Data as of: {last_updated}
// ---
```

---

## PHASE 5: ENTRYPOINTS (Build in order — these are the API endpoints)

### 5.1 — Wallet Schemas (`src/schemas/wallet.ts`)

**Dependencies:** `src/schemas/common.ts`

```typescript
// src/schemas/wallet.ts
import { z } from 'zod';
import { FormatSchema, DepthSchema, SolanaAddressSchema } from './common';

export const EnrichWalletInput = z.object({
  address: SolanaAddressSchema,
  depth: DepthSchema,
  format: FormatSchema,
});

// Export the WalletEnrichment output schema as a Zod object matching
// the WalletEnrichment type from wallet-profiler.ts
// (This enables Lucid's automatic schema generation for the Agent Card)
```

### 5.2 — Token Schemas (`src/schemas/token.ts`)

```typescript
// src/schemas/token.ts
// Similar pattern: EnrichTokenInput with mint, include_holders, holder_limit, format
// TokenEnrichment output schema
```

### 5.3 — Wallet Entrypoint (`src/entrypoints/wallet.ts`)

**Dependencies:** `src/enrichers/wallet-profiler.ts`, `src/formatters/index.ts`, `src/formatters/llm-wallet.ts`, `src/schemas/wallet.ts`
**Purpose:** Defines the `/enrich/wallet` Lucid entrypoint.

```typescript
// src/entrypoints/wallet.ts
//
// Export a function that takes the agent instance and registers the entrypoint.
// Follow the Lucid pattern exactly:
//
// import { z } from 'zod';
// import { EnrichWalletInput } from '../schemas/wallet';
// import { WalletProfiler } from '../enrichers/wallet-profiler';
// import { formatResponse } from '../formatters';
// import { formatWalletBriefing } from '../formatters/llm-wallet';
//
// const profiler = new WalletProfiler(/* inject data source clients */);
//
// export function registerWalletEntrypoint(agent: AgentInstance) {
//   agent.entrypoint({
//     name: 'enrich-wallet',
//     description: 'Full wallet profile with holdings, DeFi positions, labels, and risk score',
//     input: EnrichWalletInput,
//     output: WalletEnrichmentSchema,  // Zod schema
//     price: { amount: '5000', currency: 'USDC' },  // $0.005 — uses full price, override for light
//     handler: async ({ input }) => {
//       const data = await profiler.enrich(input.address, input.depth);
//       return formatResponse(data, input.format, formatWalletBriefing);
//     },
//   });
// }
//
// NOTE on pricing: Lucid may resolve price from the entrypoint `price` field.
// If you need different prices for light vs full, you have two options:
// a) Register two entrypoints: 'enrich-wallet-light' and 'enrich-wallet-full'
// b) Use a single entrypoint at the higher price
// Prefer option (a) for clarity. Register both in this file.
```

### 5.4 — Token Entrypoint (`src/entrypoints/token.ts`)

**Dependencies:** `src/enrichers/token-analyzer.ts`, `src/formatters/index.ts`, `src/formatters/llm-token.ts`, `src/schemas/token.ts`
**Purpose:** `/enrich/token`

```typescript
// Same pattern as wallet entrypoint.
// name: 'enrich-token'
// price: { amount: '3000', currency: 'USDC' }
// handler: tokenAnalyzer.enrich(mint) → formatResponse
```

### 5.5 — Transaction Entrypoint (`src/entrypoints/transaction.ts`)

**Dependencies:** `src/enrichers/tx-parser.ts`, `src/formatters/index.ts`, `src/formatters/llm-transaction.ts`
**Purpose:** `/enrich/transaction`

```typescript
// name: 'enrich-transaction'
// price: { amount: '2000', currency: 'USDC' }
// handler: txParser.enrich(signature) → formatResponse
```

---

## PHASE 6: AGENT ASSEMBLY (`src/agent.ts` and `src/index.ts`)

### 6.1 — Agent Definition (`src/agent.ts`)

**Dependencies:** All entrypoints from Phase 5
**Purpose:** Creates the Lucid agent with all extensions and registers all entrypoints.

```typescript
// src/agent.ts
//
// This is the main agent definition file.
// Follow the Lucid pattern:
//
// import { createAgent } from '@lucid-agents/core';
// import { http } from '@lucid-agents/http';
// import { payments } from '@lucid-agents/payments';
// import { identity } from '@lucid-agents/identity';
//
// const agent = createAgent({
//   name: 'SolEnrich',
//   description: 'Solana onchain data enrichment. Wallet profiling, token analysis, risk scoring. JSON for agents, natural language for LLMs.',
//   version: '1.0.0',
// })
// .use(http())
// .use(payments({
//   address: CONFIG.solana.walletAddress,
//   network: 'solana',
//   facilitatorUrl: CONFIG.facilitator.url,
// }))
// .use(identity({
//   // ERC-8004 identity config — will be populated after registration in Phase 8
// }));
//
// // Initialize data source clients
// const helius = new HeliusClient();
// const birdeye = new BirdeyeClient();
// const jupiter = new JupiterClient();
// const defiLlama = new DefiLlamaClient();
// const solanaRpc = new SolanaRpc();
// const cache = new Cache();
//
// // Pass clients to enrichers (dependency injection)
// const walletProfiler = new WalletProfiler(helius, birdeye, jupiter, solanaRpc, cache);
// const tokenAnalyzer = new TokenAnalyzer(helius, birdeye, jupiter, cache);
// const txParser = new TxParser(helius, cache);
//
// // Register all entrypoints
// registerWalletEntrypoint(agent, walletProfiler);
// registerTokenEntrypoint(agent, tokenAnalyzer);
// registerTransactionEntrypoint(agent, txParser);
//
// export { agent };
//
// IMPORTANT: If the Lucid SDK's createAgent/extension APIs differ from what's shown here
// (check the installed package's types or README), adapt to match. The patterns above
// are based on the documented API but the SDK is actively developing.
// Key principle: use the framework's native patterns, don't fight them.
```

### 6.2 — Server Entry (`src/index.ts`)

**Dependencies:** `src/agent.ts`
**Purpose:** Hono server setup, starts listening.

```typescript
// src/index.ts
//
// Import { agent } from './agent';
// Import the Hono adapter from @lucid-agents/hono
//
// Adapt the agent to Hono:
// const app = adapt(agent); // or however the Hono adapter works
//
// Add a manual /health endpoint if Lucid doesn't auto-generate one:
// app.get('/health', (c) => c.json({ status: 'ok', agent: 'SolEnrich', version: '1.0.0' }));
//
// Export default for Cloudflare Workers:
// export default app;
//
// Or for local dev with Bun:
// export default {
//   port: process.env.PORT || 3000,
//   fetch: app.fetch,
// };
//
// NOTE: Lucid may handle the Hono setup differently. Check the generated scaffold
// from Phase 0.2 for the correct pattern and adapt this file to match.
```

---

## PHASE 7: VERIFICATION (Run after Phase 6)

### 7.1 — Start the server

```bash
bun run dev
```

### 7.2 — Verify basic health

```bash
curl http://localhost:3000/health
# Expected: { "status": "ok", "agent": "SolEnrich", "version": "1.0.0" }

curl http://localhost:3000/.well-known/agent.json
# Expected: Agent Card JSON with entrypoints listed
```

### 7.3 — Test without payment (expect 402)

```bash
curl -X POST http://localhost:3000/entrypoints/enrich-wallet/invoke \
  -H "Content-Type: application/json" \
  -d '{"input": {"address": "vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg", "format": "json"}}'

# Expected: HTTP 402 Payment Required
# Response should include payment instructions (price, asset, network, facilitator)
```

### 7.4 — Test enrichment directly (bypass payment for dev)

Create a quick test script:

```typescript
// test/test-enrichment.ts
// Import WalletProfiler, TokenAnalyzer, TxParser directly
// Call each enricher with known addresses:
//
// Wallet test: vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg (Solana foundation)
// Token test: DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263 (BONK mint)
// Tx test: (find a recent transaction signature from Solscan)
//
// For each: log the JSON response and the LLM briefing
// Verify: all fields populated, labels make sense, risk score is in range, LLM briefing is readable
```

```bash
bun run test/test-enrichment.ts
```

### 7.5 — Acceptance criteria for Phase 7

- [ ] Server starts without errors
- [ ] `/health` returns 200
- [ ] Agent Card is auto-generated at `/.well-known/agent.json`
- [ ] Entrypoints return 402 without payment
- [ ] Wallet enrichment returns complete data for a known address
- [ ] Token enrichment returns price, holders, risk flags
- [ ] Transaction enrichment returns parsed type and transfers
- [ ] LLM format produces readable markdown briefing under 300 tokens
- [ ] `format: "both"` returns JSON with `llm_summary` field
- [ ] Cache hit on second request for same address (check response time)

---

## PHASE 8: IDENTITY & DISCOVERY

### 8.1 — Register 8004-solana Agent Identity (`identity/register.ts`)

**Dependencies:** 8004-solana package, PINATA_JWT env var, funded Solana wallet

```typescript
// identity/register.ts
// Run once to register the agent on the 8004 registry.
//
// import { SolanaSDK, buildRegistrationFileJson, ServiceType, IPFSClient } from '8004-solana';
// import { Keypair } from '@solana/web3.js';
//
// const signer = Keypair.fromSecretKey(/* decode from SOLANA_PRIVATE_KEY */);
// const sdk = new SolanaSDK({ cluster: 'devnet', signer });  // devnet first, mainnet later
// const ipfs = new IPFSClient({ pinataEnabled: true, pinataJwt: process.env.PINATA_JWT });
//
// Step 1: Build collection metadata (one-time, for Parallax Labs agent collection)
// const collectionMeta = buildCollectionMetadataJson({
//   name: 'Parallax Labs Agents',
//   description: 'Onchain agentic services by Parallax Labs',
//   category: 'data',
//   tags: ['solana', 'enrichment', 'data', 'x402'],
//   project: { name: 'Parallax Labs', socials: { website: 'https://parallaxlabs.xyz', x: 'parallaxlabs' } }
// });
// const collectionUri = `ipfs://${await ipfs.addJson(collectionMeta)}`;
// const collection = await sdk.createCollection(collectionMeta.name, collectionUri);
//
// Step 2: Build agent metadata
// const agentMeta = buildRegistrationFileJson({
//   name: 'SolEnrich',
//   description: 'Solana onchain data enrichment agent. Wallet profiling, token analysis, DeFi positions, risk scoring. JSON for agents, natural language for LLMs. Powered by x402.',
//   image: 'ipfs://...',  // Upload an agent avatar first
//   services: [
//     { type: ServiceType.MCP, value: 'https://solenrich.parallaxlabs.xyz/mcp' },
//     { type: ServiceType.A2A, value: 'https://solenrich.parallaxlabs.xyz/.well-known/agent-card.json' },
//   ],
//   skills: ['data_analysis/blockchain_analysis/blockchain_analysis'],
//   domains: ['technology/blockchain/blockchain'],
// });
// const agentUri = `ipfs://${await ipfs.addJson(agentMeta)}`;
// const agent = await sdk.registerAgent(agentUri);
//
// Step 3: Set operational wallet (separate from signer for security)
// const opWallet = Keypair.generate();
// await sdk.setAgentWallet(agent.asset, opWallet);
//
// console.log('Agent registered:', agent.asset.toBase58());
// console.log('Op wallet:', opWallet.publicKey.toBase58());
// Save these values to .env
```

```bash
bun run identity/register.ts
```

### 8.2 — Optimize Agent Card

After the agent is running, verify the auto-generated Agent Card at `/.well-known/agent.json`.

If Lucid's auto-generated card is missing fields, supplement it. The card should include:
- All entrypoint names, descriptions, input schemas, and prices
- `capabilities` array with: wallet-enrichment, token-analysis, transaction-parsing, risk-scoring, llm-optimized-data
- `chains: ["solana"]`
- `formats: ["json", "llm", "both"]`
- `pricing` object with min/max and currency
- `identity.erc8004` with the agent asset pubkey from registration

### 8.3 — Seed Reputation (`deploy/seed-reputation.ts`)

```typescript
// deploy/seed-reputation.ts
// After agent is deployed and serving real responses:
// 1. Use 8004-solana SDK to give initial feedback
// 2. Have Parallax's other agents call SolEnrich and leave feedback
//
// import { SolanaSDK, Tag } from '8004-solana';
// await sdk.giveFeedback(agentAsset, {
//   value: '90',
//   tag1: Tag.quality,  // or 'quality'
//   tag2: Tag.day,
// });
```

---

## PHASE 9: PREMIUM & AMBITIOUS ENDPOINTS (Build after Phase 7 passes)

These follow the exact same pattern as Phase 3-5. For each:
1. Create enricher in `src/enrichers/`
2. Create LLM formatter in `src/formatters/`
3. Create Zod schemas in `src/schemas/`
4. Create entrypoint in `src/entrypoints/`
5. Register in `src/agent.ts`

### 9.1 — Whale Watch (`src/enrichers/whale-watch.ts` + entrypoint)

- Input: mint, threshold_usd (default 10000), lookback_hours (default 24)
- Logic: Fetch recent large transactions for token via Helius, filter by USD value > threshold
- Label whale wallets using the labeler
- Compute accumulation vs distribution (net flow direction)
- Entrypoint name: `enrich-whale-watch`, price: 10000

### 9.2 — Batch Enrichment (`src/entrypoints/batch.ts`)

- Input: addresses array, type (wallet | token), depth, format
- Logic: Map to wallet-profiler or token-analyzer, run in parallel with concurrency limit of 5
- Price: 3000 per address (calculate total dynamically)
- Entrypoint name: `enrich-batch`

### 9.3 — Graph Mapper (`src/enrichers/graph-mapper.ts` + entrypoint)

- Input: address, depth (1 or 2 hops), min_interactions
- Logic: Fetch enhanced transactions, build adjacency list, label known entities, detect clusters (bidirectional frequent transfers), flag suspicious patterns
- Output: nodes array, edges array, clusters array
- LLM format: "Wallet X has strong connections to 3 whales and 2 DEX pools. Cluster of 4 wallets with bidirectional transfers detected — possible coordinated activity."
- Entrypoint name: `enrich-graph`, price: 15000

### 9.4 — Copy Trade Check (`src/enrichers/copy-trade-analyzer.ts` + entrypoint)

- Input: address, lookback_days (default 30)
- Logic: Fetch swap transactions, match buy/sell pairs, compute win rate, PnL, hold time, consistency
- Needs Birdeye historical prices to compute entry/exit PnL
- Entrypoint name: `enrich-copy-trade`, price: 20000

### 9.5 — Token Due Diligence (`src/enrichers/due-diligence.ts` + entrypoint)

- Composite endpoint: calls token-analyzer + whale-watch + holder analysis
- LLM format is a 400-word research briefing
- Entrypoint name: `enrich-due-diligence`, price: 25000

### 9.6 — Natural Language Query (`src/entrypoints/query.ts`)

- Input: `{ question: string, context?: { wallets?: string[], tokens?: string[] } }`
- This is the ONLY endpoint that uses LLM inference
- Route LLM calls through Daydreams Router (if available) or direct API
- Logic: Parse intent → identify which enrichers to call → run them → generate answer
- Entrypoint name: `query`, price: 10000
- Implementation priority: LAST (most complex, least critical for launch)

---

## PHASE 10: MCP SERVER (Build after Phase 7)

### 10.1 — MCP Server (`mcp/server.ts`)

```typescript
// mcp/server.ts
// Thin MCP wrapper that exposes SolEnrich endpoints as MCP tools.
// Uses the MCP SDK (@modelcontextprotocol/sdk).
//
// Tools to register:
// - enrich_wallet: calls /enrich/wallet with format=llm
// - enrich_token: calls /enrich/token with format=llm
// - enrich_transaction: calls /enrich/transaction with format=llm
// - query_solana: calls /query (if implemented)
//
// The MCP server makes HTTP requests to the running SolEnrich agent.
// x402 payment happens automatically via the agent's paywall.
// The MCP server needs its own wallet to pay for requests.
//
// This turns every Claude/ChatGPT desktop user into a paying customer.
```

```bash
bun add @modelcontextprotocol/sdk
```

---

## PHASE 11: DEPLOYMENT

### 11.1 — Cloudflare Workers (`deploy/wrangler.toml`)

```toml
name = "solenrich"
main = "src/index.ts"
compatibility_date = "2024-12-01"
node_compat = true

[vars]
NETWORK = "solana"

# Secrets (set via wrangler secret put):
# HELIUS_API_KEY, BIRDEYE_API_KEY, SOLANA_PRIVATE_KEY,
# AGENT_WALLET_ADDRESS, UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
```

```bash
# Deploy
bunx wrangler deploy

# Set secrets
bunx wrangler secret put HELIUS_API_KEY
bunx wrangler secret put BIRDEYE_API_KEY
bunx wrangler secret put SOLANA_PRIVATE_KEY
bunx wrangler secret put AGENT_WALLET_ADDRESS
bunx wrangler secret put UPSTASH_REDIS_REST_URL
bunx wrangler secret put UPSTASH_REDIS_REST_TOKEN
```

### 11.2 — Post-deploy verification

```bash
curl https://solenrich.<your-workers-subdomain>.workers.dev/health
curl https://solenrich.<your-workers-subdomain>.workers.dev/.well-known/agent.json
```

### 11.3 — Custom domain (optional)

Point `solenrich.parallaxlabs.xyz` to Cloudflare Workers via CNAME.

---

## PHASE 12: LAUNCH CHECKLIST

- [ ] All Phase 7 acceptance criteria pass on production
- [ ] 8004-solana identity registered (Phase 8.1)
- [ ] Agent Card optimized with all capabilities (Phase 8.2)
- [ ] Initial reputation seeded (Phase 8.3)
- [ ] At least 3 core entrypoints working (wallet, token, transaction)
- [ ] LLM format tested and produces clean briefings
- [ ] MCP server working and tested with Claude Desktop
- [ ] README.md with API docs, example requests, pricing table
- [ ] Announce on Farcaster / X / Daydreams community
- [ ] List on XGATE (submit Agent Card URL)
- [ ] List MCP server on MCP directories (Smithery, mcp.run, etc.)

---

## IMPLEMENTATION NOTES FOR CLAUDE CODE

1. **If a Lucid SDK API doesn't match what's documented here**, adapt to the actual SDK. Check the installed package types (`node_modules/@lucid-agents/*/dist/index.d.ts`) for the real API surface. This PRD is based on docs as of Feb 2026 — the SDK evolves fast.

2. **If a package fails to install**, check npm for the latest name. Try `@lucid-dreams/agent-kit` as an alternative if `@lucid-agents/*` packages have been consolidated.

3. **Start with the happy path.** Get wallet enrichment returning data before adding error handling, caching, or premium endpoints. Iterate.

4. **Test with known addresses.** Use `vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg` for wallet tests, `DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263` (BONK) for token tests.

5. **Cache is optional for v1.** If Upstash setup is slowing you down, use the in-memory fallback and add Redis later.

6. **Pricing amounts are in base units** (USDC has 6 decimals). `5000` = $0.005. Verify this matches how Lucid expects pricing — some SDKs use decimal strings like `"0.005"` instead.

7. **Birdeye API headers are critical.** Every request needs `X-API-KEY` and `x-chain: solana`. Missing headers = silent failures.

8. **Helius DAS API** uses JSON-RPC format (POST with `method` and `params`), not REST. The enhanced transaction endpoint IS REST. Don't mix them up.

9. **The LLM formatter is pure string interpolation.** No template engine, no LLM calls. Just template literals with conditional sections. Keep it simple.

10. **The /query endpoint (Phase 9.6) is optional for launch.** Ship without it if time is tight. The core value is in structured enrichment, not NL queries.
