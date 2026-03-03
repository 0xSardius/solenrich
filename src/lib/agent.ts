import { createAgentApp } from "@lucid-agents/hono";
import { createAgent } from "@lucid-agents/core";
import { http } from "@lucid-agents/http";
import { payments, paymentsFromEnv } from "@lucid-agents/payments";

// Data source clients
import { Cache } from "../cache";
import { HeliusClient } from "../sources/helius";
import { BirdeyeClient } from "../sources/birdeye";
import { JupiterClient } from "../sources/jupiter";
import { SolanaRpcClient } from "../sources/solana-rpc";

// Enrichers
import { WalletProfiler } from "../enrichers/wallet-profiler";
import { TokenAnalyzer } from "../enrichers/token-analyzer";
import { TxParser } from "../enrichers/tx-parser";

// Entrypoint registration
import { registerWalletEntrypoints } from "../entrypoints/wallet";
import { registerTokenEntrypoints } from "../entrypoints/token";
import { registerTransactionEntrypoint } from "../entrypoints/transaction";

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
const birdeye = new BirdeyeClient(cache);
const jupiter = new JupiterClient(cache);
const solanaRpc = new SolanaRpcClient();

const walletProfiler = new WalletProfiler(helius, birdeye, solanaRpc, jupiter, cache);
const tokenAnalyzer = new TokenAnalyzer(helius, birdeye, jupiter, cache);
const txParser = new TxParser(helius, cache);

// --- Register entrypoints ---

registerWalletEntrypoints(addEntrypoint, walletProfiler);
registerTokenEntrypoints(addEntrypoint, tokenAnalyzer);
registerTransactionEntrypoint(addEntrypoint, txParser);

export { app, addEntrypoint, agent };
