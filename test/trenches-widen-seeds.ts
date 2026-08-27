// Widen the trenches seed set 14 -> ~100+ vetted wallets (checkpoint task #2).
//
// Stage A — discovery (bigger funnel than trenches-build-seeds.ts):
//   Pool A: Birdeye gainers-losers leaderboard, THREE windows (today/yesterday/1W)
//           x 10 pages each, filtered to realized winners.
//   Pool B: top traders + holders of runner tokens — the 5 hand-verified statics
//           PLUS recent runners mined live from DexScreener (high-volume, big-24h
//           movers under 14 days old).
// Stage B — vet every candidate through our own stack:
//   Cheap pass (all): Helius 100-sig cadence -> bot flags + tx/h thresholds.
//   Expensive pass (KEEPs only): copy-trade win rate, best effort.
// Output: test/trenches-widen-result.json — TS-ready seed entries + stats.
//
// Run: bun run test/trenches-widen-seeds.ts   (Bun auto-loads .env)

import { writeFileSync, existsSync, readFileSync } from 'fs';
import { Cache } from '../src/cache';
import { HeliusClient } from '../src/sources/helius';
import { DexScreenerClient } from '../src/sources/dexscreener';
import { CopyTradeAnalyzer } from '../src/enrichers/copy-trade-analyzer';
import { detectRegularIntervals, detectHighFrequency, detect247Active } from '../src/enrichers/labeler';
import {
  TRENCHES_SMART_MONEY_SEEDS,
  TRENCHES_CONVICTION_HOLDERS,
} from '../src/enrichers/trenches-smart-money-seeds';

const B = 'https://public-api.birdeye.so';
const K = process.env.BIRDEYE_API_KEY ?? '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Hand-verified runner statics (same as trenches-build-seeds.ts).
const STATIC_RUNNERS: Record<string, string> = {
  ANSEM: '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump',
  TRIPLET: 'J8PSdNP3QewKq2Z1JJJFDMaqF7KcaiJhR7gbr5KZpump',
  NEET: 'Ce2gx9KGXJ6C9Mp5b5x1sn9Mg87JwEbrQby4Zqo3pump',
  BUTTCOIN: 'Cm6fNnMk7NfzStP9CZpsQA2v3jjzbcYGAxdJySmHpump',
  JOTCHUA: 'BcHEaaTCvycPwwsJ9yQTXdHP9X2gCLkznDbZ8VySpump',
};

// Known non-trader owners (LPs, routers, program vaults).
const EXCLUDE = new Set<string>([
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Raydium authority V4
]);

const EXISTING = new Set<string>([
  ...TRENCHES_SMART_MONEY_SEEDS.map((s) => s.address),
  ...TRENCHES_CONVICTION_HOLDERS.map((h) => h.address),
]);

// Accumulate across runs: keeps from prior runs are excluded from discovery and
// re-merged into the output, so the result file only ever grows.
const RESULT_PATH = 'test/trenches-widen-result.json';
const priorKeeps: any[] = existsSync(RESULT_PATH)
  ? (JSON.parse(readFileSync(RESULT_PATH, 'utf8')).keeps ?? [])
  : [];
for (const k of priorKeeps) EXISTING.add(k.addr);

async function be(path: string): Promise<any | null> {
  await sleep(1300); // free tier ~1 rps
  try {
    const r = await fetch(`${B}${path}`, { headers: { 'X-API-KEY': K, 'x-chain': 'solana' } });
    if (!r.ok) return null;
    return r.json();
  } catch {
    return null;
  }
}

interface Candidate {
  addr: string;
  tier: 1 | 2 | 3;
  realized?: number;
  lb_trades?: number;
  window?: string;
  runners?: string[];
}

// --- Stage A ---

async function discover(): Promise<Candidate[]> {
  // Pool A: three leaderboard windows x 10 pages
  const winners = new Map<string, { realized: number; trades: number; window: string }>();
  // The board sorts by TOTAL PnL, so realized winners are scattered thousands
  // of rows deep (probed 2026-08-27: offset 400 still holds $110-124K realized;
  // $25K rows persist past offset 2000). Sweep the 1W board deep — never
  // early-stop on realized, it is not monotonic in this sort.
  const REALIZED_FLOOR = 25_000;
  const sweeps: Array<{ window: string; maxOff: number }> = [
    { window: '1W', maxOff: 3000 },
    { window: 'today', maxOff: 100 },
    { window: 'yesterday', maxOff: 100 },
  ];
  for (const { window, maxOff } of sweeps) {
    let pulled = 0;
    for (let off = 0; off < maxOff; off += 10) {
      const b = await be(`/trader/gainers-losers?type=${window}&sort_by=PnL&sort_type=desc&offset=${off}&limit=10`);
      const items = b?.data?.items ?? [];
      if (items.length === 0) break; // end of board
      pulled += items.length;
      for (const t of items) {
        if ((t.realized_pnl ?? 0) >= REALIZED_FLOOR && (t.trade_count ?? 0) >= 10 && (t.trade_count ?? 0) < 3000) {
          const prev = winners.get(t.address);
          if (!prev || t.realized_pnl > prev.realized) {
            winners.set(t.address, { realized: t.realized_pnl, trades: t.trade_count, window });
          }
        }
      }
      if (items.length < 10) break;
    }
    console.log(`Pool A [${window}]: pulled ${pulled} rows, realized-winner pool now ${winners.size}`);
  }

  // Pool B: static runners + recent runners mined from DexScreener
  const dexscreener = new DexScreenerClient(new Cache());
  const runnerMints = new Map<string, string>(Object.entries(STATIC_RUNNERS));
  try {
    const trending = await dexscreener.getTrendingCandidates();
    const pairs = await dexscreener.getPairsBatch(trending);
    const byMint = new Map<string, { liq: number; vol24: number; chg24: number; age_h: number | null; symbol: string }>();
    for (const p of pairs) {
      const mint = p.baseToken?.address;
      if (!mint) continue;
      const cur = byMint.get(mint) ?? { liq: 0, vol24: 0, chg24: p.priceChange?.h24 ?? 0, age_h: null, symbol: p.baseToken?.symbol ?? '?' };
      cur.liq += p.liquidity?.usd ?? 0;
      cur.vol24 += p.volume?.h24 ?? 0;
      if (typeof p.pairCreatedAt === 'number' && p.pairCreatedAt > 0) {
        const age = (Date.now() - p.pairCreatedAt) / 3_600_000;
        cur.age_h = cur.age_h == null ? age : Math.min(cur.age_h, age);
      }
      byMint.set(mint, cur);
    }
    const recent = [...byMint.entries()]
      .filter(([, v]) => v.liq >= 30_000 && v.vol24 >= 300_000 && v.chg24 >= 20 && v.age_h != null && v.age_h <= 21 * 24)
      .sort((a, b) => b[1].vol24 - a[1].vol24)
      .slice(0, 12);
    for (const [mint, v] of recent) runnerMints.set(`LIVE:${v.symbol}`, mint);
    console.log(`Pool B: ${Object.keys(STATIC_RUNNERS).length} static + ${recent.length} live-mined runners`);
  } catch (e) {
    console.log(`Pool B live mining failed (${e}) — statics only`);
  }

  const runnerHits = new Map<string, Set<string>>();
  for (const [name, mint] of runnerMints) {
    // 20 top traders (2 pages) + 20 holders per runner
    const wallets: string[] = [];
    for (const off of [0, 10]) {
      const tt = await be(`/defi/v2/tokens/top_traders?address=${mint}&time_frame=24h&sort_by=volume&sort_type=desc&offset=${off}&limit=10`);
      wallets.push(...(tt?.data?.items ?? []).map((i: any) => i.owner).filter(Boolean));
    }
    const hd = await be(`/defi/v3/token/holder?address=${mint}&offset=0&limit=20`);
    wallets.push(...(hd?.data?.items ?? []).map((i: any) => i.owner).filter(Boolean));
    for (const w of wallets) {
      if (!runnerHits.has(w)) runnerHits.set(w, new Set());
      runnerHits.get(w)!.add(name);
    }
    console.log(`  ${name.padEnd(14)} wallets=${wallets.length}`);
  }

  // Tiers + dedupe
  const out: Candidate[] = [];
  for (const [addr, w] of winners) {
    if (EXCLUDE.has(addr) || EXISTING.has(addr)) continue;
    const hits = runnerHits.get(addr);
    out.push({
      addr,
      tier: hits && hits.size > 0 ? 1 : 2,
      realized: w.realized,
      lb_trades: w.trades,
      window: w.window,
      ...(hits ? { runners: [...hits] } : {}),
    });
  }
  for (const [addr, hits] of runnerHits) {
    if (hits.size < 2 || EXCLUDE.has(addr) || EXISTING.has(addr)) continue;
    if (winners.has(addr)) continue; // already tiered above
    out.push({ addr, tier: 3, runners: [...hits] });
  }
  return out;
}

// --- Stage B ---

interface Vetted extends Candidate {
  n_tx: number;
  span_h: number;
  tx_per_h: number;
  botflags: string;
  verdict: 'KEEP' | 'FLAG' | 'FILTER' | 'ERR';
  win_rate?: number | null;
  ct_trades?: number;
}

async function vetCadence(helius: HeliusClient, c: Candidate): Promise<Vetted> {
  try {
    const sigs = await helius.getSignaturesForAddress(c.addr, 100);
    const ts = sigs.map((s: any) => s.blockTime).filter((t: any): t is number => typeof t === 'number');
    const span = ts.length >= 2 ? Math.max(...ts) - Math.min(...ts) : 0;
    const txPerH = span > 0 ? ts.length / (span / 3600) : ts.length >= 100 ? Infinity : 0;
    const regular = detectRegularIntervals(ts);
    const highFreq = detectHighFrequency(ts);
    const active247 = detect247Active(ts);
    // Same thresholds as the 2026-07-06 vetting (trenches-vet-seeds.ts).
    const hftByVol = (c.lb_trades ?? 0) >= 700;
    const flagByVol = (c.lb_trades ?? 0) >= 300;
    let verdict: Vetted['verdict'];
    if (regular || active247 || hftByVol || txPerH >= 60) verdict = 'FILTER';
    else if (highFreq || flagByVol || txPerH >= 15) verdict = 'FLAG';
    else verdict = 'KEEP';
    return {
      ...c,
      n_tx: ts.length,
      span_h: Math.round(span / 3600),
      tx_per_h: span > 0 ? +(ts.length / (span / 3600)).toFixed(1) : 0,
      botflags: [regular && 'REG', highFreq && 'HF', active247 && '247'].filter(Boolean).join('|') || '-',
      verdict,
    };
  } catch {
    return { ...c, n_tx: 0, span_h: 0, tx_per_h: 0, botflags: '-', verdict: 'ERR' };
  }
}

async function main() {
  if (!K) {
    console.error('No BIRDEYE_API_KEY in env.');
    process.exit(1);
  }

  console.log('=== STAGE A: discovery ===');
  const candidates = await discover();
  const t1 = candidates.filter((c) => c.tier === 1).length;
  const t2 = candidates.filter((c) => c.tier === 2).length;
  const t3 = candidates.filter((c) => c.tier === 3).length;
  console.log(`\nCandidates (new, deduped vs current seeds): ${candidates.length} (T1=${t1} T2=${t2} T3=${t3})`);

  console.log('\n=== STAGE B: cadence vet (all candidates) ===');
  const cache = new Cache();
  const helius = new HeliusClient(cache);
  const vetted: Vetted[] = [];
  for (let i = 0; i < candidates.length; i += 8) {
    const batch = await Promise.all(candidates.slice(i, i + 8).map((c) => vetCadence(helius, c)));
    vetted.push(...batch);
    process.stdout.write('.');
  }
  console.log('');

  const keeps = vetted.filter((v) => v.verdict === 'KEEP');
  const counts = { KEEP: keeps.length, FLAG: 0, FILTER: 0, ERR: 0 };
  for (const v of vetted) if (v.verdict !== 'KEEP') counts[v.verdict]++;
  console.log(`Cadence verdicts: KEEP=${counts.KEEP} FLAG=${counts.FLAG} FILTER=${counts.FILTER} ERR=${counts.ERR}`);

  console.log('\n=== STAGE B2: copy-trade win rate (KEEPs only, best effort) ===');
  const dexscreener = new DexScreenerClient(cache);
  const copyTrade = new CopyTradeAnalyzer(helius, dexscreener, cache);
  for (let i = 0; i < keeps.length; i += 4) {
    const batch = keeps.slice(i, i + 4);
    await Promise.all(
      batch.map(async (v) => {
        try {
          const ct = await copyTrade.enrich(v.addr, 14);
          v.win_rate = ct.win_rate;
          v.ct_trades = ct.trades_analyzed;
        } catch {
          v.win_rate = null;
        }
      }),
    );
    process.stdout.write('.');
  }
  console.log('\n');

  // Final report + JSON artifact
  const byTier = [...keeps].sort((a, b) => a.tier - b.tier || (b.realized ?? 0) - (a.realized ?? 0));
  for (const v of byTier) {
    console.log(
      `  T${v.tier} ${v.addr}  real=${v.realized != null ? '$' + Math.round(v.realized / 1000) + 'K' : '?'} ` +
        `win=${v.win_rate != null ? Math.round(v.win_rate * 100) + '%' : '?'} tx/h=${v.tx_per_h} ` +
        `${v.window ?? ''} ${v.runners ? '[' + v.runners.join(',') + ']' : ''}`,
    );
  }

  const mergedKeeps = [...priorKeeps, ...byTier];
  const artifact = {
    widened_at: new Date().toISOString().slice(0, 10),
    existing_seeds: EXISTING.size - priorKeeps.length,
    candidates_discovered: candidates.length,
    verdict_counts: counts,
    flagged: vetted.filter((v) => v.verdict === 'FLAG'),
    keeps: mergedKeeps,
  };
  writeFileSync(RESULT_PATH, JSON.stringify(artifact, null, 2));
  console.log(
    `\nWrote ${RESULT_PATH} — ${keeps.length} new KEEPs this run, ${mergedKeeps.length} accumulated (existing seed file: ${EXISTING.size - priorKeeps.length})`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
