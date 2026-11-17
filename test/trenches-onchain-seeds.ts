// Rebuild the trenches seed set WITHOUT Birdeye (2026-11-17). Birdeye discovery is unavailable (local key 401,
// no prod key), and every existing seed was vetted with the old copy-trade code whose PnL was wrong.
//
// Stage A — discovery: wallets behind recent successful swaps on busy / fast-rising tokens (DexScreener
//   trending candidates → Helius enhanced txs → fee payers with a real buy or sell leg), plus every current seed.
// Stage B — vet everyone the same way, through our own (fixed) stack:
//   1. activity: a transaction in the last 7 days;
//   2. cadence: the trenches-widen-seeds.ts rules on the newest 100 signatures — FILTER at tx/h ≥ 60 or bot flags,
//      FLAG at tx/h ≥ 15 (FLAG is not kept: seeds must be human-mirrorable);
//   3. copy-trade over 14 days (quote-leg PnL): ≥ 10 closed trades, win rate ≥ 50%, PnL > 0, ≥ 3 days covered.
// Output: test/trenches-onchain-result.json (every candidate with its numbers and the reason it failed).
// Run: bun --env-file=.env run test/trenches-onchain-seeds.ts   (≈ 30–60 min; paced for Helius)

import { writeFileSync } from 'fs';
import { HeliusClient } from '../src/sources/helius';
import { DexScreenerClient } from '../src/sources/dexscreener';
import { CopyTradeAnalyzer, extractSwapLeg } from '../src/enrichers/copy-trade-analyzer';
import { detectRegularIntervals, detectHighFrequency, detect247Active } from '../src/enrichers/labeler';
import { TRENCHES_SMART_MONEY_SEEDS } from '../src/enrichers/trenches-smart-money-seeds';

const mem = new Map<string, any>();
const cache: any = { get: async (k: string) => mem.get(k) ?? null, set: async (k: string, v: any) => { mem.set(k, v); }, mget: async (ks: string[]) => ks.map((k) => mem.get(k) ?? null) };
const helius = new HeliusClient(cache);
const dex = new DexScreenerClient(cache);
const ct = new CopyTradeAnalyzer(helius, dex, cache);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const GATES = { activeDays: 7, maxTxPerH: 15, lookbackDays: 14, minClosed: 10, minWinRate: 0.5, minCoverageDays: 3 };
const MAX_TOKENS = 30;
const MAX_NEW_CANDIDATES = 200;

// ---- Stage A: discovery
const trending = await dex.getTrendingCandidates();
const pairs = await dex.getPairsBatch(trending.slice(0, 90));
const byMint = new Map<string, any>();
for (const p of pairs) {
  const m = p.baseToken?.address; if (!m) continue;
  const cur = byMint.get(m);
  if (!cur || (p.volume?.h24 ?? 0) > (cur.volume?.h24 ?? 0)) byMint.set(m, p);
}
const tokens = [...byMint.values()]
  .filter((p) => (p.volume?.h24 ?? 0) >= 100_000)
  .sort((a, b) => (b.volume?.h24 ?? 0) - (a.volume?.h24 ?? 0))
  .slice(0, MAX_TOKENS)
  .map((p) => p.baseToken.address as string);
console.log(`discovery: ${trending.length} trending → ${tokens.length} busy tokens (≥ $100K 24h volume)`);

const found = new Map<string, Set<string>>(); // wallet → tokens it traded
for (const mint of tokens) {
  try {
    const sigs = await helius.getSignaturesForAddress(mint, 100);
    const txs = await helius.getEnhancedTransactions(sigs.map((s) => s.signature));
    for (const t of txs) {
      if (t.transactionError) continue;
      const leg = extractSwapLeg(t, t.feePayer);
      if (leg.kind !== 'buy' && leg.kind !== 'sell') continue;
      if (!found.has(t.feePayer)) found.set(t.feePayer, new Set());
      found.get(t.feePayer)!.add(mint);
    }
  } catch (e) { console.warn(`token ${mint.slice(0, 6)} failed: ${e}`); }
  await sleep(400);
}
const existing = TRENCHES_SMART_MONEY_SEEDS.map((s) => s.address);
const fresh = [...found.entries()].filter(([w]) => !existing.includes(w))
  .sort((a, b) => b[1].size - a[1].size).slice(0, MAX_NEW_CANDIDATES).map(([w]) => w);
console.log(`candidates: ${found.size} swap wallets found, ${fresh.length} new + ${existing.length} current seeds to vet`);

// ---- Stage B: vet
type Row = { address: string; source: 'current_seed' | 'onchain'; tokens_seen: number; last_tx_days: number | null;
  tx_per_h: number | null; botflags: string; closed: number | null; win_rate: number | null; pnl_usd: number | null;
  coverage_days: number | null; pass: boolean; reason: string };
const rows: Row[] = [];
const all = [...existing.map((a) => [a, 'current_seed'] as const), ...fresh.map((a) => [a, 'onchain'] as const)];
const now = Date.now() / 1000;
let i = 0;
for (const [address, source] of all) {
  i++;
  const row: Row = { address, source, tokens_seen: found.get(address)?.size ?? 0, last_tx_days: null, tx_per_h: null, botflags: '-',
    closed: null, win_rate: null, pnl_usd: null, coverage_days: null, pass: false, reason: '' };
  try {
    const sigs = await helius.getSignaturesForAddress(address, 100);
    const ts = sigs.map((s) => s.blockTime).filter((t): t is number => !!t);
    row.last_tx_days = ts.length ? +((now - Math.max(...ts)) / 86400).toFixed(1) : null;
    if (row.last_tx_days == null || row.last_tx_days > GATES.activeDays) { row.reason = 'inactive'; rows.push(row); continue; }
    const span = ts.length > 1 ? Math.max(...ts) - Math.min(...ts) : 0;
    row.tx_per_h = span > 0 ? +(ts.length / (span / 3600)).toFixed(1) : 0;
    const flags = [detectRegularIntervals(ts) && 'regular', detectHighFrequency(ts) && 'highfreq', detect247Active(ts) && '24_7'].filter(Boolean);
    row.botflags = flags.join(',') || '-';
    if (flags.length || row.tx_per_h >= GATES.maxTxPerH) { row.reason = 'bot_cadence'; rows.push(row); continue; }
    const r = await ct.enrich(address, GATES.lookbackDays);
    Object.assign(row, { closed: r.trades_analyzed, win_rate: r.win_rate, pnl_usd: r.total_pnl_usd, coverage_days: r.coverage_days });
    if (r.coverage_days < GATES.minCoverageDays) row.reason = 'short_coverage';
    else if (r.trades_analyzed < GATES.minClosed) row.reason = 'few_trades';
    else if (r.win_rate < GATES.minWinRate) row.reason = 'low_win_rate';
    else if (!(r.total_pnl_usd > 0)) row.reason = 'not_profitable';
    else { row.pass = true; row.reason = 'pass'; }
  } catch (e) { row.reason = `error: ${String(e).slice(0, 80)}`; }
  rows.push(row);
  if (i % 20 === 0) console.log(`vetted ${i}/${all.length} — passing so far ${rows.filter((x) => x.pass).length}`);
  await sleep(300);
}

const tally = (src: string) => {
  const r = rows.filter((x) => x.source === src);
  const by: Record<string, number> = {}; for (const x of r) by[x.reason.split(':')[0]] = (by[x.reason.split(':')[0]] ?? 0) + 1;
  return { total: r.length, ...by };
};
const summary = { derived_at: new Date().toISOString(), gates: GATES, tokens_scanned: tokens.length, current_seeds: tally('current_seed'), onchain: tally('onchain') };
console.log(JSON.stringify(summary, null, 1));
writeFileSync('test/trenches-onchain-result.json', JSON.stringify({ summary, rows: rows.sort((a, b) => Number(b.pass) - Number(a.pass) || (b.pnl_usd ?? -1e9) - (a.pnl_usd ?? -1e9)) }, null, 1));
console.log('wrote test/trenches-onchain-result.json');
