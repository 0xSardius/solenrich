import { createAgentApp } from "@lucid-agents/hono";
import { createAgent } from "@lucid-agents/core";
import { http } from "@lucid-agents/http";
// NOTE: Lucid's payments plugin only supports EVM (ExactEvmScheme).
// We handle Solana x402 payments manually with @x402/svm below.

// x402 payment middleware
import { paymentMiddleware } from "@x402/hono";
import { x402ResourceServer } from "@x402/hono";
import { ExactSvmScheme } from "@x402/svm/exact/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import type { RoutesConfig } from "@x402/core/server";

// Data source clients
import { Cache } from "../cache";
import { HeliusClient } from "../sources/helius";
import { DexScreenerClient } from "../sources/dexscreener";
import { JupiterClient } from "../sources/jupiter";
import { SolanaRpcClient } from "../sources/solana-rpc";
import { DefiLlamaClient } from "../sources/defi-llama";
import { BirdeyeClient } from "../sources/birdeye";

// Enrichers
import { WalletProfiler } from "../enrichers/wallet-profiler";
import { TokenAnalyzer } from "../enrichers/token-analyzer";
import { TxParser } from "../enrichers/tx-parser";
import { WhaleWatcher } from "../enrichers/whale-watch";
import { GraphMapper } from "../enrichers/graph-mapper";
import { CopyTradeAnalyzer } from "../enrichers/copy-trade-analyzer";
import { DueDiligenceAnalyzer } from "../enrichers/due-diligence";
import { ProtocolAnalyzer } from "../enrichers/protocol-analyzer";
import { PerpsAnalyzer } from "../enrichers/perps-analyzer";
import { JupiterPerpsClient } from "../sources/jupiter-perps";
import { TrendingSignalsAnalyzer } from "../enrichers/trending-signals";
import { SmartMoneyAnalyzer } from "../enrichers/smart-money-flow";
import { TrenchesSmartMoneyAnalyzer } from "../enrichers/trenches-smart-money";
import { RunnerDetector } from "../enrichers/runner-detector";

// Entrypoint registration
import { registerWalletEntrypoints } from "../entrypoints/wallet";
import { registerTokenEntrypoints } from "../entrypoints/token";
import { registerTransactionEntrypoint } from "../entrypoints/transaction";
import { registerWhaleWatchEntrypoint } from "../entrypoints/whale-watch";
import { registerBatchEntrypoint } from "../entrypoints/batch";
import { registerGraphEntrypoint } from "../entrypoints/graph";
import { registerCopyTradeEntrypoint } from "../entrypoints/copy-trade";
import { registerDueDiligenceEntrypoint } from "../entrypoints/due-diligence";
import { registerQueryEntrypoint } from "../entrypoints/query";
import { registerCompareEntrypoints } from "../entrypoints/compare";
import { registerTrendEntrypoints } from "../entrypoints/trend";
import { registerDiscoveryEntrypoint } from "../entrypoints/discovery";
import { registerProtocolEntrypoint } from "../entrypoints/protocol";
import { registerPerpsEntrypoints } from "../entrypoints/perps";
import { registerPerpsCrossVenueEntrypoint } from "../entrypoints/perps-cross-venue";
import { registerPerpsVenueComparisonEntrypoint } from "../entrypoints/perps-venue-comparison";
import { registerPerpsBasisSignalEntrypoint } from "../entrypoints/perps-basis-signal";
import { AdrenaClient } from "../sources/adrena";
import { PerpReferenceClient } from "../sources/perp-reference";
import { FlashPerpsClient } from "../sources/flash-perps";
import { HyperliquidAnalyzer } from "../enrichers/hyperliquid-analyzer";
import { HyperliquidSmartMoneyAnalyzer } from "../enrichers/hyperliquid-smart-money";
import { registerHyperliquidEntrypoints } from "../entrypoints/hyperliquid";
import { PerpsCrossVenueAnalyzer } from "../enrichers/perps-cross-venue";
import { PerpsVenueComparator } from "../enrichers/perps-venue-comparison";
import { PerpsBasisAnalyzer } from "../enrichers/perps-basis-signal";
import { CollectorCryptClient } from "../sources/collector-crypt";
import { GachaAnalyzer } from "../enrichers/gacha-analyzer";
import { registerGachaEntrypoint } from "../entrypoints/gacha";
import { registerOrchestrationEntrypoints } from "../entrypoints/orchestration";
import { registerTrenchesEntrypoints, registerTrenchesScanEntrypoint, registerTrenchesCheckEntrypoint } from "../entrypoints/trenches";
import { TrenchesScanOrchestrator } from "../enrichers/trenches-scan";
import { TrenchesCheckAnalyzer } from "../enrichers/trenches-check";
import { registerExitSignalEntrypoint } from "../entrypoints/exit";
import { ExitSignalAnalyzer } from "../enrichers/exit-analyzer";
import { registerRunnerEntrypoint } from "../entrypoints/runner";
import { registerFeedEntrypoint } from "../entrypoints/feed";
import { FeedStore } from "../enrichers/feed-store";
import { registerSignalEntrypoint } from "../entrypoints/signals";
import { SignalTracker } from "../enrichers/signal-tracker";
import { registerAlertEntrypoint } from "../entrypoints/alerts";
import { AlertChecker } from "../enrichers/alert-checker";
import { CONFIG, PRICING } from "../config";

// --- Agent setup ---

const agent = await createAgent({
  name: process.env.AGENT_NAME ?? "SolEnrich",
  version: process.env.AGENT_VERSION ?? "1.0.0",
  description:
    process.env.AGENT_DESCRIPTION ??
    "Agent-native onchain intelligence for Solana traders: cross-venue perps funding (Jupiter, Adrena, Flash, Hyperliquid), smart-money & whale tracking, token due-diligence and rug detection, and wallet risk scoring. Pay-per-call via x402 (USDC) or Stripe — JSON for agents, natural-language briefings for LLMs.",
})
  .use(http())
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// --- Shared cache ---
// One instance for data + metrics: a silent Redis init failure can't split
// them across different backends (Redis vs in-memory).

const cache = new Cache();

// --- Metrics middleware (fire-and-forget Redis counters) ---
// Registered BEFORE the payment middleware so the request body can be cloned
// while the stream is still pristine — Request.clone() throws once the handler
// has consumed the body, which silently broke entity metrics when this ran last.

const metricsCache = cache;
const METRICS_TTL = 90 * 86400; // 90 days for daily aggregates
const HOURLY_TTL = 96 * 3600;   // 96h for hourly buckets — attention-momentum needs 3×24h windows + margin

// Caller identity extraction lives in ./caller-id (pure, unit-tested —
// see test/caller-id.test.ts). Handles x402 Solana + Base/EVM payloads,
// MPP credential hashes, and IP fallback.
import { extractCaller } from './caller-id';

// --- OOM hardening (2026-07-16): in-flight tracker + memory watchdog ---
// The Jul 5 + Jul 15 8GB OOM kills left no trace in logs (no invoke lines at
// spike time). Track what's running so the next spike identifies itself.
const inflight = new Map<string, number>();
app.use('*', async (c, next) => {
  const route = `${c.req.method} ${c.req.path}`;
  inflight.set(route, (inflight.get(route) ?? 0) + 1);
  try {
    await next();
  } finally {
    const n = (inflight.get(route) ?? 1) - 1;
    if (n <= 0) inflight.delete(route);
    else inflight.set(route, n);
  }
});

const RSS_WARN_BYTES = 1_073_741_824; // 1GB — ~5x normal baseline, far below the 8GB cap
setInterval(() => {
  const rss = process.memoryUsage().rss;
  if (rss > RSS_WARN_BYTES) {
    const active = [...inflight.entries()].map(([r, n]) => `${r} x${n}`).join(', ') || 'none';
    console.warn(`[memwatch] RSS ${(rss / 1e6).toFixed(0)}MB — in-flight: ${active}`);
  }
}, 60_000);

// Free surfaces were invisible in logs — log hits with IP so unpaid traffic
// (crawlers, scanners) leaves a trace.
const clientIp = (c: { req: { header: (name: string) => string | undefined } }) =>
  c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
app.use('/demo/*', async (c, next) => {
  console.log(`[demo] ${c.req.method} ${c.req.path} from ${clientIp(c)}`);
  await next();
});
app.use('/mcp', async (c, next) => {
  console.log(`[mcp] ${c.req.method} from ${clientIp(c)}`);
  await next();
});

app.use('/entrypoints/*/invoke', async (c, next) => {
  // Clone before next() — payment middleware + handler consume the body stream.
  let reqClone: Request | null = null;
  try { reqClone = c.req.raw.clone(); } catch { reqClone = null; }
  // x402 v2 sends the payment in `payment-signature`; v1 used `x-payment`.
  // Reading only the v1 name silently IP-attributed every v2 payer until
  // 2026-08-02 (found via the paid-200-attributed-to-IP diagnostic).
  const xPaymentHeader = c.req.header('payment-signature') ?? c.req.header('x-payment');
  const authHeader = c.req.header('authorization');
  const forwardedFor = c.req.header('x-forwarded-for');

  await next();

  // ALWAYS drain the clone, whatever the status. `Request.clone()` tees the body
  // stream; on Bun 1.3.14 an abandoned tee branch retains ~260KB per request and
  // is never reclaimed (measured: 15k requests -> +3.8GB, twice, reproducibly).
  // 402 is our most common response, so this was the whole 1.9GB/day OOM climb.
  // Cancelling the branch does NOT release it — it has to be read. Do not move
  // this below the status check. Root-caused 2026-08-09.
  let cloneText: string | null = null;
  if (reqClone) {
    try { cloneText = await reqClone.text(); } catch { cloneText = null; }
  }

  // Only count successful responses
  if (c.res.status !== 200) return;
  try {
    const path = c.req.path; // e.g. /entrypoints/enrich-wallet-light/invoke
    const endpoint = path.split('/')[2]; // extract key
    const now = new Date();
    const date = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const hour = now.toISOString().slice(0, 13); // YYYY-MM-DDTHH
    const warnWrite = (err: unknown) => console.warn('[metrics] write failed:', err);

    // Fire-and-forget — don't await, don't block response
    metricsCache.incr(`metrics:calls:${endpoint}:${date}`, METRICS_TTL).catch(warnWrite);
    metricsCache.incr(`metrics:calls:total:${date}`, METRICS_TTL).catch(warnWrite);

    // Distinct-caller tracking — Feed V1 validation gate prerequisite
    const caller = extractCaller(xPaymentHeader, authHeader, forwardedFor);
    if (caller) {
      metricsCache.sadd(`metrics:callers:${endpoint}:${date}`, caller, METRICS_TTL).catch(warnWrite);
      metricsCache.sadd(`metrics:callers:total:${date}`, caller, METRICS_TTL).catch(warnWrite);
      // A paid endpoint returned 200 but attribution fell through to IP — some
      // payment rail we don't recognize. Log header NAMES (never values) so we
      // can identify the rail from prod logs. (Observed 2026-08-02: several
      // paid 200s tracked as ip:* — see CHECKPOINT.)
      if (caller.startsWith('ip:') && endpoint in PRICING) {
        console.warn(`[caller-id] paid 200 on ${endpoint} attributed to ${caller} — headers: ${[...c.req.raw.headers.keys()].sort().join(',')}`);
      }
    }

    // Extract the queried address/mint from the pre-handler body clone (already
    // drained to `cloneText` above — never re-read the stream).
    if (cloneText) {
      try {
        const body = JSON.parse(cloneText);
        const input = body?.input ?? body;
        const address = input?.address || input?.mint || input?.protocol;
        if (address && typeof address === 'string') {
          const type = input?.mint ? 'token' : input?.protocol ? 'protocol' : 'wallet';
          metricsCache.incr(`metrics:${type}s:${address}:${date}`, METRICS_TTL).catch(warnWrite);
          metricsCache.incr(`metrics:${type}s:${address}:hour:${hour}`, HOURLY_TTL).catch(warnWrite);
        }
        // Track batch items
        if (input?.items && Array.isArray(input.items)) {
          for (const item of input.items) {
            const addr = item?.address || item?.mint;
            if (addr) {
              const t = item?.mint ? 'token' : 'wallet';
              metricsCache.incr(`metrics:${t}s:${addr}:${date}`, METRICS_TTL).catch(warnWrite);
              metricsCache.incr(`metrics:${t}s:${addr}:hour:${hour}`, HOURLY_TTL).catch(warnWrite);
            }
          }
        }
        // Track comparison addresses
        if (input?.addresses && Array.isArray(input.addresses)) {
          for (const addr of input.addresses) {
            if (typeof addr === 'string') {
              metricsCache.incr(`metrics:entities:${addr}:${date}`, METRICS_TTL).catch(warnWrite);
              metricsCache.incr(`metrics:entities:${addr}:hour:${hour}`, HOURLY_TTL).catch(warnWrite);
            }
          }
        }
      } catch { /* body parse failed — still count the endpoint call */ }
    }
  } catch { /* metrics must never break the response */ }
});

console.log('[metrics] Request counter middleware enabled');

// --- x402 Payment Middleware (Solana USDC + optional Base USDC) ---

const PAYMENT_NETWORK = (
  process.env.PAYMENT_NETWORK === "devnet"
    ? "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
    : "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
) as `${string}:${string}`;
const PAY_TO = process.env.AGENT_WALLET_ADDRESS ?? CONFIG.solana.walletAddress;
const PAYMENTS_ENABLED = process.env.PAYMENTS_ENABLED?.toLowerCase() === "true" && PAY_TO !== "";

// Base USDC as a second accepts entry (dual-network is the x402 ecosystem norm —
// 98.7% of Solana-accepting bazaar services also quote Base; see CLAUDE.md
// "Distribution strategy" 2026-07-07). Flag-gated: activates only when
// EVM_PAY_TO (a Base address we control) is set. CDP is Base's home
// facilitator, so the same facilitator client settles both networks.
const BASE_NETWORK = "eip155:8453" as `${string}:${string}`;
const EVM_PAY_TO = process.env.EVM_PAY_TO ?? "";
const BASE_ACCEPTS_ENABLED = PAYMENTS_ENABLED && EVM_PAY_TO !== "";

// Build x402 resource server eagerly so we can catch auth/network failures before
// the process enters its restart loop. If init fails we log and fall back to
// MPP/Stripe + free endpoints only — no crash, no Railway health-check flapping.
let resourceServer: x402ResourceServer | null = null;
if (PAYMENTS_ENABLED) {
  // CDP x402 facilitator — speaks current @x402/core 2.6 schema, supports Solana mainnet,
  // and auto-registers us on the x402 bazaar. Reads CDP_API_KEY_ID + CDP_API_KEY_SECRET from env.
  const { facilitator } = await import("@coinbase/x402");
  const facilitatorClient = new HTTPFacilitatorClient(facilitator);
  try {
    const rs = new x402ResourceServer(facilitatorClient)
      .register(PAYMENT_NETWORK, new ExactSvmScheme());
    if (BASE_ACCEPTS_ENABLED) {
      rs.register(BASE_NETWORK, new ExactEvmScheme());
    }
    await rs.initialize();
    resourceServer = rs;
    console.log(`[x402] Facilitator reachable, auth verified${BASE_ACCEPTS_ENABLED ? ' (Solana + Base accepts)' : ' (Solana only — set EVM_PAY_TO to add Base)'}`);
  } catch (err) {
    console.error('[x402] Facilitator init failed — x402 payments DISABLED for this process. Fix CDP_API_KEY_ID/CDP_API_KEY_SECRET or FACILITATOR_URL and redeploy. Error:', err);
  }
}

if (PAYMENTS_ENABLED && resourceServer) {

  // Build per-route pricing config with Bazaar discovery metadata.
  // Declaring `extensions.bazaar` on each route tells @x402/hono to load the
  // bazaar extension, and the facilitator catalogs us on every settlement.
  // Without this, CDP sees our payments but never indexes us into agentic.market
  // or the x402 bazaar.
  const { declareDiscoveryExtension } = await import('@x402/extensions');

  // Per-endpoint bazaar search tags (@x402 2.17+). Up to 5 per resource, each <=32
  // ASCII chars. These are the DEDICATED bazaar search field — they make us rank for
  // the capability queries agents type ("cross-venue perps funding", "wallet risk",
  // "rug check"), not just brand/description matches. DEFAULT_TAGS covers anything
  // unmapped. Invalid values are soft-dropped by the facilitator (never break the 402).
  const DEFAULT_TAGS = ['solana', 'onchain-data', 'ai-agents', 'defi', 'x402'];
  const BAZAAR_TAGS: Record<string, string[]> = {
    'enrich-wallet-light': ['solana', 'wallet-risk', 'wallet-profiling', 'onchain', 'ai-agents'],
    'enrich-wallet-full': ['solana', 'wallet-risk', 'defi-positions', 'onchain', 'ai-agents'],
    'wallet-graph': ['solana', 'wallet-graph', 'wallet-clustering', 'smart-money', 'onchain'],
    'wallet-history': ['solana', 'wallet-history', 'portfolio', 'onchain', 'ai-agents'],
    'compare-wallets': ['solana', 'wallet-comparison', 'wallet-risk', 'onchain', 'ai-agents'],
    'copy-trade-signals': ['solana', 'copy-trade', 'smart-money', 'trader-pnl', 'ai-agents'],
    'portfolio-history': ['solana', 'portfolio', 'wallet-history', 'onchain', 'ai-agents'],
    'enrich-token-light': ['solana', 'token-risk', 'onchain', 'ai-agents', 'defi'],
    'enrich-token-full': ['solana', 'token-risk', 'holder-analysis', 'rug-detection', 'onchain'],
    'due-diligence': ['solana', 'due-diligence', 'rug-detection', 'token-risk', 'ai-agents'],
    'compare-tokens': ['solana', 'token-comparison', 'token-risk', 'due-diligence', 'onchain'],
    'token-trend': ['solana', 'token-trend', 'onchain', 'ai-agents', 'defi'],
    'new-tokens': ['solana', 'new-tokens', 'token-discovery', 'rug-detection', 'trending'],
    'protocol-profile': ['solana', 'defi', 'protocol-analytics', 'tvl', 'yield'],
    'parse-transaction': ['solana', 'transaction', 'tx-parsing', 'onchain', 'ai-agents'],
    'batch-enrich': ['solana', 'batch', 'enrichment', 'onchain', 'ai-agents'],
    'whale-watch': ['solana', 'whale-tracking', 'smart-money', 'onchain', 'ai-agents'],
    'smart-money-flow': ['solana', 'smart-money', 'netflow', 'whale-tracking', 'trending'],
    'smart-money-trenches': ['solana', 'memecoin', 'smart-money', 'new-tokens', 'trenches'],
    'runner-scan': ['solana', 'memecoin', 'momentum', 'token-discovery', 'trenches'],
    'trenches-scan': ['solana', 'memecoin', 'smart-money', 'momentum', 'trenches'],
    'trenches-check': ['solana', 'memecoin', 'token-vetting', 'smart-money', 'trenches'],
    'exit-signal': ['solana', 'memecoin', 'exit', 'sell-signal', 'trenches'],
    'trending-signals': ['solana', 'trending', 'smart-money', 'new-tokens', 'signals'],
    'consensus-signal': ['solana', 'agent-attention', 'consensus', 'signals', 'smart-money'],
    'attention-momentum': ['solana', 'agent-attention', 'momentum', 'signals', 'divergence'],
    'query': ['solana', 'onchain-data', 'natural-language', 'ai-agents', 'defi'],
    'feed-latest': ['solana', 'intelligence-feed', 'trending', 'onchain', 'ai-agents'],
    'check-alerts': ['solana', 'alerts', 'perps-alerts', 'whale-tracking', 'ai-agents'],
    'perps-market-structure': ['solana', 'perps', 'funding-rate', 'jupiter-perps', 'open-interest'],
    'perps-trader-profile': ['solana', 'perps', 'trader-profile', 'trader-pnl', 'smart-money'],
    'perps-cross-venue-funding': ['solana', 'perps', 'funding-rate', 'cross-venue', 'arbitrage'],
    'perps-venue-comparison': ['solana', 'perps', 'venue-comparison', 'funding-rate', 'best-entry'],
    'perps-basis-signal': ['solana', 'perps', 'basis-trade', 'funding-rate', 'yield'],
    'perps-market-trend': ['solana', 'perps', 'market-trend', 'open-interest', 'funding-rate'],
    'hyperliquid-trader-profile': ['hyperliquid', 'perps', 'trader-profile', 'trader-pnl', 'smart-money'],
    'hyperliquid-smart-money': ['hyperliquid', 'smart-money', 'perps', 'positioning', 'copy-trade'],
    'gacha-ev-scan': ['solana', 'jupiter-gacha', 'expected-value', 'trading-cards', 'rwa'],
  };

  // --- Bazaar input examples (ROLLOUT 2026-06-28; canary CONFIRMED) ------------
  // CDP's bazaar only catalogs endpoints it can demonstrate as callable. No-required-input
  // endpoints catalog automatically; parameterized ones need a concrete `input` EXAMPLE
  // (not just an inputSchema with required fields). Canary (3 endpoints) CONFIRMED this
  // 2026-06-28 — they cataloged ~11min after re-seed-with-example, while the controls
  // (settled fresh the prior day, no example) never did. Rolled out to all 23 parameterized
  // endpoints to take discoverable surface 8 -> 31. Examples reuse SolScout test fixtures.
  // Metadata-only; payment flow untouched.
  const BAZAAR_INPUT_EXAMPLES: Record<string, Record<string, unknown>> = {
    // wallet
    'enrich-wallet-light': { address: 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg' },
    'enrich-wallet-full': { address: 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg' },
    'wallet-graph': { address: 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg' },
    'wallet-history': { address: 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg' },
    'portfolio-history': { address: 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg' },
    'copy-trade-signals': { address: 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg' },
    'compare-wallets': { addresses: ['vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg', 'BvgzoCUMgtos1KRsWwLoabt2a35ErqphzAV3xYEJzrRu'] },
    // token
    'enrich-token-light': { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
    'enrich-token-full': { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
    'due-diligence': { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
    'trenches-check': { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
    'exit-signal': { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
    'whale-watch': { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
    'token-trend': { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
    'compare-tokens': { mints: ['DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'] },
    // tx / batch / query / protocol
    'parse-transaction': { signature: 'bqTH7u2PJ33gDQwZMy9BXVxABRpgUbY8xSuK6y9PpKYxucFKhiJyiD7JTrH1zxFvMEJGz4847tvotMoP1Ekavaa' },
    'batch-enrich': { addresses: ['vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg'], type: 'wallet' },
    'query': { question: 'Is BONK a safe token to hold?' },
    'protocol-profile': { protocol: 'jupiter' },
    // perps
    'perps-trader-profile': { address: 'BvgzoCUMgtos1KRsWwLoabt2a35ErqphzAV3xYEJzrRu' },
    'perps-cross-venue-funding': { market: 'SOL' },
    'perps-venue-comparison': { market: 'SOL', size_usd: 5000 },
    'perps-basis-signal': { asset: 'SOL' },
    // hyperliquid
    'hyperliquid-trader-profile': { address: '0xd21d931890d27b6e7e2e668f27931e17698e90f1' },
    // alerts
    'check-alerts': { since: '2026-06-01T00:00:00Z' },
  };

  const routeConfig = (key: string, price: string) => {
    const meta = ENDPOINT_META[key];
    const inputSchema = meta?.schema ?? { type: 'object', properties: {} };
    return {
      // Solana USDC first (native chain for the data), Base USDC second when
      // enabled. The payer picks whichever network their wallet signs.
      accepts: [
        {
          scheme: "exact" as const,
          price,
          network: PAYMENT_NETWORK,
          payTo: PAY_TO,
        },
        ...(BASE_ACCEPTS_ENABLED
          ? [{
              scheme: "exact" as const,
              price,
              network: BASE_NETWORK,
              payTo: EVM_PAY_TO,
            }]
          : []),
      ],
      // Pin the canonical HTTPS resource URL. Without this, @x402/core derives the
      // URL from the inbound request — which is `http://` behind Railway's
      // TLS-terminating proxy (it doesn't honor X-Forwarded-Proto). CDP's bazaar
      // indexer drops/mis-keys insecure-scheme resources, which is why our 31 direct
      // per-endpoint resources never cataloged (only the https Orbis proxy row did).
      resource: `https://api.solenrich.com/entrypoints/${key}/invoke`,
      // Bazaar ranking fields (@x402 2.17+): serviceName + per-endpoint tags are the
      // dedicated SEARCH fields the bazaar/agentic.market rank on.
      serviceName: "SolEnrich",
      tags: BAZAAR_TAGS[key] ?? DEFAULT_TAGS,
      description: meta?.description ?? "SolEnrich enrichment endpoint",
      mimeType: "application/json",
      // `declareDiscoveryExtension` already returns `{ bazaar: {...} }`, so assign it
      // DIRECTLY to `extensions`. Wrapping it again under `bazaar` double-nested the
      // metadata (`extensions.bazaar.bazaar.{info,schema}`), which CDP's bazaar indexer
      // can't parse — the root cause of SolEnrich being absent from the x402 Bazaar.
      // This changes only discovery metadata; `accepts[]` and the payment flow are untouched.
      extensions: declareDiscoveryExtension({
        bodyType: 'json',
        // CANARY: concrete example input for 3 parameterized endpoints (see BAZAAR_INPUT_EXAMPLES).
        // undefined for all others = unchanged control behavior.
        input: BAZAAR_INPUT_EXAMPLES[key],
        inputSchema: inputSchema as Record<string, unknown>,
        output: {
          example: {
            run_id: 'uuid',
            status: 'succeeded',
            output: { briefing: 'string (llm format) or object (json format)' },
          },
        },
      }),
    };
  };

  // Dual-protocol payments: x402 (Solana USDC) + MPP (Stripe fiat) on ALL routes.
  // x402 activates when X-Payment header is present, MPP handles everything else.
  // Agents choose their payment rail — crypto agents use x402, fiat agents use Stripe.
  const MPP_ENABLED = !!process.env.MPP_SECRET_KEY && !!process.env.STRIPE_SECRET_KEY;

  // x402 routes cover ALL endpoints
  const x402RouteEntries = Object.entries(PRICING)
    .map(([key, price]) => [`POST /entrypoints/${key}/invoke`, routeConfig(key, price)] as const);
  const x402Routes: RoutesConfig = Object.fromEntries(x402RouteEntries);
  const x402MW = paymentMiddleware(x402Routes, resourceServer);

  // Conditional x402 middleware: x402 is the default payment protocol.
  // Only skip x402 when an explicit MPP credential (Authorization: Payment) is present.
  // No credential → x402 returns 402 with x402 challenge (preferred protocol).
  // X-Payment header → x402 verifies the payment.
  // Authorization: Payment → skip x402, let MPP handle below.
  app.use("/entrypoints/*", async (c, next) => {
    const hasMppCredential = c.req.header('authorization')?.startsWith('Payment ');
    if (hasMppCredential) {
      // MPP credential present — skip x402, let MPP middleware handle
      await next();
      return;
    }
    // x402 handles: validates X-Payment if present, returns 402 challenge if not
    return x402MW(c, next);
  });

  console.log(`[x402] Payment middleware enabled on ${Object.keys(x402Routes).length} endpoints — ${PAYMENT_NETWORK}, payTo: ${PAY_TO}`);

  // --- MPP Payment Middleware (Stripe fiat fallback on all endpoints) ---

  if (MPP_ENABLED) {
    const { Mppx } = await import('mppx/hono');
    const { stripe: stripeMpp } = await import('mppx/server');
    const { default: Stripe } = await import('stripe');

    const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY!);

    const mppx = Mppx.create({
      secretKey: process.env.MPP_SECRET_KEY!,
      methods: [
        stripeMpp.charge({
          client: stripeClient,
          currency: 'usd',
          decimals: 6,
          networkId: 'internal',
          paymentMethodTypes: ['card'],
        }),
      ],
    });

    const chargeHandler = (mppx as any)['stripe/charge'] ?? (mppx as any).charge;
    if (!chargeHandler) {
      console.error('[mpp] FATAL: No charge handler found on mppx object. Keys:', Object.keys(mppx as any));
    } else {
      for (const key of Object.keys(PRICING)) {
        const mppHandler = chargeHandler({
          amount: PRICING[key as keyof typeof PRICING],
          recipient: PAY_TO,
        });
        // Gate MPP: only run when an MPP credential is actually present.
        // Without this, MPP's paywall overwrites x402's response on every request,
        // including successful x402 payments — we'd see an MPP 402 instead of the
        // enriched 200. This also preserves x402's 402 challenge on the first
        // request (no-payment-yet case), so the client gets the right feePayer.
        app.use(`/entrypoints/${key}/invoke`, async (c, next) => {
          const hasMppCredential = c.req
            .header('authorization')
            ?.startsWith('Payment ');
          if (!hasMppCredential) return next();
          return mppHandler(c, next);
        });
      }
      console.log(`[mpp] MPP + Stripe enabled on ${Object.keys(PRICING).length} endpoints (gated — only runs with Authorization: Payment header)`);
    }
  }
} else if (!PAYMENTS_ENABLED) {
  console.log("[x402] Payments disabled — set AGENT_WALLET_ADDRESS and PAYMENTS_ENABLED=true to enable");
} else {
  console.warn("[x402] Payments enabled but facilitator init failed — paid endpoints will return 402 with no verification path. MPP/Stripe routes (if configured) still work.");
}

// --- Dependency injection ---

import { PriceAggregator } from "../utils/price-aggregator";

import { SnapshotStore } from '../enrichers/snapshot-store';
import { TrendAnalyzer } from '../enrichers/trend-analyzer';

// `cache` is the shared instance created above the metrics middleware
const snapshotStore = new SnapshotStore(cache);
const helius = new HeliusClient(cache);
const dexscreener = new DexScreenerClient(cache);
const jupiter = new JupiterClient(cache);
const solanaRpc = new SolanaRpcClient();
const birdeye = CONFIG.birdeye.apiKey ? new BirdeyeClient(cache) : undefined;
const priceAggregator = new PriceAggregator(dexscreener, jupiter);

const walletProfiler = new WalletProfiler(helius, solanaRpc, dexscreener, cache, priceAggregator, snapshotStore);
const tokenAnalyzer = new TokenAnalyzer(helius, dexscreener, solanaRpc, jupiter, cache, snapshotStore, birdeye);
const txParser = new TxParser(helius, cache);
const whaleWatcher = new WhaleWatcher(helius, dexscreener, solanaRpc, cache, priceAggregator, birdeye);
const graphMapper = new GraphMapper(helius, cache);
const copyTradeAnalyzer = new CopyTradeAnalyzer(helius, dexscreener, cache, priceAggregator);
const dueDiligenceAnalyzer = new DueDiligenceAnalyzer(tokenAnalyzer, whaleWatcher, cache);
const defiLlama = new DefiLlamaClient(cache);
const protocolAnalyzer = new ProtocolAnalyzer(defiLlama, helius, cache);
const jupiterPerps = new JupiterPerpsClient(cache);
const adrenaClient = new AdrenaClient(cache);
const perpsAnalyzer = new PerpsAnalyzer(jupiterPerps, adrenaClient, jupiter);
const perpReference = new PerpReferenceClient(cache);
const flashPerps = new FlashPerpsClient(cache);
const hyperliquidAnalyzer = new HyperliquidAnalyzer(perpReference);
const hyperliquidSmartMoney = new HyperliquidSmartMoneyAnalyzer(perpReference, hyperliquidAnalyzer, cache);
const perpsCrossVenueAnalyzer = new PerpsCrossVenueAnalyzer(
  jupiterPerps,
  adrenaClient,
  perpReference,
  flashPerps,
  cache,
);
const perpsVenueComparator = new PerpsVenueComparator(
  perpsCrossVenueAnalyzer,
  jupiter,
  jupiterPerps,
  cache,
);
const perpsBasisAnalyzer = new PerpsBasisAnalyzer(
  perpsCrossVenueAnalyzer,
  priceAggregator,
  cache,
);
const gachaAnalyzer = new GachaAnalyzer(new CollectorCryptClient(cache), cache);

import { TokenComparator, WalletComparator } from '../enrichers/comparator';
const tokenComparator = new TokenComparator(tokenAnalyzer);
const walletComparator = new WalletComparator(walletProfiler);

// --- Register entrypoints ---

// Core (Phase 5-6)
registerWalletEntrypoints(addEntrypoint, walletProfiler);
registerTokenEntrypoints(addEntrypoint, tokenAnalyzer);
registerTransactionEntrypoint(addEntrypoint, txParser);

// Premium (Phase 9)
registerWhaleWatchEntrypoint(addEntrypoint, whaleWatcher);
registerBatchEntrypoint(addEntrypoint, walletProfiler, tokenAnalyzer);
registerGraphEntrypoint(addEntrypoint, graphMapper);
registerCopyTradeEntrypoint(addEntrypoint, copyTradeAnalyzer);
registerDueDiligenceEntrypoint(addEntrypoint, dueDiligenceAnalyzer);

// Comparison (side-by-side analysis)
registerCompareEntrypoints(addEntrypoint, tokenComparator, walletComparator);

// Temporal context (trends over time)
const trendAnalyzer = new TrendAnalyzer(tokenAnalyzer, walletProfiler, snapshotStore, cache, jupiterPerps);
registerTrendEntrypoints(addEntrypoint, trendAnalyzer);

// New token discovery
import { TokenDiscovery } from '../enrichers/token-discovery';
const tokenDiscovery = new TokenDiscovery(dexscreener, tokenAnalyzer, cache);
registerDiscoveryEntrypoint(addEntrypoint, tokenDiscovery);

// Protocol analytics
registerProtocolEntrypoint(addEntrypoint, protocolAnalyzer);

// Jupiter Perps — market structure + trader profile
registerPerpsEntrypoints(addEntrypoint, perpsAnalyzer);

// Jupiter Gacha — tokenized-card pack EV scan (net-of-exit-mechanics verdict)
registerGachaEntrypoint(addEntrypoint, gachaAnalyzer);

// Hyperliquid — trader profile + smart-money positioning. First first-class
// off-Solana venue (perps intelligence is venue-agnostic).
registerHyperliquidEntrypoints(addEntrypoint, hyperliquidAnalyzer, hyperliquidSmartMoney);

// Cross-venue perps funding — aggregates Jupiter Perps + Adrena + reference
// venues (Hyperliquid, dYdX v4). Foundation endpoint for the Phase 2D perps
// roadmap — unblocks venue-comparison, basis-signal, and market-trend.
registerPerpsCrossVenueEntrypoint(addEntrypoint, perpsCrossVenueAnalyzer);

// Venue comparison — composes cross-venue + Jupiter slippage quote + OI cap
// headroom to answer "where should I trade this at this size?" Returns
// rankings + a recommendation string with warnings.
registerPerpsVenueComparisonEntrypoint(addEntrypoint, perpsVenueComparator);

// Basis signal — composes cross-venue marks + PriceAggregator spot to compute
// net-yield-after-borrow per venue. Funding-rate venues (HL, dYdX) generate
// real yield; pool perps (Jupiter, Adrena) flagged as not viable. Returns
// per-venue trade + filtered opportunities + best trade.
registerPerpsBasisSignalEntrypoint(addEntrypoint, perpsBasisAnalyzer);

// Smart Money Orchestration — trending-signals + smart-money-flow
// Composes token-discovery, whale-watch, copy-trade, graph-mapper into synthesized
// intelligence. Higher-margin endpoints ($0.05-$0.10) reflecting the work of
// chaining 3-5 sub-enrichers per call.
const trendingSignalsAnalyzer = new TrendingSignalsAnalyzer(tokenDiscovery, whaleWatcher, cache);
const smartMoneyAnalyzer = new SmartMoneyAnalyzer(copyTradeAnalyzer, whaleWatcher, graphMapper, cache, tokenDiscovery);
registerOrchestrationEntrypoints(addEntrypoint, trendingSignalsAnalyzer, smartMoneyAnalyzer);

// Trenches — memecoin intelligence vertical. smart-money-trenches overlays a
// vetted proven-winner seed set's live buys against fresh launches (T3 in
// docs/trenches-scope.md — first trenches endpoint, Eris's first signal).
const trenchesSmartMoney = new TrenchesSmartMoneyAnalyzer(helius, dexscreener, copyTradeAnalyzer, cache);
registerTrenchesEntrypoints(addEntrypoint, trenchesSmartMoney);

// runner-scan — the "WHAT is the token doing" half of runner detection
// (docs/runner-detection-scope.md). On-chain velocity: accelerating buy rate,
// buy pressure, volume/price velocity, holder growth, liquidity trend. Pairs
// with smart-money-trenches (the "WHO is buying" half); both feed trenches-scan.
const runnerDetector = new RunnerDetector(dexscreener, cache, birdeye);
registerRunnerEntrypoint(addEntrypoint, runnerDetector);

// NL query — routes to the right enricher(s). Single-intent questions hit one
// enricher; compound questions ("should I buy X?", "wallet deep dive", "what's
// trending?") chain 2-3 enrichers in parallel and return a unified briefing.
// Registered after all dependency analyzers are constructed above.
registerQueryEntrypoint(
  addEntrypoint,
  walletProfiler,
  tokenAnalyzer,
  txParser,
  whaleWatcher,
  dueDiligenceAnalyzer,
  copyTradeAnalyzer,
  graphMapper,
  trendAnalyzer,
  perpsAnalyzer,
  trendingSignalsAnalyzer,
);

// Intelligence Feed V1 — daily brief lazy-cached via trending-signals.
// Recurring-revenue model: agents poll a fixed endpoint, pay per call,
// receive the same brief everyone else got that day.
const feedStore = new FeedStore(trendingSignalsAnalyzer, cache);
registerFeedEntrypoint(addEntrypoint, feedStore);

// Consensus Signal — derives "what are agents researching right now" from the
// hourly metrics counters the middleware writes on every paid call. Proprietary
// data: only we have agent query history. Reads metricsCache (same Redis
// instance), no new state.
const signalTracker = new SignalTracker(metricsCache, dexscreener);
registerSignalEntrypoint(addEntrypoint, signalTracker);

// Trenches Scan — the three-signal orchestrator (runner velocity × proven-winner
// buys × agent attention). Registered here rather than with the other trenches
// entrypoints because it needs signalTracker, which depends on metricsCache.
const trenchesScanOrchestrator = new TrenchesScanOrchestrator(
  runnerDetector,
  trenchesSmartMoney,
  signalTracker,
  cache,
);
registerTrenchesScanEntrypoint(addEntrypoint, trenchesScanOrchestrator);

// Trenches Check — the suite pointed at one caller-supplied mint. Shares the
// runner snapshot history and the cached smart-money seed scan.
const trenchesCheckAnalyzer = new TrenchesCheckAnalyzer(
  dexscreener,
  trenchesSmartMoney,
  signalTracker,
  cache,
  birdeye,
);
registerTrenchesCheckEntrypoint(addEntrypoint, trenchesCheckAnalyzer);

// Exit Signal — the sell-side verdict for a held position. Shares the runner
// snapshot rails (liquidity/holder deltas) and composes whale-watch for
// top-holder flow. Works on tokens of any age, not just fresh launches.
const exitSignalAnalyzer = new ExitSignalAnalyzer(dexscreener, whaleWatcher, cache, birdeye);
registerExitSignalEntrypoint(addEntrypoint, exitSignalAnalyzer);

// Event-Driven Alerts (Priority 13) — poll-based V1. Stateless: agent passes
// watchlist + `since` cursor each call. Detection composes token-analyzer,
// wallet-profiler, whale-watcher, and snapshot diffs in parallel. SSE + webhook
// steps come later if poll-v1 validates.
const alertChecker = new AlertChecker(tokenAnalyzer, walletProfiler, whaleWatcher, snapshotStore, jupiterPerps);
registerAlertEntrypoint(addEntrypoint, alertChecker);

// --- Demo endpoint (free, rate-limited, for landing page) ---

import { formatResponse } from '../formatters/index';
import { formatWalletBriefing } from '../formatters/llm-wallet';
import { formatTokenBriefing } from '../formatters/llm-token';

const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

// In-memory rate limiter: IP → { count, resetAt }
const demoRateLimits = new Map<string, { count: number; resetAt: number }>();
const DEMO_MAX_REQUESTS = 10;
const DEMO_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// Cleanup expired entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of demoRateLimits) {
    if (now > entry.resetAt) demoRateLimits.delete(ip);
  }
}, 10 * 60 * 1000);

// X-Forwarded-For is client-influenced, so unique keys are unbounded within a
// window — cap the map and evict oldest (insertion order) on overflow.
const DEMO_RATE_LIMIT_MAX_IPS = 10_000;

function getDemoRateLimit(ip: string): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  let entry = demoRateLimits.get(ip);
  if (!entry || now > entry.resetAt) {
    if (!demoRateLimits.has(ip) && demoRateLimits.size >= DEMO_RATE_LIMIT_MAX_IPS) {
      const oldest = demoRateLimits.keys().next().value;
      if (oldest !== undefined) demoRateLimits.delete(oldest);
    }
    entry = { count: 0, resetAt: now + DEMO_WINDOW_MS };
    demoRateLimits.set(ip, entry);
  }
  if (entry.count >= DEMO_MAX_REQUESTS) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }
  entry.count++;
  return { allowed: true, remaining: DEMO_MAX_REQUESTS - entry.count, resetAt: entry.resetAt };
}

// CORS for demo routes (landing page on Vercel)
app.use('/demo/*', cors({
  origin: '*',
  allowMethods: ['POST', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
}));

// CORS for public discovery endpoints (browsable from landing page + agent clients)
app.use('/docs', cors({ origin: '*', allowMethods: ['GET', 'OPTIONS'], allowHeaders: ['Accept', 'Content-Type'] }));
app.use('/openapi.json', cors({ origin: '*', allowMethods: ['GET', 'OPTIONS'], allowHeaders: ['Accept', 'Content-Type'] }));
app.use('/.well-known/*', cors({ origin: '*', allowMethods: ['GET', 'OPTIONS'], allowHeaders: ['Accept', 'Content-Type'] }));
app.use('/entrypoints', cors({ origin: '*', allowMethods: ['GET', 'OPTIONS'], allowHeaders: ['Accept', 'Content-Type'] }));
app.use('/agent-card-extended', cors({ origin: '*', allowMethods: ['GET', 'OPTIONS'], allowHeaders: ['Accept', 'Content-Type'] }));
app.use('/health', cors({ origin: '*', allowMethods: ['GET', 'OPTIONS'], allowHeaders: ['Accept', 'Content-Type'] }));

app.post('/demo/enrich', async (c) => {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    || c.req.header('cf-connecting-ip')
    || 'unknown';

  const rateLimit = getDemoRateLimit(ip);
  if (!rateLimit.allowed) {
    return c.json({
      error: 'Rate limit exceeded',
      resets_at: new Date(rateLimit.resetAt).toISOString(),
    }, 429);
  }

  let body: { address?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const address = body.address?.trim();
  if (!address || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
    return c.json({ error: 'Invalid Solana address' }, 400);
  }

  try {
    // Detect wallet vs token via account owner
    let isToken = false;
    try {
      const accountInfo = await solanaRpc.getAccountInfo(address);
      if (accountInfo) {
        const owner = accountInfo.owner.toBase58();
        isToken = owner === TOKEN_PROGRAM_ID || owner === TOKEN_2022_PROGRAM_ID;
      }
    } catch {
      // RPC failed — default to wallet
    }

    let result: any;
    if (isToken) {
      const data = await tokenAnalyzer.enrich(address, false);
      result = formatResponse(data, 'both', formatTokenBriefing);
    } else {
      const data = await walletProfiler.enrich(address, 'light');
      result = formatResponse(data, 'both', formatWalletBriefing);
    }

    return c.json({
      _demo: {
        type: isToken ? 'token' : 'wallet',
        queries_remaining: rateLimit.remaining,
        resets_at: new Date(rateLimit.resetAt).toISOString(),
      },
      ...result,
    });
  } catch (err: any) {
    // Log full error server-side only — upstream errors can embed
    // API-key-bearing URLs (Helius key lives in the RPC URL).
    console.error('[demo] Enrichment error:', err);
    return c.json({ error: 'Enrichment failed', message: 'Upstream data fetch failed — try again shortly' }, 500);
  }
});

import { formatTokenComparisonBriefing } from '../formatters/llm-compare';

app.post('/demo/compare', async (c) => {
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    || c.req.header('cf-connecting-ip')
    || 'unknown';

  const rateLimit = getDemoRateLimit(ip);
  if (!rateLimit.allowed) {
    return c.json({
      error: 'Rate limit exceeded',
      resets_at: new Date(rateLimit.resetAt).toISOString(),
    }, 429);
  }

  let body: { mints?: string[] };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const mints = body.mints;
  if (!Array.isArray(mints) || mints.length < 2 || mints.length > 3) {
    return c.json({ error: 'Provide 2-3 token mint addresses in the "mints" array' }, 400);
  }

  const addressRegex = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  for (const mint of mints) {
    if (!addressRegex.test(mint)) {
      return c.json({ error: `Invalid Solana address: ${mint}` }, 400);
    }
  }

  try {
    const data = await tokenComparator.compare(mints);
    const result = formatResponse(data, 'both', formatTokenComparisonBriefing);

    return c.json({
      _demo: {
        type: 'compare',
        queries_remaining: rateLimit.remaining,
        resets_at: new Date(rateLimit.resetAt).toISOString(),
      },
      ...result,
    });
  } catch (err: any) {
    console.error('[demo] Compare error:', err);
    return c.json({ error: 'Comparison failed', message: 'Upstream data fetch failed — try again shortly' }, 500);
  }
});

console.log('[demo] Free demo endpoints available at POST /demo/enrich and /demo/compare');

// --- Documentation endpoint (agent-readable) ---

app.get('/docs', (c) => {
  // Content negotiation: route humans to the rendered docs page, LLMs to
  // llms.txt, default agents get pretty-printed JSON.
  const accept = (c.req.header('accept') ?? '').toLowerCase();
  // Real browsers lead with `text/html` and don't request JSON. Agents using
  // fetch/curl/axios default to `*/*` or `application/json` — they fall through
  // to the JSON branch below.
  if (accept.startsWith('text/html') && !accept.includes('application/json')) {
    return c.redirect('https://solenrich.com/docs', 302);
  }
  if (accept.includes('text/markdown')) {
    return c.redirect('/llms.txt', 302);
  }

  const docs = {
    name: 'SolEnrich',
    version: '1.0.0',
    description: 'Solana onchain data enrichment agent. All scoring is deterministic — no LLM inference in the pipeline.',
    base_url: 'https://api.solenrich.com',
    payment: {
      protocol: 'x402',
      currency: 'USDC',
      networks: [
        'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        ...(EVM_PAY_TO ? ['eip155:8453'] : []),
      ],
      facilitator: 'https://api.cdp.coinbase.com/platform/v2/x402',
      alternate: 'MPP/Stripe — send Authorization: Payment header for fiat card payments',
    },
    formats: {
      json: 'Structured data for agent pipelines',
      llm: 'Natural language briefing (markdown) for LLM context windows',
      both: 'JSON data + llm_summary field',
    },
    endpoints: {
      'enrich-wallet-light': {
        price: '0.002',
        input: { address: 'string (Solana base58)', format: 'json | llm | both' },
        description: 'Light wallet profile: SOL balance, token holdings, NFT breakdown (collected vs airdropped vs suspected spam), labels (including behavioral flags regular_intervals/high_frequency/24_7_active/repetitive_actions), risk score',
      },
      'enrich-wallet-full': {
        price: '0.005',
        input: { address: 'string', format: 'json | llm | both' },
        description: 'Full wallet profile: adds DeFi positions, connected wallets, enhanced tx history, and automated-activity behavioral signals',
      },
      'enrich-token-light': {
        price: '0.002',
        input: { mint: 'string (token mint address)', format: 'json | llm | both' },
        description: 'Token analysis: price (median of 3 sources), market cap, volume, liquidity, slippage estimates at 4 position sizes ($100/$1K/$10K/$100K via Jupiter Quote), risk flags',
      },
      'enrich-token-full': {
        price: '0.004',
        input: { mint: 'string', format: 'json | llm | both' },
        description: 'Full token analysis: adds top 20 holders, HHI concentration, volatility metrics, slippage estimates at 4 position sizes',
      },
      'parse-transaction': {
        price: '0.001',
        input: { signature: 'string (tx signature)', format: 'json | llm | both' },
        description: 'Parse a transaction: type detection, protocol identification, transfer breakdown',
      },
      'whale-watch': {
        price: '0.008',
        input: { mint: 'string', threshold_usd: 'number (default 10000)', lookback_hours: 'number (default 24)', format: 'json | llm | both' },
        description: 'Top holders with accumulation/distribution tracking and balance context',
      },
      'batch-enrich': {
        price: '0.015',
        input: { addresses: 'string[] (1-25)', type: 'wallet | token', depth: 'light | full', format: 'json | llm | both' },
        description: 'Parallel enrichment of multiple wallets or tokens in a single call',
      },
      'wallet-graph': {
        price: '0.010',
        input: { address: 'string', depth: '1 | 2', format: 'json | llm | both' },
        description: 'Transaction connection mapping and suspicious cluster detection',
      },
      'copy-trade-signals': {
        price: '0.010',
        input: { address: 'string', lookback_days: 'number (default 30)', format: 'json | llm | both' },
        description: 'Trading PnL, win rate, Sharpe/Sortino ratios, max drawdown, profit factor',
      },
      'due-diligence': {
        price: '0.020',
        input: { mint: 'string', format: 'json | llm | both' },
        description: 'Composite risk report: token analysis + whale activity + holder concentration. Returns SAFE / CAUTION / RISKY verdict',
      },
      'query': {
        price: '0.003',
        input: { question: 'string (natural language)', format: 'json | llm | both' },
        description: 'Plain English questions routed to the right enricher(s). Single-intent ("is X safe?", "wallet for X") hits one enricher. Compound intents chain multiple in parallel: "should I buy X?" → due-diligence + token-trend + whale-watch; "wallet deep dive on X" → wallet-full + history + perps positions; "what\'s trending?" → trending-signals; "SOL-PERP funding rate" → perps-market-structure.',
      },
      'compare-tokens': {
        price: '0.006',
        input: { mints: 'string[] (2-3 token mints)', format: 'json | llm | both' },
        description: 'Side-by-side token comparison: price, liquidity, volatility, HHI, risk. Rankings + summary picks',
      },
      'compare-wallets': {
        price: '0.006',
        input: { addresses: 'string[] (2-3 wallet addresses)', depth: 'light | full', format: 'json | llm | both' },
        description: 'Side-by-side wallet comparison: portfolio, activity, risk, labels. Rankings + summary picks',
      },
      'token-trend': {
        price: '0.006',
        input: { mint: 'string (Solana base58)', lookback: '7d | 14d | 30d (default 7d)', format: 'json | llm | both' },
        description: 'Token metrics over time. Daily snapshots with direction indicators (improving/declining/stable) per metric: price, liquidity, holder concentration, risk score. Snapshots accumulate fire-and-forget on every enrichment.',
      },
      'wallet-history': {
        price: '0.006',
        input: { address: 'string (Solana base58)', lookback: '7d | 14d | 30d (default 7d)', format: 'json | llm | both' },
        description: 'Wallet metrics over time. Tracks portfolio value, SOL balance, risk score, and position changes (added/removed holdings) across daily snapshots.',
      },
      'new-tokens': {
        price: '0.012',
        input: { min_liquidity_usd: 'number (default 1000)', max_risk_score: 'number 0-1 (default 0.8)', limit: 'number (default 20)', format: 'json | llm | both' },
        description: 'Discover recently launched Solana tokens. Scans DexScreener latest profiles, enriches in parallel, scores risk, filters by liquidity + risk thresholds. Returns safest first.',
      },
      'protocol-profile': {
        price: '0.008',
        input: { protocol: 'string (slug or program ID)', include_yields: 'boolean (default true)', format: 'json | llm | both' },
        description: 'DeFi protocol analytics: TVL, yield pools, on-chain activity, health signals, and automated_activity_pct (% of top signers with regular-interval or high-frequency tx patterns — surfaces agent-driven protocol usage). Supports Raydium, Orca, marginfi, Drift, Jupiter, Kamino, Marinade, Jito.',
      },
      'perps-market-structure': {
        price: '0.012',
        input: { format: 'json | llm | both' },
        description: 'Jupiter Perps market structure — per-market OI, utilization, borrow APR, skew, OI caps, and health flags for SOL/BTC/ETH. Reads on-chain Anchor accounts directly (no REST API).',
      },
      'perps-trader-profile': {
        price: '0.010',
        input: { address: 'string', format: 'json | llm | both' },
        description: 'Multi-venue perps trader profile (Jupiter Perps + Adrena). Returns open positions per venue with size, leverage, entry, unrealized PnL, profile classification (scalper/swing/position), and risk flags. Combined totals across venues + per-venue breakdown via `by_venue`. Every position is tagged with its `venue`. Adrena PnL uses jitoSOL/WBTC/BONK mark prices from Jupiter price API; null when unavailable. Multi-venue traders get a `multi_venue: true` flag.',
      },
      'hyperliquid-trader-profile': {
        price: '0.012',
        input: { address: 'string (EVM 0x address)', format: 'json | llm | both' },
        description: "Hyperliquid trader profile — live perp positions for an EVM (0x) address from Hyperliquid's public on-chain state. Per-position side, leverage, notional, entry, unrealized PnL, distance-to-liquidation, risk flags. Account value, directional bias, profile (directional/market-neutral/diversified), weighted leverage, and realized+unrealized PnL over week/month/all-time. Building block for Hyperliquid smart-money tracking.",
      },
      'hyperliquid-smart-money': {
        price: '0.05',
        input: { market: 'string (optional coin focus, e.g. HYPE)', top_traders: 'number (optional, default 10)', format: 'json | llm | both' },
        description: "Where Hyperliquid smart money is positioned. Scans the HL leaderboard, filters out market-makers/HFT + dust/mega-funds, keeps only consistent directional traders (week+month PnL > 0), then aggregates their live positions into a per-coin consensus signal (long/short counts, net notional, bias, conviction) + a top-trader drill-down ranked by month PnL. A positioning signal, not a trade — consensus is often late/crowded and regime-dependent; use as confluence/risk context, not a standalone entry.",
      },
      'perps-cross-venue-funding': {
        price: '0.015',
        input: { market: 'SOL | BTC | ETH | BONK', include_reference: 'boolean (default true)', format: 'json | llm | both' },
        description: 'Cross-venue perps funding aggregator. Compares borrow/funding APR + open interest across Solana on-chain venues (Jupiter Perps, Adrena) and cross-chain reference venues (Hyperliquid, dYdX v4). Returns best entry per side, basis vs Hyperliquid, and arbitrage opportunities. Adrena routes SOL→jitoSOL and BTC→WBTC (wrapped). ETH not supported on Adrena. BONK not tradable on Jupiter Perps.',
      },
      'perps-venue-comparison': {
        price: '0.020',
        input: { market: 'SOL | BTC | ETH | BONK', size_usd: 'number (100-10M)', side: 'long | short (default long)', format: 'json | llm | both' },
        description: 'Where to trade this market at this size. Builds on cross-venue funding with: Jupiter Quote spot slippage at requested size, per-venue fee, OI cap headroom, first-hour borrow cost, and total entry cost. Returns rankings by entry cost / borrow APR / headroom plus a recommendation venue with warnings (insufficient_headroom, elevated_borrow_rate, high_slippage, stressed/tilted health).',
      },
      'perps-basis-signal': {
        price: '0.015',
        input: { asset: 'SOL | BTC | ETH | BONK', min_yield_apr_pct: 'number 0-100 (default 5)', format: 'json | llm | both' },
        description: 'Net-yield-after-borrow basis trade scanner. Computes perp mark vs spot price across venues and surfaces actually-earnable yield. Funding-rate venues (Hyperliquid, dYdX v4) generate real yield; pool perps (Jupiter, Adrena) flagged as not-viable because they charge borrow on both sides. Returns per-venue trade economics, filtered opportunities above the APR threshold, and the best trade.',
      },
      'perps-market-trend': {
        price: '0.008',
        input: { lookback: '7d | 14d | 30d (default 7d)', format: 'json | llm | both' },
        description: 'Jupiter Perps market trend across all 3 markets (SOL/BTC/ETH). Per-symbol deltas for mark price, total open interest, long/short skew, utilization, and borrow APR over 7/14/30 days. Direction indicators per metric and per market. Overall direction excludes mark price (price moves are not health signals). Required for regime detection — bots that adjust behavior based on whether markets are growing, stressed, or rebalancing. Mirror of token-trend for perps.',
      },
      'trending-signals': {
        price: '0.050',
        input: { min_liquidity_usd: 'number (default 10000)', max_risk_score: 'number 0-1 (default 0.7)', limit: 'number (default 10)', include_whale_watch: 'boolean (default true)', format: 'json | llm | both' },
        description: 'Orchestrated ranking of trending Solana tokens. Composes token-discovery + whale-watch + risk scoring. Returns composite-signal ranked list with reasoning. Overall sentiment: accumulation/distribution/mixed.',
      },
      'smart-money-flow': {
        price: '0.100',
        input: { wallets: 'string[] (optional — uses curated default if omitted)', lookback_days: 'number (default 14)', min_win_rate: 'number 0-1 (default 0.55)', top_n_tokens: 'number (default 10)', include_graph: 'boolean (default true)', format: 'json | llm | both' },
        description: 'Orchestrated smart-money intelligence. Scores seed wallets via copy-trade metrics, filters to qualifying winners, surfaces tokens they are accumulating + wallet clusters. Pass your own wallet list or use our default.',
      },
      'smart-money-trenches': {
        price: '0.05',
        input: { hours_back: 'number 1-48 (default 12) — how far back to scan seed buys', max_token_age_hours: 'number 1-72 (default 6) — max token age to count as fresh', min_buyers: 'number 1-14 (default 1) — min distinct smart buyers per token', limit: 'number 1-25 (default 10)', format: 'json | llm | both' },
        description: 'Which proven-winner wallets are aping fresh memecoin launches right now, and what are they buying? Vetted seed set of realized-PnL winners + conviction holders (bot-filtered, live cadence re-checked every scan), recent buys overlaid against token launch times, ranked by distinct smart buyers + recency. Attention signal for pre-ape research — pair with due-diligence.',
      },
      'runner-scan': {
        price: '0.04',
        input: { max_token_age_hours: 'number 0.1-168 (default 24)', min_liquidity_usd: 'number (default 10000)', min_volume_h1_usd: 'number (default 5000)', limit: 'number 1-25 (default 15)', format: 'json | llm | both' },
        description: 'Detects fresh Solana memecoins whose on-chain buying is ACCELERATING — the signature of a run in progress, not the lagging fact that price is already up. Metrics: buy-rate acceleration (5m vs 1h, 1h vs 6h — the second derivative), buy pressure (buys/(buys+sells)), volume acceleration, price velocity, holder growth, liquidity trend. Stages: RUNNING (accelerating across 2+ windows), IGNITING (1 window, unconfirmed), PARABOLIC_LATE (already ran, buying decelerating — entry risk), FADING (sellers in control or LP pulled), QUIET. Wash-trade heuristic via average trade size. The velocity half of runner detection; pair with smart-money-trenches for the wallet half.',
      },
      'feed-latest': {
        price: '0.005',
        input: { since: 'string (ISO 8601, optional) — last poll timestamp; if brief not newer, response sets unchanged=true', format: 'json | llm | both' },
        description: 'Daily SolEnrich intelligence brief — pre-computed ranking of trending Solana tokens with composite-signal scoring. Cached 24h, lazy-populated on cache miss. Designed for recurring polling at lower cost than per-call orchestration.',
      },
      'consensus-signal': {
        price: '0.005',
        input: { type: 'token | wallet (default token)', address: 'string (optional) — single-entity report when provided', window: '1h | 6h | 24h (default 1h)', limit: 'number 1-50 (default 10) — top-N size when address absent', format: 'json | llm | both' },
        description: 'Agent attention signal — what tokens/wallets other agents are querying right now. Proprietary data: derived from SolEnrich\'s own request stream, not market volume. Returns rank/percentile/trend for a given entity, or top-N most-queried entities in the window. Signal data builds with usage.',
      },
      'trenches-check': {
        price: '0.03',
        input: { mint: 'string (required) — token mint to check', format: 'json | llm | both' },
        description: 'The trenches suite pointed at ONE token — pass a mint, get a HIGH_CONFLUENCE / MODERATE / SINGLE_SIGNAL / NO_SIGNAL verdict with reasoning. Same three legs as trenches-scan (on-chain velocity via runner stage + score, proven-winner buys, agent attention) but targeted at your candidate instead of discovery-driven. Composable with due-diligence (structural safety) before an entry. Repeat checks 5+ min apart unlock liquidity-trend and holder-growth deltas.',
      },
      'exit-signal': {
        price: '0.04',
        input: { mint: 'string (required) — token mint you hold', entry_price_usd: 'number (optional) — your entry price, adds unrealized-PnL context (does not change the verdict)', format: 'json | llm | both' },
        description: 'The sell-side verdict — pass a mint you hold, get EXIT / DERISK / HOLD / INSUFFICIENT_DATA with a 0-1 exit score and reasoning. Reads sell pressure, buy-rate deceleration, volume fade, distribution-into-strength divergence, top-holder flow (distributing vs accumulating whales, 24h), liquidity trend, and holder churn. Hard triggers (LP pull ≤ -25%, active dump) force EXIT over everything else. Works on tokens of any age. Repeat calls 5+ min apart unlock liquidity/holder deltas — rug detection needs the second look.',
      },
      'trenches-scan': {
        price: '0.08',
        input: { max_token_age_hours: 'number 1-72 (default 24)', min_liquidity_usd: 'number (default 5000)', limit: 'number 1-20 (default 10)', format: 'json | llm | both' },
        description: 'Three-signal memecoin orchestrator: on-chain velocity (runner-scan) × proven-winner buys (smart-money-trenches) × agent attention (attention-momentum) composited into a ranked list with confluence counts, per-token reasoning, and HIGH_CONFLUENCE/MODERATE/SINGLE_SIGNAL verdicts. Weights: runner 0.45, smart-money 0.45, attention 0.10. Legs degrade independently on upstream failure.',
      },
      'attention-momentum': {
        price: '0.02',
        input: { window: '1h | 6h | 24h (default 6h)', limit: 'number 1-25 (default 10)', format: 'json | llm | both' },
        description: 'Agent-attention acceleration with price divergence — tokens ranked by how fast attention is speeding up (query velocity change across 3 consecutive windows) overlaid with price change over the same window. Divergence classes: early_signal (attention up, price flat), confirmed_momentum, distribution_risk (attention cooling, price pumping), fading. Proprietary: derived from SolEnrich\'s own query stream. Includes sample_quality honesty flag — signal density scales with platform traffic.',
      },
      'portfolio-history': {
        price: '0.006',
        input: { address: 'string (Solana base58)', period: '7d | 14d | 30d (default 7d)', format: 'json | llm | both' },
        description: 'Full portfolio time-series for a wallet — daily snapshots of value, SOL balance, token count, risk score over 7/14/30 days, plus summary stats: peak, trough, max drawdown, average value, change vs period start. Today\'s live point appended automatically. Complements wallet-history (which returns two-point deltas); this returns the series for charting and PnL tracking.',
      },
      'check-alerts': {
        price: '0.008',
        input: { tokens: 'string[] (max 10) — token mints to watch', wallets: 'string[] (max 10) — wallet addresses to watch (spot + Jupiter Perps)', since: 'string (ISO 8601) — return alerts fired since this time', criteria: 'object (optional) — min_price_change_pct, min_risk_score_delta, min_whale_volume_usd, min_portfolio_change_pct, min_concentration_shift_pct, perp_max_leverage (default 10), perp_min_pnl_swing_pts (default 25), perp_liquidation_buffer_pct (default 15)', format: 'json | llm | both' },
        description: 'Poll-based event detection covering spot + Jupiter Perps. Token alerts: price_spike, price_drop, whale_inflow, whale_outflow, concentration_shift. Spot wallet alerts: risk_increase, risk_decrease, portfolio_value_change, new_positions, removed_positions. Jupiter Perps alerts per wallet: perp_position_added, perp_position_closed, perp_at_risk (high leverage or PnL ≤ -50%%), liquidation_approaching (collateral buffer < threshold), pnl_swing (PnL%% moved ≥ N points since prior snapshot). Critical for perps trading bots. Stateless — agent owns the cursor. Step 1 of 3 (poll → SSE → webhooks).',
      },
      'gacha-ev-scan': {
        price: '0.02',
        input: { machine: 'string (optional) — one machine code e.g. pokemon_50; omit to scan all', franchise: 'pokemon | onepiece | all (default all)', exit_strategy: 'buyback | marketplace | both (default both)', min_edge_pct: 'number (optional) — only surface machines with net edge ≥ this %%', format: 'json | llm | both' },
        description: 'Jupiter Gacha (Collector Crypt) tokenized-card pack EV scan. Per machine: gross insured EV vs the guaranteed instant-buyback floor (85-93%% of insured value, ≤72h cash exit) vs a marketplace sale (insured value minus 2%% fee, not guaranteed to fill). Verdict POSITIVE_EV (guaranteed floor wins) / HOUSE_EDGE (marketplace positive but buyback loses ~5%%) / NEGATIVE_EV (even marketplace exit loses), plus rare+epic stock share. Surfaces the realizable EV the platform hides behind its gross-EV headline. NFA.',
      },
    },
    methodology: {
      risk_score: {
        description: 'Wallet risk score from 0.0 (safe) to 1.0 (critical). Pure on-chain, deterministic.',
        factors: [
          'High transaction concentration (few counterparties) — +0.15',
          'Low transaction diversity — +0.1',
          'New wallet (< 30 days old) — +0.15',
          'Bot-like patterns (high frequency, repetitive) — +0.2',
          'Interactions with known risky programs — +0.15',
          'Airdrop farming signals (many small token accounts) — +0.1',
          'Low protocol diversity (< 2 protocols) — +0.1',
        ],
        levels: {
          LOW: '< 0.25',
          MODERATE: '0.25 - 0.50',
          ELEVATED: '0.50 - 0.65',
          HIGH: '0.65 - 0.80',
          CRITICAL: '> 0.80',
        },
      },
      token_risk_score: {
        description: 'Token risk score from 0.0 to 1.0 used in due-diligence. Combines risk flags, holder concentration, and whale activity.',
        factors: [
          'Risk flags count — each adds 0.1',
          'Not verified on Jupiter — +0.1',
          'Mint authority still active — +0.15',
          'Freeze authority active — +0.1',
          'Top holder > 50% supply — +0.15',
          'Top 5 holders > 80% supply — +0.1',
          'Whale distribution activity detected — +0.05',
        ],
        verdicts: {
          SAFE: 'risk_score < 0.3',
          CAUTION: 'risk_score 0.3 - 0.6',
          RISKY: 'risk_score > 0.6',
        },
      },
      hhi: {
        description: 'Herfindahl-Hirschman Index — sum of squared holder percentages. Measures concentration shape. Based on top 20 holders from Solana RPC.',
        interpretation: {
          '< 1500': 'Well distributed',
          '1500 - 2500': 'Moderately concentrated',
          '> 2500': 'Highly concentrated',
        },
      },
      volatility: {
        description: 'Price volatility computed from DexScreener multi-timeframe data (1h, 6h, 24h price changes). No extra API calls.',
        classifications: {
          LOW: 'daily std < 3%',
          MODERATE: 'daily std 3-8%',
          HIGH: 'daily std 8-15%',
          EXTREME: 'daily std > 15%',
        },
      },
      pricing: {
        description: 'Token prices are the median of up to 3 sources: Helius DAS, DexScreener, and Jupiter. Median resists outliers from any single DEX.',
      },
    },
    data_sources: {
      helius: 'DAS API for wallet assets, enhanced transaction parsing. Primary source.',
      dexscreener: 'Token prices, market data, liquidity, OHLCV. Free API.',
      jupiter: 'Token metadata, verification status, cross-reference pricing. Free API.',
      defi_llama: 'Protocol TVL and yield data. Free API.',
      solana_rpc: 'SOL balances, mint info, top holders (via Helius RPC endpoint).',
    },
    entity_labeling: {
      description: '20+ known Solana addresses auto-tagged in all enrichment results.',
      types: ['CEX (Binance, Coinbase, etc.)', 'Protocol (Raydium, Orca, etc.)', 'Bridge', 'Foundation'],
    },
    nft_classification: {
      description:
        'Wallet enrichment splits non-fungible assets into three buckets that sum to nft_count. ' +
        'Most non-fungibles on Solana are unsolicited compressed drops, so a raw count overstates ' +
        'collecting activity. Read nft_summary, not nft_count.',
      buckets: {
        collected:
          'Uncompressed and not spam-flagged. Minting these costs rent per asset, so they are usually bought or minted deliberately.',
        airdropped:
          'Compressed and not spam-flagged. Cheap to mint in bulk, so usually sent unsolicited.',
        suspected_spam:
          'Name or description matches claim bait, an embedded domain, or invisible filter-evasion characters.',
      },
      spam_heuristic:
        'Pattern matching on names and descriptions. Applied to compressed assets only. It is a signal, not a verdict — a legitimate compressed drop with promotional wording can be flagged.',
      distinct_collections:
        'Counts only collected holdings in a named collection. A wallet spammed across 40 fake collections does not count as 40.',
      label_effect:
        'The nft_collector label requires 10+ collected NFTs. It no longer fires on airdrop volume.',
    },
  };

  // Pretty-printed JSON — same parse semantics as minified, readable to humans
  // who hit the endpoint directly via curl or a browser-with-no-JSON-extension.
  return c.body(JSON.stringify(docs, null, 2), 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
  });
});

console.log('[docs] Documentation endpoint available at GET /docs');

// --- Metrics endpoint (internal usage analytics) ---

/**
 * Where the process's memory actually lives. `bun:jsc` heapStats gives the JS
 * side (and per-type object counts, which name a leaking type outright);
 * process.memoryUsage gives the native side (external + arrayBuffers cover
 * Buffers, streams, and fetch bodies that never show up in the JS heap).
 * Best-effort — diagnostics must never break /metrics.
 */
function memoryBreakdown(): Record<string, unknown> {
  const mb = (n: number) => Math.round(n / 1024 / 1024);
  const out: Record<string, unknown> = {};
  try {
    const u = process.memoryUsage();
    out.native = {
      rss_mb: mb(u.rss),
      heap_total_mb: mb(u.heapTotal),
      heap_used_mb: mb(u.heapUsed),
      external_mb: mb(u.external),
      array_buffers_mb: mb((u as unknown as { arrayBuffers?: number }).arrayBuffers ?? 0),
    };
  } catch (err) {
    out.native = { error: String(err) };
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const jsc = require('bun:jsc') as {
      heapStats: () => {
        heapSize: number; heapCapacity: number; extraMemorySize: number;
        objectCount: number; protectedObjectCount: number;
        objectTypeCounts: Record<string, number>;
      };
    };
    const s = jsc.heapStats();
    const top = Object.entries(s.objectTypeCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);
    out.js_heap = {
      heap_mb: mb(s.heapSize),
      heap_capacity_mb: mb(s.heapCapacity),
      extra_memory_mb: mb(s.extraMemorySize),
      object_count: s.objectCount,
      protected_object_count: s.protectedObjectCount,
      top_object_types: Object.fromEntries(top),
    };
  } catch (err) {
    out.js_heap = { error: String(err) };
  }
  return out;
}

app.get('/metrics', async (c) => {
  // Proprietary signal (per-endpoint traffic, top queried entities) — gated.
  // METRICS_TOKEN set → require Bearer token. Not set → only serve when
  // payments are disabled (local dev); locked in production.
  const metricsToken = process.env.METRICS_TOKEN;
  if (metricsToken) {
    if (c.req.header('authorization') !== `Bearer ${metricsToken}`) {
      return c.json({ error: 'Unauthorized' }, 401);
    }
  } else if (PAYMENTS_ENABLED) {
    return c.json({ error: 'Metrics locked — set METRICS_TOKEN and send Authorization: Bearer <token>' }, 401);
  }

  const today = new Date().toISOString().slice(0, 10);

  // Get call counts per endpoint for today
  const endpointKeys = Object.keys(PRICING);
  const callCounts: Record<string, number> = {};
  let todayTotal = 0;

  await Promise.all(
    endpointKeys.map(async (key) => {
      const raw = await metricsCache.getRaw(`metrics:calls:${key}:${today}`);
      const count = raw ? parseInt(raw, 10) : 0;
      if (count > 0) callCounts[key] = count;
      todayTotal += count;
    })
  );

  // Distinct callers per endpoint + total (x402 payer wallets; MPP/IP are proxies)
  const callersByEndpoint: Record<string, number> = {};
  await Promise.all(
    endpointKeys.map(async (key) => {
      const n = await metricsCache.scard(`metrics:callers:${key}:${today}`);
      if (n > 0) callersByEndpoint[key] = n;
    })
  );
  const uniqueCallersToday = await metricsCache.scard(`metrics:callers:total:${today}`);
  const callerIdsToday = await metricsCache.smembers(`metrics:callers:total:${today}`);

  // Get last 7 days totals
  const dailyTotals: Record<string, number> = {};
  for (let i = 0; i < 7; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const raw = await metricsCache.getRaw(`metrics:calls:total:${dateStr}`);
    dailyTotals[dateStr] = raw ? parseInt(raw, 10) : 0;
  }

  // Get top queried tokens and wallets today
  const tokenKeys = await metricsCache.keys(`metrics:tokens:*:${today}`);
  const walletKeys = await metricsCache.keys(`metrics:wallets:*:${today}`);

  const topTokens: Array<{ address: string; queries: number }> = [];
  for (const key of tokenKeys) {
    const raw = await metricsCache.getRaw(key);
    const address = key.split(':')[2];
    topTokens.push({ address, queries: raw ? parseInt(raw, 10) : 0 });
  }
  topTokens.sort((a, b) => b.queries - a.queries);

  const topWallets: Array<{ address: string; queries: number }> = [];
  for (const key of walletKeys) {
    const raw = await metricsCache.getRaw(key);
    const address = key.split(':')[2];
    topWallets.push({ address, queries: raw ? parseInt(raw, 10) : 0 });
  }
  topWallets.sort((a, b) => b.queries - a.queries);

  return c.json({
    date: today,
    process: {
      // Self-reported so memory health is checkable without the Railway dashboard.
      rss_mb: Math.round(process.memoryUsage.rss() / 1024 / 1024),
      uptime_hours: Math.round(process.uptime() / 36) / 100,
      bun: Bun.version,
      // Leak diagnostics (added 2026-08-09). Prod climbs ~1.9GB/day to an 8GB
      // OOM kill; every request path reproduced locally stayed flat, so we need
      // prod to say what it is holding. The split below is the decisive one:
      // JS heap ~= RSS means an object leak (top_object_types names it);
      // JS heap << RSS means native memory (buffers/streams/allocator).
      memory: memoryBreakdown(),
    },
    today: {
      total_calls: todayTotal,
      by_endpoint: callCounts,
      unique_callers: uniqueCallersToday,
      caller_ids: callerIdsToday,
      callers_by_endpoint: callersByEndpoint,
    },
    last_7_days: dailyTotals,
    top_tokens_today: topTokens.slice(0, 10),
    top_wallets_today: topWallets.slice(0, 10),
    unique_tokens_today: tokenKeys.length,
    unique_wallets_today: walletKeys.length,
  });
});

console.log('[metrics] Usage metrics available at GET /metrics');

// --- Favicon ---

import { readFileSync } from 'fs';
import { join } from 'path';

let faviconData: ArrayBuffer | null = null;
try {
  const buf = readFileSync(join(import.meta.dir, '../public/favicon.png'));
  faviconData = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
} catch { /* favicon not found — skip */ }

if (faviconData) {
  const data = faviconData;
  app.get('/favicon.ico', (c) => {
    c.header('Content-Type', 'image/png');
    c.header('Cache-Control', 'public, max-age=86400');
    return c.body(data);
  });

  app.get('/favicon.png', (c) => {
    c.header('Content-Type', 'image/png');
    c.header('Cache-Control', 'public, max-age=86400');
    return c.body(data);
  });

  console.log('[favicon] Serving at /favicon.ico and /favicon.png');
}

// --- OpenAPI discovery document (MPP / AgentCash) ---

import { generateOpenApiDoc, ENDPOINT_META } from '../openapi';

const MPP_ENABLED_FOR_DISCOVERY = !!process.env.MPP_SECRET_KEY && !!process.env.STRIPE_SECRET_KEY;
const openApiDoc = generateOpenApiDoc(MPP_ENABLED_FOR_DISCOVERY);
const openApiJson = JSON.stringify(openApiDoc);

app.get('/openapi.json', (c) => {
  c.header('Cache-Control', 'public, max-age=300');
  c.header('Content-Type', 'application/json');
  return c.body(openApiJson);
});

console.log('[discovery] OpenAPI document available at GET /openapi.json');

// --- x402 well-known discovery (fallback for x402scan) ---

app.get('/.well-known/x402', (c) => {
  // Enriched v1 well-known — includes per-endpoint metadata so crawlers
  // (x402scan, agentic.market, bazaar) can auto-ingest rich service info
  // without scraping OpenAPI. Backwards-compatible: legacy `resources` array
  // is preserved.
  const resources = Object.keys(PRICING).map((key) => `POST /entrypoints/${key}/invoke`);
  const endpoints = Object.entries(PRICING).map(([key, price]) => {
    const meta = ENDPOINT_META[key];
    return {
      url: `https://api.solenrich.com/entrypoints/${key}/invoke`,
      method: 'POST',
      description: meta?.description ?? '',
      summary: meta?.summary ?? key,
      pricing: {
        amount: price,
        currency: 'USDC',
        network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        ...(EVM_PAY_TO ? { alt_networks: ['eip155:8453'] } : {}),
      },
    };
  });
  return c.json({
    version: 1,
    service: {
      name: 'SolEnrich',
      description: 'Agent-native onchain intelligence for Solana traders: cross-venue perps funding (Jupiter, Adrena, Flash, Hyperliquid), smart-money & whale tracking, token due-diligence and rug detection, and wallet risk scoring. Pay-per-call via x402 (USDC) or Stripe.',
      provider: '@0xSardius',
      providerUrl: 'https://twitter.com/0xSardius',
      categories: ['onchain-data', 'solana', 'defi', 'risk-intelligence', 'perps'],
      networks: [
        'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        ...(EVM_PAY_TO ? ['eip155:8453'] : []),
      ],
      openApiUrl: 'https://api.solenrich.com/openapi.json',
    },
    resources,
    endpoints,
  });
});

console.log('[discovery] x402 well-known available at GET /.well-known/x402');

// --- llms.txt: human + crawler-readable service summary ---
// Follows the llms.txt convention (llmstxt.org). agentic.market itself
// publishes one; their crawler likely checks candidate services for it.
const LLMS_TXT = `# SolEnrich

> Solana onchain data enrichment API for AI agents and LLMs. Pay-per-request via x402 (USDC on Solana) or Stripe (fiat). ${Object.keys(PRICING).length} endpoints covering wallet profiling, token analysis, whale tracking, copy-trade signals, due diligence, protocol analytics, Jupiter Perps + cross-venue perps funding, smart-money orchestration, consensus attention signal, portfolio time-series, event-driven alerts, and a daily intelligence feed.

- Base URL: https://api.solenrich.com
- Payment: x402 (USDC on Solana${EVM_PAY_TO ? ' or Base' : ''}) or MPP/Stripe (fiat cards)
- Discovery: GET /.well-known/x402 and GET /openapi.json
- Docs: GET /docs
- Provider: @0xSardius (https://twitter.com/0xSardius)

## Endpoints

${Object.entries(PRICING).map(([key, price]) => {
  const meta = ENDPOINT_META[key];
  return `- [${key}](https://api.solenrich.com/entrypoints/${key}/invoke) — ${meta?.description ?? meta?.summary ?? key} ($${price} USDC)`;
}).join('\n')}

## Networks

- Solana Mainnet (CAIP-2: solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp)
- USDC: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v${EVM_PAY_TO ? `
- Base Mainnet (CAIP-2: eip155:8453) — same USDC price per call, payer picks the network
- USDC (Base): 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` : ''}

## Integration

Agents can call any endpoint with a USDC x402 payment header${EVM_PAY_TO ? ' (Solana or Base — the 402 lists both)' : ''}. First call returns 402 with payment requirements; second call includes signed payment and receives JSON enrichment data. LLM-optimized natural language briefings available by setting format: "llm" in the request body.

MCP server available at https://api.solenrich.com/mcp for direct Claude/Cursor integration.

## Settlement History

- x402scan: https://www.x402scan.com/server/d9814c54-6fa6-4fa7-8b01-43a0ffbc7641 — lifetime on-chain settlement history.
`;

app.get('/llms.txt', (c) => {
  c.header('Content-Type', 'text/markdown; charset=utf-8');
  c.header('Cache-Control', 'public, max-age=300');
  return c.body(LLMS_TXT);
});

console.log('[discovery] llms.txt available at GET /llms.txt');

// --- Agent Card discovery metadata ---

app.get("/agent-card-extended", (c) => {
  return c.json({
    capabilities: [
      "wallet-enrichment",
      "token-analysis",
      "transaction-parsing",
      "risk-scoring",
      "llm-optimized-data",
    ],
    chains: ["solana"],
    formats: ["json", "llm", "both"],
    pricing: {
      currency: "USDC",
      network: PAYMENT_NETWORK,
      payTo: PAY_TO,
      ...(BASE_ACCEPTS_ENABLED ? { alt_networks: { base: { caip2: "eip155:8453", payTo: EVM_PAY_TO } } } : {}),
      entrypoints: PRICING,
    },
    x402: {
      enabled: PAYMENTS_ENABLED,
      network: PAYMENT_NETWORK,
      networks: [PAYMENT_NETWORK, ...(BASE_ACCEPTS_ENABLED ? ["base"] : [])],
      facilitator: process.env.FACILITATOR_URL ?? "https://api.cdp.coinbase.com/platform/v2/x402",
    },
    identity: {
      registry: "8004-solana",
      asset: CONFIG.identity.agentAsset || null,
    },
  });
});

// --- MCP over HTTP (stateless JSON-RPC dispatcher) ---

import { dispatchMcpRequest, MCP_PARSE_ERROR } from './mcp-http';
import { cors } from 'hono/cors';

// CORS for MCP clients. Stateless mode only accepts POST (+ OPTIONS preflight);
// GET/DELETE are advertised as unsupported so clients don't attempt them.
app.use('/mcp', cors({
  origin: '*',
  allowMethods: ['POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'mcp-session-id', 'Last-Event-ID', 'mcp-protocol-version'],
  exposeHeaders: ['mcp-session-id', 'mcp-protocol-version'],
}));

// Stateless MCP endpoint — shared boot-time tool registry, zero per-request allocation.
//
// History (docs/oom-rootcause-2026-07-21.md): the original `app.all` handler leaked a
// full server graph per /mcp hit (GET SSE never closed + no cleanup on completed POSTs)
// and OOM'd Railway at 8GB. The 2026-07-21 fix (405 non-POST + buffered JSON + teardown
// in finally) killed the fast leak, but constructing a 32-tool McpServer + transport per
// POST still retained ~1.5-2MB/request under Bun — directory crawlers (~1K POSTs/day)
// rebuilt the sawtooth over ~3 days (observed 2026-08-02). The dispatcher allocates
// nothing per request: tool schemas, JSON Schemas, and handlers are module-level.
app.post('/mcp', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(MCP_PARSE_ERROR, 400);
  }
  const response = await dispatchMcpRequest(body);
  if (response === null) return c.body(null, 202); // notification(s) only
  return c.json(response);
});

// Any other method (GET SSE probe, DELETE session-teardown) is meaningless in stateless
// mode — 405 immediately, before allocating a transport/server. This is the primary leak fix.
app.all('/mcp', (c) => c.json({ error: 'Method Not Allowed', message: 'The MCP endpoint is stateless; use POST.' }, 405));

console.log('[mcp] HTTP transport available at /mcp');

export { app, addEntrypoint, agent };
