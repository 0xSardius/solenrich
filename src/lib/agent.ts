import { createAgentApp } from "@lucid-agents/hono";
import { createAgent } from "@lucid-agents/core";
import { http } from "@lucid-agents/http";
// NOTE: Lucid's payments plugin only supports EVM (ExactEvmScheme).
// We handle Solana x402 payments manually with @x402/svm below.

// x402 payment middleware
import { paymentMiddleware } from "@x402/hono";
import { x402ResourceServer } from "@x402/hono";
import { ExactSvmScheme } from "@x402/svm/exact/server";
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
import { registerOrchestrationEntrypoints } from "../entrypoints/orchestration";
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
    "Solana onchain data enrichment. Wallet profiling, token analysis, risk scoring. JSON for agents, natural language for LLMs.",
})
  .use(http())
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// --- x402 Payment Middleware (Solana USDC) ---

const PAYMENT_NETWORK = (
  process.env.PAYMENT_NETWORK === "devnet"
    ? "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
    : "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
) as `${string}:${string}`;
const PAY_TO = process.env.AGENT_WALLET_ADDRESS ?? CONFIG.solana.walletAddress;
const PAYMENTS_ENABLED = process.env.PAYMENTS_ENABLED?.toLowerCase() === "true" && PAY_TO !== "";

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
    await rs.initialize();
    resourceServer = rs;
    console.log('[x402] Facilitator reachable, auth verified');
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
  const routeConfig = (key: string, price: string) => {
    const meta = ENDPOINT_META[key];
    const inputSchema = meta?.schema ?? { type: 'object', properties: {} };
    return {
      accepts: [{
        scheme: "exact" as const,
        price,
        network: PAYMENT_NETWORK,
        payTo: PAY_TO,
      }],
      description: meta?.description ?? "SolEnrich enrichment endpoint",
      mimeType: "application/json",
      extensions: {
        bazaar: declareDiscoveryExtension({
          bodyType: 'json',
          inputSchema: inputSchema as Record<string, unknown>,
          output: {
            example: {
              run_id: 'uuid',
              status: 'succeeded',
              output: { briefing: 'string (llm format) or object (json format)' },
            },
          },
        }),
      },
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

// --- Metrics middleware (fire-and-forget Redis counters) ---

const metricsCache = new Cache();
const METRICS_TTL = 90 * 86400; // 90 days for daily aggregates
const HOURLY_TTL = 48 * 3600;   // 48h for hourly buckets — enough for 24h window + prior-window comparison

app.use('/entrypoints/*/invoke', async (c, next) => {
  await next();
  // Only count successful responses
  if (c.res.status !== 200) return;
  try {
    const path = c.req.path; // e.g. /entrypoints/enrich-wallet-light/invoke
    const endpoint = path.split('/')[2]; // extract key
    const now = new Date();
    const date = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const hour = now.toISOString().slice(0, 13); // YYYY-MM-DDTHH

    // Fire-and-forget — don't await, don't block response
    metricsCache.incr(`metrics:calls:${endpoint}:${date}`, METRICS_TTL).catch(() => {});
    metricsCache.incr(`metrics:calls:total:${date}`, METRICS_TTL).catch(() => {});

    // Try to extract the queried address/mint from the request body
    try {
      const body = await c.req.raw.clone().json();
      const input = body?.input ?? body;
      const address = input?.address || input?.mint || input?.protocol;
      if (address && typeof address === 'string') {
        const type = input?.mint ? 'token' : input?.protocol ? 'protocol' : 'wallet';
        metricsCache.incr(`metrics:${type}s:${address}:${date}`, METRICS_TTL).catch(() => {});
        metricsCache.incr(`metrics:${type}s:${address}:hour:${hour}`, HOURLY_TTL).catch(() => {});
      }
      // Track batch items
      if (input?.items && Array.isArray(input.items)) {
        for (const item of input.items) {
          const addr = item?.address || item?.mint;
          if (addr) {
            const t = item?.mint ? 'token' : 'wallet';
            metricsCache.incr(`metrics:${t}s:${addr}:${date}`, METRICS_TTL).catch(() => {});
            metricsCache.incr(`metrics:${t}s:${addr}:hour:${hour}`, HOURLY_TTL).catch(() => {});
          }
        }
      }
      // Track comparison addresses
      if (input?.addresses && Array.isArray(input.addresses)) {
        for (const addr of input.addresses) {
          if (typeof addr === 'string') {
            metricsCache.incr(`metrics:entities:${addr}:${date}`, METRICS_TTL).catch(() => {});
            metricsCache.incr(`metrics:entities:${addr}:hour:${hour}`, HOURLY_TTL).catch(() => {});
          }
        }
      }
    } catch { /* body parse failed — still count the endpoint call */ }
  } catch { /* metrics must never break the response */ }
});

console.log('[metrics] Request counter middleware enabled');

// --- Dependency injection ---

import { PriceAggregator } from "../utils/price-aggregator";

import { SnapshotStore } from '../enrichers/snapshot-store';
import { TrendAnalyzer } from '../enrichers/trend-analyzer';

const cache = new Cache();
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
const perpsAnalyzer = new PerpsAnalyzer(jupiterPerps);

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
const trendAnalyzer = new TrendAnalyzer(tokenAnalyzer, walletProfiler, snapshotStore, cache);
registerTrendEntrypoints(addEntrypoint, trendAnalyzer);

// New token discovery
import { TokenDiscovery } from '../enrichers/token-discovery';
const tokenDiscovery = new TokenDiscovery(dexscreener, tokenAnalyzer, cache);
registerDiscoveryEntrypoint(addEntrypoint, tokenDiscovery);

// Protocol analytics
registerProtocolEntrypoint(addEntrypoint, protocolAnalyzer);

// Jupiter Perps — market structure + trader profile
registerPerpsEntrypoints(addEntrypoint, perpsAnalyzer);

// Smart Money Orchestration — trending-signals + smart-money-flow
// Composes token-discovery, whale-watch, copy-trade, graph-mapper into synthesized
// intelligence. Higher-margin endpoints ($0.05-$0.10) reflecting the work of
// chaining 3-5 sub-enrichers per call.
const trendingSignalsAnalyzer = new TrendingSignalsAnalyzer(tokenDiscovery, whaleWatcher, cache);
const smartMoneyAnalyzer = new SmartMoneyAnalyzer(copyTradeAnalyzer, whaleWatcher, graphMapper, cache, tokenDiscovery);
registerOrchestrationEntrypoints(addEntrypoint, trendingSignalsAnalyzer, smartMoneyAnalyzer);

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
const signalTracker = new SignalTracker(metricsCache);
registerSignalEntrypoint(addEntrypoint, signalTracker);

// Event-Driven Alerts (Priority 13) — poll-based V1. Stateless: agent passes
// watchlist + `since` cursor each call. Detection composes token-analyzer,
// wallet-profiler, whale-watcher, and snapshot diffs in parallel. SSE + webhook
// steps come later if poll-v1 validates.
const alertChecker = new AlertChecker(tokenAnalyzer, walletProfiler, whaleWatcher, snapshotStore);
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

function getDemoRateLimit(ip: string): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  let entry = demoRateLimits.get(ip);
  if (!entry || now > entry.resetAt) {
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
    console.error('[demo] Enrichment error:', err.message);
    return c.json({ error: 'Enrichment failed', message: err.message }, 500);
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
    console.error('[demo] Compare error:', err.message);
    return c.json({ error: 'Comparison failed', message: err.message }, 500);
  }
});

console.log('[demo] Free demo endpoints available at POST /demo/enrich and /demo/compare');

// --- Documentation endpoint (agent-readable) ---

app.get('/docs', (c) => {
  return c.json({
    name: 'SolEnrich',
    version: '1.0.0',
    description: 'Solana onchain data enrichment agent. All scoring is deterministic — no LLM inference in the pipeline.',
    base_url: 'https://api.solenrich.com',
    payment: {
      protocol: 'x402',
      currency: 'USDC',
      network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
      facilitator: 'https://api.cdp.coinbase.com/platform/v2/x402',
      alternate: 'MPP/Stripe — send Authorization: Payment header for fiat card payments',
    },
    formats: {
      json: 'Structured data for agent pipelines',
      llm: 'Natural language briefing (markdown) for LLM context windows',
      both: 'JSON data + llm_summary field',
    },
    partners: {
      orbis: {
        listing: 'https://orbisapi.com (search SolEnrich)',
        referral_header: 'x-referral-code: 683TDRYV',
        note: 'Optional. If your x402 call routes through Orbis and includes this header, Parallax Labs earns a 25% lifetime referral on that payment. Supports continued SolEnrich infrastructure at no cost to you.',
      },
    },
    endpoints: {
      'enrich-wallet-light': {
        price: '0.002',
        input: { address: 'string (Solana base58)', format: 'json | llm | both' },
        description: 'Light wallet profile: SOL balance, token holdings, labels (including behavioral flags regular_intervals/high_frequency/24_7_active/repetitive_actions), risk score',
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
        description: 'Jupiter Perps trader profile — open positions for a wallet with size, leverage, entry, unrealized PnL, profile classification (scalper/swing/position), and risk flags.',
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
      'portfolio-history': {
        price: '0.006',
        input: { address: 'string (Solana base58)', period: '7d | 14d | 30d (default 7d)', format: 'json | llm | both' },
        description: 'Full portfolio time-series for a wallet — daily snapshots of value, SOL balance, token count, risk score over 7/14/30 days, plus summary stats: peak, trough, max drawdown, average value, change vs period start. Today\'s live point appended automatically. Complements wallet-history (which returns two-point deltas); this returns the series for charting and PnL tracking.',
      },
      'check-alerts': {
        price: '0.008',
        input: { tokens: 'string[] (max 10) — token mints to watch', wallets: 'string[] (max 10) — wallet addresses to watch', since: 'string (ISO 8601) — return alerts fired since this time', criteria: 'object (optional) — min_price_change_pct, min_risk_score_delta, min_whale_volume_usd, min_portfolio_change_pct, min_concentration_shift_pct', format: 'json | llm | both' },
        description: 'Poll-based event detection. Pass a watchlist and a since timestamp; receive structured alerts (price spike/drop, risk change, whale inflow/outflow, concentration shift, portfolio value change, position add/remove) graded by severity. Stateless — agent owns the cursor. Step 1 of 3 (poll → SSE → webhooks). Shifts revenue model from one-shot calls to recurring polling.',
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
  });
});

console.log('[docs] Documentation endpoint available at GET /docs');

// --- Metrics endpoint (internal usage analytics) ---

app.get('/metrics', async (c) => {
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
    today: {
      total_calls: todayTotal,
      by_endpoint: callCounts,
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
      },
    };
  });
  return c.json({
    version: 1,
    service: {
      name: 'SolEnrich',
      description: 'Solana onchain data enrichment for AI agents and LLMs. Wallet profiling, token analysis, risk scoring, Jupiter Perps intelligence, and more.',
      provider: 'Parallax Labs',
      providerUrl: 'https://solenrich.com',
      categories: ['onchain-data', 'solana', 'defi', 'risk-intelligence', 'perps'],
      networks: ['solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
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

> Solana onchain data enrichment API for AI agents and LLMs. Pay-per-request via x402 (USDC on Solana) or Stripe (fiat). 22 endpoints covering wallet profiling, token analysis, whale tracking, copy-trade signals, due diligence, protocol analytics, Jupiter Perps intelligence, smart-money orchestration, and a daily intelligence feed.

- Base URL: https://api.solenrich.com
- Payment: x402 (Solana USDC, default) or MPP/Stripe (fiat cards)
- Discovery: GET /.well-known/x402 and GET /openapi.json
- Docs: GET /docs
- Provider: Parallax Labs

## Endpoints

${Object.entries(PRICING).map(([key, price]) => {
  const meta = ENDPOINT_META[key];
  return `- [${key}](https://api.solenrich.com/entrypoints/${key}/invoke) — ${meta?.description ?? meta?.summary ?? key} ($${price} USDC)`;
}).join('\n')}

## Networks

- Solana Mainnet (CAIP-2: solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp)
- USDC: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v

## Integration

Agents can call any endpoint with a Solana USDC x402 payment header. First call returns 402 with payment requirements; second call includes signed payment and receives JSON enrichment data. LLM-optimized natural language briefings available by setting format: "llm" in the request body.

MCP server available at https://api.solenrich.com/mcp for direct Claude/Cursor integration.

## Marketplace Partners

- Orbis: https://orbisapi.com (search "SolEnrich") — agents can pay per-call through the Orbis billing dashboard, 90% of the payment flows to Parallax Labs as weekly Base USDC settlement.
- x402scan: https://www.x402scan.com/server/d9814c54-6fa6-4fa7-8b01-43a0ffbc7641 — lifetime on-chain settlement history.

## Referral Header (optional)

If your x402 call is routed through Orbis, including the header \`x-referral-code: 683TDRYV\` credits Parallax Labs with 25% lifetime of that payment. No cost to you — it comes from Orbis's platform share. Helps fund continued SolEnrich infrastructure and free endpoints.
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
      entrypoints: PRICING,
    },
    x402: {
      enabled: PAYMENTS_ENABLED,
      network: PAYMENT_NETWORK,
      facilitator: process.env.FACILITATOR_URL ?? "https://facilitator.payai.network",
    },
    identity: {
      registry: "8004-solana",
      asset: CONFIG.identity.agentAsset || null,
    },
  });
});

// --- MCP over HTTP (Streamable HTTP transport) ---

import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createSolEnrichMcpServer } from '../mcp-tools';
import { cors } from 'hono/cors';

// CORS for MCP clients
app.use('/mcp', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'mcp-session-id', 'Last-Event-ID', 'mcp-protocol-version'],
  exposeHeaders: ['mcp-session-id', 'mcp-protocol-version'],
}));

// Stateless MCP endpoint — fresh server per request
app.all('/mcp', async (c) => {
  const transport = new WebStandardStreamableHTTPServerTransport();
  const mcpServer = createSolEnrichMcpServer();
  await mcpServer.connect(transport);
  return transport.handleRequest(c.req.raw);
});

console.log('[mcp] HTTP transport available at /mcp');

export { app, addEntrypoint, agent };
