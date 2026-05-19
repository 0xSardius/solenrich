import { Cache } from '../src/cache';
import { JupiterPerpsClient } from '../src/sources/jupiter-perps';
import { AdrenaClient } from '../src/sources/adrena';
import { PerpReferenceClient } from '../src/sources/perp-reference';
import { PerpsCrossVenueAnalyzer } from '../src/enrichers/perps-cross-venue';
import { formatCrossVenueFundingBriefing } from '../src/formatters/llm-perps-cross-venue';

async function main() {
  const cache = new Cache();
  const jupiter = new JupiterPerpsClient(cache);
  const adrena = new AdrenaClient(cache);
  const reference = new PerpReferenceClient(cache);
  const analyzer = new PerpsCrossVenueAnalyzer(jupiter, adrena, reference, cache);

  for (const market of ['SOL', 'BTC', 'ETH', 'BONK'] as const) {
    console.log(`\n${'='.repeat(60)}\n${market} cross-venue funding\n${'='.repeat(60)}`);
    const t0 = Date.now();
    const data = await analyzer.analyze(market, true);
    const elapsed = Date.now() - t0;
    console.log(`(elapsed: ${elapsed}ms, venues: ${data.venues.length}, arbs: ${data.arbitrage_opportunities.length})`);
    console.log('---');
    console.log(formatCrossVenueFundingBriefing(data));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
