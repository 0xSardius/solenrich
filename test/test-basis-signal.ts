import { Cache } from '../src/cache';
import { JupiterPerpsClient } from '../src/sources/jupiter-perps';
import { JupiterClient } from '../src/sources/jupiter';
import { DexScreenerClient } from '../src/sources/dexscreener';
import { AdrenaClient } from '../src/sources/adrena';
import { PerpReferenceClient } from '../src/sources/perp-reference';
import { PerpsCrossVenueAnalyzer } from '../src/enrichers/perps-cross-venue';
import { PerpsBasisAnalyzer } from '../src/enrichers/perps-basis-signal';
import { PriceAggregator } from '../src/utils/price-aggregator';
import { formatBasisSignalBriefing } from '../src/formatters/llm-perps-basis-signal';

async function main() {
  const cache = new Cache();
  const jupiterPerps = new JupiterPerpsClient(cache);
  const jupiter = new JupiterClient(cache);
  const dexscreener = new DexScreenerClient(cache);
  const adrena = new AdrenaClient(cache);
  const reference = new PerpReferenceClient(cache);
  const cross = new PerpsCrossVenueAnalyzer(jupiterPerps, adrena, reference, cache);
  const priceAggregator = new PriceAggregator(dexscreener, jupiter);
  const analyzer = new PerpsBasisAnalyzer(cross, priceAggregator, cache);

  for (const asset of ['SOL', 'BTC', 'ETH', 'BONK'] as const) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`${asset} basis-signal scan`);
    console.log('='.repeat(70));
    const t0 = Date.now();
    const data = await analyzer.analyze(asset, 5);
    const elapsed = Date.now() - t0;
    console.log(`(elapsed: ${elapsed}ms, opportunities: ${data.opportunities.length}, best: ${data.best_trade?.venue ?? 'none'})`);
    console.log('---');
    console.log(formatBasisSignalBriefing(data));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
