import { createAgentApp } from "@lucid-agents/hono";
import { createAgent } from "@lucid-agents/core";
import { http } from "@lucid-agents/http";
import { payments, paymentsFromEnv } from "@lucid-agents/payments";

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

// Enrichers
import { WalletProfiler } from "../enrichers/wallet-profiler";
import { TokenAnalyzer } from "../enrichers/token-analyzer";
import { TxParser } from "../enrichers/tx-parser";
import { WhaleWatcher } from "../enrichers/whale-watch";
import { GraphMapper } from "../enrichers/graph-mapper";
import { CopyTradeAnalyzer } from "../enrichers/copy-trade-analyzer";
import { DueDiligenceAnalyzer } from "../enrichers/due-diligence";

// Entrypoint registration
import { registerWalletEntrypoints } from "../entrypoints/wallet";
import { registerTokenEntrypoints } from "../entrypoints/token";
import { registerTransactionEntrypoint } from "../entrypoints/transaction";
import { registerWhaleWatchEntrypoint } from "../entrypoints/whale-watch";
import { registerBatchEntrypoint } from "../entrypoints/batch";
import { registerGraphEntrypoint } from "../entrypoints/graph";
import { registerCopyTradeEntrypoint } from "../entrypoints/copy-trade";
import { registerDueDiligenceEntrypoint } from "../entrypoints/due-diligence";
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
  .use(payments({ config: paymentsFromEnv() }))
  .build();

const { app, addEntrypoint } = await createAgentApp(agent);

// --- x402 Payment Middleware (Solana USDC) ---

const PAYMENT_NETWORK = (
  process.env.PAYMENT_NETWORK === "devnet"
    ? "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
    : "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
) as `${string}:${string}`;
const PAY_TO = process.env.AGENT_WALLET_ADDRESS ?? CONFIG.solana.walletAddress;
const PAYMENTS_ENABLED = process.env.PAYMENTS_ENABLED !== "false" && PAY_TO !== "";

if (PAYMENTS_ENABLED) {
  const facilitatorUrl = process.env.FACILITATOR_URL ?? "https://facilitator.payai.network";
  const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });

  const resourceServer = new x402ResourceServer(facilitatorClient)
    .register(PAYMENT_NETWORK, new ExactSvmScheme());

  // Build per-route pricing config
  // Lucid registers invoke routes as POST /entrypoints/{key}/invoke
  const routeConfig = (price: string) => ({
    accepts: [{
      scheme: "exact" as const,
      price,
      network: PAYMENT_NETWORK,
      payTo: PAY_TO,
    }],
    description: "SolEnrich enrichment endpoint",
    mimeType: "application/json",
  });

  const x402Routes: RoutesConfig = {
    "POST /entrypoints/enrich-wallet-light/invoke": routeConfig(PRICING["enrich-wallet-light"]),
    "POST /entrypoints/enrich-wallet-full/invoke": routeConfig(PRICING["enrich-wallet-full"]),
    "POST /entrypoints/enrich-token-light/invoke": routeConfig(PRICING["enrich-token-light"]),
    "POST /entrypoints/enrich-token-full/invoke": routeConfig(PRICING["enrich-token-full"]),
    "POST /entrypoints/parse-transaction/invoke": routeConfig(PRICING["parse-transaction"]),
    "POST /entrypoints/whale-watch/invoke": routeConfig(PRICING["whale-watch"]),
    "POST /entrypoints/batch-enrich/invoke": routeConfig(PRICING["batch-enrich"]),
    "POST /entrypoints/wallet-graph/invoke": routeConfig(PRICING["wallet-graph"]),
    "POST /entrypoints/copy-trade-signals/invoke": routeConfig(PRICING["copy-trade-signals"]),
    "POST /entrypoints/due-diligence/invoke": routeConfig(PRICING["due-diligence"]),
  };

  app.use(paymentMiddleware(x402Routes, resourceServer));
  console.log(`[x402] Payment middleware enabled — ${PAYMENT_NETWORK}, payTo: ${PAY_TO}`);
} else {
  console.log("[x402] Payments disabled — set AGENT_WALLET_ADDRESS and PAYMENTS_ENABLED=true to enable");
}

// --- Dependency injection ---

const cache = new Cache();
const helius = new HeliusClient(cache);
const dexscreener = new DexScreenerClient(cache);
const jupiter = new JupiterClient(cache);
const solanaRpc = new SolanaRpcClient();

const walletProfiler = new WalletProfiler(helius, solanaRpc, dexscreener, cache);
const tokenAnalyzer = new TokenAnalyzer(helius, dexscreener, solanaRpc, jupiter, cache);
const txParser = new TxParser(helius, cache);
const whaleWatcher = new WhaleWatcher(helius, dexscreener, cache);
const graphMapper = new GraphMapper(helius, cache);
const copyTradeAnalyzer = new CopyTradeAnalyzer(helius, dexscreener, cache);
const dueDiligenceAnalyzer = new DueDiligenceAnalyzer(tokenAnalyzer, whaleWatcher, cache);

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

export { app, addEntrypoint, agent };
