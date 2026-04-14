// Smoke test for Birdeye integration in TokenAnalyzer
// Verifies real holder counts + Birdeye-derived volatility

import { Cache } from '../src/cache';
import { HeliusClient } from '../src/sources/helius';
import { DexScreenerClient } from '../src/sources/dexscreener';
import { JupiterClient } from '../src/sources/jupiter';
import { SolanaRpcClient } from '../src/sources/solana-rpc';
import { BirdeyeClient } from '../src/sources/birdeye';
import { TokenAnalyzer } from '../src/enrichers/token-analyzer';
import { CONFIG } from '../src/config';

const cache = new Cache();
const helius = new HeliusClient(cache);
const dex = new DexScreenerClient(cache);
const jup = new JupiterClient(cache);
const rpc = new SolanaRpcClient();
const birdeye = CONFIG.birdeye.apiKey ? new BirdeyeClient(cache) : undefined;

console.log('Birdeye enabled:', !!birdeye);
if (!birdeye) {
  console.error('No BIRDEYE_API_KEY — abort');
  process.exit(1);
}

const analyzer = new TokenAnalyzer(helius, dex, rpc, jup, cache, undefined, birdeye);

const tokens = [
  { sym: 'BONK', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
  { sym: 'JUP',  mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' },
  { sym: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
];

for (const t of tokens) {
  await cache.del(`token:${t.mint}:basic`).catch(() => {});
  await cache.del(`token:${t.mint}:holders`).catch(() => {});

  const start = Date.now();
  const result = await analyzer.enrich(t.mint, false);
  const ms = Date.now() - start;

  console.log(`\n=== ${t.sym} (${ms}ms) ===`);
  console.log('  symbol         :', result.symbol);
  console.log('  holder_count   :', result.holder_count);
  console.log('  price_usd      :', result.price_usd);
  console.log('  market_cap     :', result.market_cap);
  console.log('  liquidity      :', result.liquidity);
  console.log('  volatility     :', result.volatility);
  console.log('  risk_flags     :', result.risk_flags);
}

console.log('\nDone.');
process.exit(0);
