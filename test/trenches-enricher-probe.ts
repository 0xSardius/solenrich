// Live probe of TrenchesSmartMoneyAnalyzer before endpoint wiring.
import { Cache } from '../src/cache';
import { HeliusClient } from '../src/sources/helius';
import { DexScreenerClient } from '../src/sources/dexscreener';
import { CopyTradeAnalyzer } from '../src/enrichers/copy-trade-analyzer';
import { TrenchesSmartMoneyAnalyzer } from '../src/enrichers/trenches-smart-money';

const cache = new Cache();
const helius = new HeliusClient(cache);
const dexscreener = new DexScreenerClient(cache);
const copyTrade = new CopyTradeAnalyzer(helius, dexscreener, cache);
const analyzer = new TrenchesSmartMoneyAnalyzer(helius, dexscreener, copyTrade, cache);

const t0 = Date.now();
const result = await analyzer.enrich(24, 48, 1, 10);
console.log(`elapsed: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(JSON.stringify(result, null, 2));
