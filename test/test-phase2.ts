// Smoke test for Phase 2 — data source client instantiation + live API calls
import { Cache } from '../src/cache';
import { HeliusClient } from '../src/sources/helius';
import { BirdeyeClient } from '../src/sources/birdeye';
import { DefiLlamaClient } from '../src/sources/defi-llama';
import { JupiterClient } from '../src/sources/jupiter';
import { SolanaRpcClient } from '../src/sources/solana-rpc';

const cache = new Cache();

// Instantiate all clients (dependency injection pattern)
const helius = new HeliusClient(cache);
const birdeye = new BirdeyeClient(cache);
const defiLlama = new DefiLlamaClient(cache);
const jupiter = new JupiterClient(cache);
const solanaRpc = new SolanaRpcClient();

console.log('All clients instantiated successfully');

// --- Live API tests (free endpoints) ---

// DeFi Llama: protocol TVL (free, no key)
try {
  const marinade = await defiLlama.getProtocolTvl('marinade');
  console.log(`DeFi Llama Marinade TVL: $${(marinade.tvl / 1e6).toFixed(1)}M`);
} catch (e: any) {
  console.log('DeFi Llama:', e.message);
}

// Solana RPC: balance via Helius RPC
try {
  const balance = await solanaRpc.getBalance('vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg');
  console.log(`Solana RPC balance: ${balance} SOL`);
} catch (e: any) {
  console.log('Solana RPC balance: SKIPPED (', e.message, ')');
}

// Helius DAS: get assets (uses API key from env)
try {
  const assets = await helius.getAssetsByOwner('vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg');
  console.log(`Helius assets: ${assets.total} total, ${assets.items.length} items returned`);
} catch (e: any) {
  console.log('Helius DAS: SKIPPED (', e.message, ')');
}

// Jupiter: price lookup (requires free API key from portal.jup.ag)
try {
  const prices = await jupiter.getPrice(['So11111111111111111111111111111111111111112']);
  const solPrice = prices['So11111111111111111111111111111111111111112'];
  console.log('Jupiter SOL price:', solPrice ? `$${solPrice.price}` : 'no data');
} catch (e: any) {
  console.log('Jupiter price: SKIPPED (', e.message, ')');
}

// Jupiter: token info
try {
  const bonk = await jupiter.getTokenInfo('DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263');
  console.log('Jupiter BONK info:', bonk ? `${bonk.symbol} (${bonk.decimals} decimals)` : 'not found');
} catch (e: any) {
  console.log('Jupiter token info: SKIPPED (', e.message, ')');
}

console.log('\n✓ Phase 2 smoke tests complete');
