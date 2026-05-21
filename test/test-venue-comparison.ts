import { Cache } from '../src/cache';
import { JupiterPerpsClient } from '../src/sources/jupiter-perps';
import { JupiterClient } from '../src/sources/jupiter';
import { AdrenaClient } from '../src/sources/adrena';
import { PerpReferenceClient } from '../src/sources/perp-reference';
import { PerpsCrossVenueAnalyzer } from '../src/enrichers/perps-cross-venue';
import { PerpsVenueComparator } from '../src/enrichers/perps-venue-comparison';
import { formatVenueComparisonBriefing } from '../src/formatters/llm-perps-venue-comparison';

async function main() {
  const cache = new Cache();
  const jupiterPerps = new JupiterPerpsClient(cache);
  const jupiter = new JupiterClient(cache);
  const adrena = new AdrenaClient(cache);
  const reference = new PerpReferenceClient(cache);
  const cross = new PerpsCrossVenueAnalyzer(jupiterPerps, adrena, reference, cache);
  const comparator = new PerpsVenueComparator(cross, jupiter, jupiterPerps, cache);

  const scenarios = [
    { market: 'SOL' as const, size_usd: 10_000, side: 'long' as const },
    { market: 'BTC' as const, size_usd: 50_000, side: 'long' as const },
    { market: 'ETH' as const, size_usd: 5_000, side: 'short' as const },
    { market: 'BONK' as const, size_usd: 2_000, side: 'long' as const },
  ];

  for (const s of scenarios) {
    console.log(`\n${'='.repeat(70)}`);
    console.log(`${s.market} ${s.side.toUpperCase()} $${s.size_usd.toLocaleString()}`);
    console.log('='.repeat(70));
    const t0 = Date.now();
    const data = await comparator.compare(s.market, s.size_usd, s.side);
    const elapsed = Date.now() - t0;
    console.log(`(elapsed: ${elapsed}ms, rec: ${data.recommendation.venue ?? 'none'})`);
    console.log('---');
    console.log(formatVenueComparisonBriefing(data));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
