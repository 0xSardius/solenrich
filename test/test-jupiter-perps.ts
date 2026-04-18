// Smoke test for JupiterPerpsClient — live mainnet read
import { Cache } from '../src/cache';
import { JupiterPerpsClient } from '../src/sources/jupiter-perps';

async function main() {
  const cache = new Cache();
  const client = new JupiterPerpsClient(cache);

  console.log('\n=== MARKET STRUCTURE ===');
  const t0 = Date.now();
  const market = await client.getMarketStructure();
  console.log(`fetched in ${Date.now() - t0}ms`);
  console.log('pool:', market.pool);
  console.log('total OI:', `$${market.totals.total_oi_usd.toLocaleString()}`);
  console.log('net skew:', market.totals.net_skew);
  for (const m of market.markets) {
    console.log(`\n${m.symbol}:`);
    console.log(`  mark=$${m.mark_price_usd?.toFixed(2) ?? 'null'}`);
    console.log(`  long_oi=$${m.open_interest.long_usd.toLocaleString(undefined, { maximumFractionDigits: 0 })} (${m.open_interest.long_pct.toFixed(1)}%)`);
    console.log(`  short_oi=$${m.open_interest.short_usd.toLocaleString(undefined, { maximumFractionDigits: 0 })} (${m.open_interest.short_pct.toFixed(1)}%)`);
    console.log(`  util=${m.utilization_pct.toFixed(2)}%`);
    console.log(`  borrow=${m.borrow_rate.hourly_pct.toFixed(4)}%/hr (${m.borrow_rate.annualized_pct.toFixed(2)}% APR, model=${m.borrow_rate.model})`);
    console.log(`  owned=${m.pool_assets.owned_tokens.toFixed(4)} tokens, locked=${m.pool_assets.locked_tokens.toFixed(4)}`);
  }

  // Test trader profile with a wallet that likely has positions — SolScout won't, but let's try Solana Foundation
  // as a sanity check (expect zero positions)
  const testWallet = 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg';
  console.log(`\n=== TRADER PROFILE: ${testWallet} ===`);
  const t1 = Date.now();
  const marks = client.buildMarkPriceMap(market);
  const trader = await client.getPositionsForWallet(testWallet, marks);
  console.log(`fetched in ${Date.now() - t1}ms`);
  console.log('has_positions:', trader.has_positions);
  console.log('position_count:', trader.positions.length);
  console.log('gross_exposure:', `$${trader.totals.gross_exposure_usd.toLocaleString()}`);
  if (trader.positions.length > 0) {
    for (const p of trader.positions.slice(0, 3)) {
      console.log(`  ${p.market_symbol} ${p.side} $${p.size_usd.toFixed(0)} @ ${p.entry_price_usd.toFixed(2)} (${p.leverage.toFixed(2)}x, uPnL=$${p.unrealized_pnl_usd?.toFixed(2) ?? 'null'})`);
    }
  }

  console.log('\n✓ smoke test passed');
}

main().catch(e => {
  console.error('FAILED:', e);
  process.exit(1);
});
