// Vet the 32 seed candidates through OUR OWN stack (dogfood):
//   - Helius signatures -> bot-detection (regular intervals / high-freq / 24-7)
//   - copy-trade-analyzer -> our own win-rate + hold-time (memecoin-timescale check)
// Verdict strips HFT/MM, keeps human-mirrorable winners.
// Run: bun run test/trenches-vet-seeds.ts   (Bun auto-loads .env; uses HELIUS_API_KEY)

import { Cache } from '../src/cache';
import { HeliusClient } from '../src/sources/helius';
import { DexScreenerClient } from '../src/sources/dexscreener';
import { CopyTradeAnalyzer } from '../src/enrichers/copy-trade-analyzer';
import { detectRegularIntervals, detectHighFrequency, detect247Active } from '../src/enrichers/labeler';

interface Cand { addr: string; tier: 1 | 2 | 3; realized?: number; trades?: number; note?: string }

const CANDIDATES: Cand[] = [
  // Tier 1 — realized winner AND traded a known runner
  { addr: '8s2MNRtz4d8ytu4wu8UnFi8ePWTKUWXB61inL59Trmez', tier: 1, realized: 299_000, trades: 182, note: 'ANSEM' },
  { addr: 'GkdYWRjFzZW3oxbRaPJ43C5385E4GtfgW3vwfK2ZAtac', tier: 1, realized: 214_000, trades: 52, note: 'ANSEM' },
  { addr: '3SdVtYPdnQw2b8WSE2T1VeexAqkDjbTyeSZ8Pzs6bgou', tier: 1, realized: 14_000, trades: 68, note: 'ANSEM' },
  { addr: '8MHU3NwzuwpkcrF8S2nzNXbkCWn3TdE9UVtB3bQWJP7b', tier: 1, realized: 4_000, trades: 71, note: 'ANSEM' },
  // Tier 2 — realized winner only
  { addr: '53mXoBuWXv9NahogwpK3psArrPRPRkgiciYMjGRfgSfX', tier: 2, realized: 406_000, trades: 2145 },
  { addr: '3J9Sq1nrVJQjFpWWAEFYrNnLwyGuWDr7Y3DwNjX4Fdxb', tier: 2, realized: 392_000, trades: 534 },
  { addr: 'GeBJSHK4WsGrz2HRvTbqvWGx4JRMpHfJG2ikzrYBDuwR', tier: 2, realized: 379_000, trades: 1073 },
  { addr: 'HCoUkq7iHecWTVCAVPfH9fBSGbZrgrE2jbHrE1rnCpUV', tier: 2, realized: 298_000, trades: 305 },
  { addr: 'vsTw91AUb4N91zdACyhuz31ctkQZCfY89iTF5pvCWDr', tier: 2, realized: 292_000, trades: 365 },
  { addr: 'H8MQegokeJxeWfNiD3MNk8Bykso99s7qWGdtTKu3hmZY', tier: 2, realized: 269_000, trades: 388 },
  { addr: 'C8HH76sDWvTPHeVnndSxAgj2VrMSpxEpwgc5rFUwD55Y', tier: 2, realized: 246_000, trades: 154 },
  { addr: '4q4GKBpVmXGhXYNaR4DetQjf5WjHEHhbJ9Wgybt7F8Yu', tier: 2, realized: 173_000, trades: 1012 },
  { addr: 'Ap52DXu4E5aYpDSpUwdct9VYXUqHk2foCh5x2YX6b8HN', tier: 2, realized: 162_000, trades: 189 },
  { addr: '6PeU2nLzwWv9V5BKqJBsoq88tAfULjQq9VcUYWK2KW5w', tier: 2, realized: 162_000, trades: 39 },
  { addr: 'qAkJ2SuveYDsN2ZaEPU5gWhF8gWZvsA2Pfizn3B9ZQ5', tier: 2, realized: 160_000, trades: 142 },
  { addr: 'FdhpxuCPYWM98q5q1rHLAYRfXFsHUCzaos5ogz4prR7r', tier: 2, realized: 159_000, trades: 123 },
  { addr: 'HUPHeyBkcSCkHTxS9wsbVcj9UP9wZNXU998g5Csbc9AT', tier: 2, realized: 152_000, trades: 145 },
  { addr: 'BwGNeSNP8SVjkQfz3Z3wpJ65c9mxZomjnbL1r8euN1Vd', tier: 2, realized: 141_000, trades: 136 },
  { addr: 'ARW9NzhpuBVYaYBZo6fW1P1U6LTNwUY6jfi7XC37Sa97', tier: 2, realized: 117_000, trades: 810 },
  { addr: '82DMeNcrCDuc4AhydbZwZamRJ9HtDzczJnL7RRS3NYrW', tier: 2, realized: 96_000, trades: 131 },
  { addr: '2S8E25nAcqvvMYEWZHBQk22GzevwvmsVNAs6Gw5tRX7d', tier: 2, realized: 63_000, trades: 149 },
  { addr: 'HeGgXZexkC2qKmgjfsyB6cbLU7QR8cjcq6bChJGUKjWr', tier: 2, realized: 55_000, trades: 10 },
  { addr: '5SNQJZ9kRrpDWUEksmqYg3hDs5psJPfDSvBrbaCtRMKy', tier: 2, realized: 50_000, trades: 318 },
  { addr: '9Z6B2crrMeMPU4EM4fpSRWgFbSMmjzamekeumMwzkXEh', tier: 2, realized: 33_000, trades: 161 },
  // Tier 3 — memecoin-linked only (PnL unverified)
  { addr: 'AgmLJBMDCqWynYnQiPCuj9ewsNNsBJXyzoUhD9LJzN51', tier: 3, note: 'x5 runners, holds none' },
  { addr: 'gasTzr94Pmp4Gf8vknQnqxeYxdgwFjbgdJa4msYRpnB', tier: 3, note: 'x4, gas vanity' },
  { addr: 'MRiYA4oN3158fCV8evhuCofrDzbHyYvYnGZUDJvoCsa', tier: 3, note: 'x3' },
  { addr: 'DtvmxrTACskMG2W8a6KXgSemUfvyNVeQTgfpJoGvMVKx', tier: 3, note: 'x3' },
  { addr: 'ARu4n5mFdZogZAravu7CcizaojWnS6oqka37gdLT5SZn', tier: 3, note: 'x2' },
  { addr: '5fkAwNVpT8A1UHEnY62VEFpqgagdoP8FYrv5ideiQp5c', tier: 3, note: 'x2' },
  { addr: '22by6osx7q9XX6na4SxuKozd4KMQeJhaoVLeUnBqRXoz', tier: 3, note: 'x2' },
  { addr: '9SBvvPiuXHekiJ8XyPxhWVSa23YHhonD2ATBZTveUbcE', tier: 3, note: 'x2' },
];

const cache = new Cache();
const helius = new HeliusClient(cache);
const dexscreener = new DexScreenerClient(cache);
const copyTrade = new CopyTradeAnalyzer(helius, dexscreener, cache);

interface Vet extends Cand {
  n_tx: number; span_h: number; tx_per_h: number;
  regular: boolean; highFreq: boolean; active247: boolean;
  ct_trades: number; ct_win: number | null; ct_hold_d: number | null;
  verdict: 'FILTER' | 'FLAG' | 'KEEP' | 'ERR';
}

async function vet(c: Cand): Promise<Vet> {
  try {
    const sigs = await helius.getSignaturesForAddress(c.addr, 100);
    const ts = sigs.map((s: any) => s.blockTime).filter((t: any): t is number => typeof t === 'number');
    const span = ts.length >= 2 ? (Math.max(...ts) - Math.min(...ts)) : 0;
    const regular = detectRegularIntervals(ts);
    const highFreq = detectHighFrequency(ts);
    const active247 = detect247Active(ts);

    let ct_trades = 0, ct_win: number | null = null, ct_hold_d: number | null = null;
    try {
      const ct = await copyTrade.enrich(c.addr, 14);
      ct_trades = ct.trades_analyzed; ct_win = ct.win_rate; ct_hold_d = ct.avg_hold_time_days;
    } catch { /* memecoin pricing gaps — best effort */ }

    // HFT/bot by cadence OR leaderboard weekly volume. CRITICAL: the labeler's
    // detect* fns have min-window guards (>=1h high-freq, >=48h 24-7) so bots whose
    // 100 txs span <1h evade them — tx_per_h is the real discriminator for those.
    const txPerH = span > 0 ? ts.length / (span / 3600) : Infinity; // 100 tx in ~0h = burst bot
    const hftByVol = (c.trades ?? 0) >= 700;
    const flagByVol = (c.trades ?? 0) >= 300;
    let verdict: Vet['verdict'];
    if (regular || active247 || hftByVol || txPerH >= 60) verdict = 'FILTER';
    else if (highFreq || flagByVol || txPerH >= 15) verdict = 'FLAG';
    else verdict = 'KEEP';

    return {
      ...c, n_tx: ts.length, span_h: Math.round(span / 3600), tx_per_h: span > 0 ? +(ts.length / (span / 3600)).toFixed(1) : 0,
      regular, highFreq, active247, ct_trades, ct_win, ct_hold_d, verdict,
    };
  } catch {
    return { ...c, n_tx: 0, span_h: 0, tx_per_h: 0, regular: false, highFreq: false, active247: false, ct_trades: 0, ct_win: null, ct_hold_d: null, verdict: 'ERR' };
  }
}

async function main() {
  const results: Vet[] = [];
  for (let i = 0; i < CANDIDATES.length; i += 4) {
    const batch = await Promise.all(CANDIDATES.slice(i, i + 4).map(vet));
    results.push(...batch);
    process.stdout.write('.');
  }
  console.log('\n');

  const flags = (v: Vet) => [v.regular && 'REG', v.highFreq && 'HF', v.active247 && '247'].filter(Boolean).join('|') || '-';
  const line = (v: Vet) => `  ${v.addr.slice(0, 6)}… T${v.tier} ` +
    `real=${v.realized ? '$' + Math.round(v.realized / 1000) + 'K' : '?'} lbTrades=${v.trades ?? '?'} | ` +
    `tx=${v.n_tx} ${v.tx_per_h}/h span=${v.span_h}h botflags=${flags(v)} | ` +
    `ourWin=${v.ct_win != null ? Math.round(v.ct_win * 100) + '%' : '?'} ourTrades=${v.ct_trades} hold=${v.ct_hold_d != null ? v.ct_hold_d.toFixed(2) + 'd' : '?'} ${v.note ?? ''}`;

  for (const verdict of ['KEEP', 'FLAG', 'FILTER', 'ERR'] as const) {
    const group = results.filter((r) => r.verdict === verdict).sort((a, b) => (b.realized ?? 0) - (a.realized ?? 0));
    console.log(`\n===== ${verdict} (${group.length}) =====`);
    for (const v of group) console.log(line(v));
  }

  const keep = results.filter((r) => r.verdict === 'KEEP');
  console.log(`\nSEED SET (KEEP): ${keep.length} wallets`);
  console.log(JSON.stringify(keep.map((k) => k.addr), null, 0));
}

main().catch((e) => console.error(e));
