// Scheduled job (GitHub Actions, every 6 hours): walk every StonkFun reward-coin page, compute per-quote shelf
// stats over the whole population, and write one summary to Redis for the API to read. See
// src/enrichers/stonk-population.ts for why this runs outside the API.
//
// Env: UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN. Prints no secrets.
// Exit 1 without writing when coverage is under POPULATION_MIN_COVERAGE: the API keeps the last good summary.
import { Cache } from '../src/cache';
import { StonkFunClient, type StonkRewardsLedgerEntry } from '../src/sources/stonkfun';
import { toRow } from '../src/enrichers/stonk-index';
import {
  POPULATION_CACHE_KEY,
  POPULATION_MIN_COVERAGE,
  POPULATION_TTL_SECONDS,
  buildPopulation,
  populationStatus,
  walkAllRewardTokens,
  type StonkPopulation,
} from '../src/enrichers/stonk-population';

if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
  console.error('UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set — refusing to run (the summary would go nowhere).');
  process.exit(1);
}

const cache = new Cache();
const client = new StonkFunClient(cache);
const t0 = Date.now();

const [walk, ledger] = await Promise.all([walkAllRewardTokens(client), client.getRewardsLedger()]);
const ledgerByMint = new Map<string, StonkRewardsLedgerEntry>(ledger.map((l) => [l.mint, l]));
const coverage = walk.pagesRead / walk.pagesTotal;
console.log(`walk: ${walk.pagesRead}/${walk.pagesTotal} pages (${(coverage * 100).toFixed(1)}%), ${walk.tokens.length} coins, upstream total ${walk.upstreamTotal}, ledger ${ledger.length}, ${Math.round((Date.now() - t0) / 1000)}s`);
if (walk.failedPages.length) console.log(`failed pages: ${walk.failedPages.join(',')}`);

if (coverage < POPULATION_MIN_COVERAGE) {
  console.error(`coverage ${(coverage * 100).toFixed(1)}% < ${POPULATION_MIN_COVERAGE * 100}% — not writing; the API keeps the last good summary.`);
  process.exit(1);
}

const now = Date.now();
const population = buildPopulation(walk.tokens.map((t) => toRow(t, ledgerByMint.get(t.mint))), now, walk);
await cache.set(POPULATION_CACHE_KEY, population, POPULATION_TTL_SECONDS);

// Read back: Cache.set swallows errors, so confirm the write landed.
const back = await cache.get<StonkPopulation>(POPULATION_CACHE_KEY);
const st = populationStatus(back, Date.now());
if (!back || back.generatedAt !== population.generatedAt || !st) {
  console.error('write did not land (read-back mismatch)');
  process.exit(1);
}
const bytes = JSON.stringify(population).length;
const top = [...population.quotes].sort((a, b) => b.volume_24h_usd - a.volume_24h_usd).slice(0, 5);
console.log(`wrote ${POPULATION_CACHE_KEY}: ${population.quotes.length} quotes, ${population.coins} coins, ${(bytes / 1024).toFixed(0)} KB, generated ${population.generatedAt}`);
console.log(`top quotes by 24h volume: ${top.map((q) => `${q.quote_symbol} ${q.coins} coins ${(q.traded_share_24h * 100).toFixed(0)}% traded`).join(' | ')}`);
process.exit(0);
