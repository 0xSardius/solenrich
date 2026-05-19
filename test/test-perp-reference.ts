import { Cache } from '../src/cache';
import { PerpReferenceClient } from '../src/sources/perp-reference';

async function main() {
  const cache = new Cache();
  const client = new PerpReferenceClient(cache);

  for (const market of ['SOL', 'BTC', 'ETH', 'BONK'] as const) {
    const { hyperliquid, dydx } = await client.getBoth(market);
    console.log(`\n=== ${market} ===`);
    if (hyperliquid) {
      console.log(
        `  Hyperliquid ${hyperliquid.symbol}: ${hyperliquid.funding_hourly_pct.toFixed(6)}%/hr → ${hyperliquid.annualized_pct.toFixed(2)}% APR. Mark: $${hyperliquid.mark_price_usd?.toFixed(4)}. OI: $${hyperliquid.open_interest_usd?.toLocaleString()}`,
      );
    } else {
      console.log('  Hyperliquid: NULL (unsupported or fetch failed)');
    }
    if (dydx) {
      console.log(
        `  dYdX v4    ${dydx.symbol}: ${dydx.funding_hourly_pct.toFixed(6)}%/hr → ${dydx.annualized_pct.toFixed(2)}% APR. Oracle: $${dydx.oracle_price_usd?.toFixed(4)}. OI: $${dydx.open_interest_usd?.toLocaleString()}`,
      );
    } else {
      console.log('  dYdX v4: NULL (unsupported or fetch failed)');
    }
  }
}
main().catch(e => { console.error(e); process.exit(1); });
