import { createAgentApp } from "@lucid-agents/hono";
import { createAgent } from "@lucid-agents/core";
import { http } from "@lucid-agents/http";
import { payments, paymentsFromEnv } from "@lucid-agents/payments";

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
// Supplements Lucid's auto-generated /.well-known/agent.json with 8004 identity

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
      min: "0.001",
      max: "0.025",
      entrypoints: PRICING,
    },
    identity: {
      registry: "8004-solana",
      asset: CONFIG.identity.agentAsset || null,
    },
  });
});

export { app, addEntrypoint, agent };
