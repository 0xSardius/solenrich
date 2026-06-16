#!/usr/bin/env bun
/**
 * Hyperliquid copy-edge validation — CUT 2 (Step 0 of the hyperliquid-smart-money build).
 *
 * Cut 1 finding: ranking the leaderboard by absolute month PnL surfaces market-makers and mega-funds,
 * not copyable directional traders. Fills are capped at 2000 (realized PnL undercounts for the active
 * ones) and leaderboard "pnl" conflates deposits/withdrawals with trading. So cut 1 was inconclusive
 * on copy-edge but produced a clean *positioning* signal.
 *
 * Cut 2 fixes the methodology to actually answer: after excluding MM/HFT and mega-funds, is there a
 * population of CONSISTENT, copyable directional traders — how many, how good, and what are they doing?
 *   - MM/HFT filter: turnover = monthVlm / accountValue (MMs churn 40–200x their book/month).
 *   - Copyable band: $100k ≤ accountValue ≤ $20M (exclude dust AND mega-fund/MM whales).
 *   - Clean PnL: portfolio `pnlHistory` (trading PnL, resets at window start) not capped fills.
 *   - Consistency: require BOTH week and month trading PnL > 0.
 *   - Not-systematic: ≤ 15 simultaneous open positions (80-coin hedged books are MM/systematic).
 *
 * Run: bun run test/hl-copy-edge-validation.ts
 */

const INFO = 'https://api.hyperliquid.xyz/info';
const LEADERBOARD = 'https://stats-data.hyperliquid.xyz/Mainnet/leaderboard';

const MIN_ACCT = 100_000;
const MAX_ACCT = 20_000_000;
const MAX_TURNOVER = 40;       // monthVlm / accountValue above this = MM/HFT
const MAX_POSITIONS = 15;      // more simultaneous positions than this = systematic/MM
const CANDIDATE_POOL = 60;     // top-by-month-ROI to inspect after the cheap filters
const CONCURRENCY = 4;

type Perf = { pnl: number; roi: number; vlm: number };
interface Trader {
  address: string;
  accountValue: number;
  monthRoi: number;
  weekRoi: number;
  turnover: number;
  monthTradingPnl?: number;
  weekTradingPnl?: number;
  positionCount?: number;
  netBias?: 'LONG' | 'SHORT' | 'FLAT';
  positions?: Array<{ coin: string; dir: 'LONG' | 'SHORT'; notional: number; lev: number; uPnl: number }>;
  copyable?: boolean;
  rejectReason?: string;
  error?: string;
}

async function post(body: unknown): Promise<any> {
  const res = await fetch(INFO, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`HL ${res.status}`);
  return res.json();
}
function getWindow(perfs: Array<[string, any]>, name: string): Perf | null {
  const row = perfs?.find((p) => p[0] === name);
  if (!row) return null;
  return { pnl: Number(row[1].pnl), roi: Number(row[1].roi), vlm: Number(row[1].vlm) };
}
function lastPnl(portfolio: any[], window: string): number {
  const row = portfolio?.find?.((p: any) => p[0] === window);
  const hist = row?.[1]?.pnlHistory;
  if (!hist?.length) return NaN;
  return Number(hist[hist.length - 1][1]);
}
function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const usd = (n: number) => (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const pct = (n: number) => (n * 100).toFixed(1) + '%';
const short = (a: string) => a.slice(0, 6) + '…' + a.slice(-4);

async function inspect(t: Trader): Promise<void> {
  try {
    const [portfolio, state] = await Promise.all([
      post({ type: 'portfolio', user: t.address }),
      post({ type: 'clearinghouseState', user: t.address }),
    ]);
    t.monthTradingPnl = lastPnl(portfolio, 'month');
    t.weekTradingPnl = lastPnl(portfolio, 'week');

    const positions: Trader['positions'] = [];
    let net = 0;
    for (const ap of state?.assetPositions ?? []) {
      const p = ap.position;
      const szi = Number(p?.szi ?? 0);
      if (!p || szi === 0) continue;
      const notional = Math.abs(Number(p.positionValue ?? 0));
      const dir = szi > 0 ? 'LONG' : 'SHORT';
      net += szi > 0 ? notional : -notional;
      positions.push({ coin: p.coin, dir, notional, lev: Number(p.leverage?.value ?? 0), uPnl: Number(p.unrealizedPnl ?? 0) });
    }
    t.positions = positions;
    t.positionCount = positions.length;
    t.netBias = net > 0 ? 'LONG' : net < 0 ? 'SHORT' : 'FLAT';

    // Copyable = consistent (week+month trading PnL > 0) AND directional (not a systematic book)
    if (!(t.monthTradingPnl > 0)) { t.copyable = false; t.rejectReason = 'month PnL <= 0'; return; }
    if (!(t.weekTradingPnl > 0)) { t.copyable = false; t.rejectReason = 'week PnL <= 0 (not consistent)'; return; }
    if ((t.positionCount ?? 0) > MAX_POSITIONS) { t.copyable = false; t.rejectReason = `${t.positionCount} positions (systematic/MM)`; return; }
    t.copyable = true;
  } catch (err) {
    t.error = (err as Error).message;
  }
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

async function main() {
  console.log(`\n=== Hyperliquid copy-edge validation — CUT 2 (MM-filtered, consistency-tested) ===\n`);
  const lb = await fetch(LEADERBOARD).then((r) => r.json());
  const rows: any[] = lb.leaderboardRows ?? lb ?? [];
  console.log(`Leaderboard rows: ${rows.length}`);

  // Cheap filters from leaderboard data alone
  let inBand = 0, notMM = 0;
  const candidates: Trader[] = [];
  for (const r of rows) {
    const acct = Number(r.accountValue);
    const month = getWindow(r.windowPerformances, 'month');
    const week = getWindow(r.windowPerformances, 'week');
    if (!month || !week || !Number.isFinite(acct)) continue;
    if (acct < MIN_ACCT || acct > MAX_ACCT) continue;
    inBand++;
    const turnover = month.vlm / acct;
    if (turnover > MAX_TURNOVER) continue; // MM/HFT
    notMM++;
    if (month.roi <= 0) continue;
    candidates.push({ address: r.ethAddress, accountValue: acct, monthRoi: month.roi, weekRoi: week.roi, turnover });
  }
  candidates.sort((a, b) => b.monthRoi - a.monthRoi);
  const pool_ = candidates.slice(0, CANDIDATE_POOL);

  console.log(`In copyable band ($100k–$20M):        ${inBand}`);
  console.log(`After MM/HFT turnover filter (<=${MAX_TURNOVER}x):  ${notMM}`);
  console.log(`With positive month ROI:              ${candidates.length}`);
  console.log(`Inspecting top ${pool_.length} by month ROI (clean PnL + positions)…\n`);

  await pool(pool_, CONCURRENCY, inspect);

  const inspected = pool_.filter((t) => !t.error);
  const copyable = inspected.filter((t) => t.copyable);

  console.log('── Copyable directional traders (consistent week+month, ≤15 positions) ──\n');
  for (const t of copyable) {
    const posStr = t.positions?.length
      ? t.positions.map((p) => `${p.dir} ${p.coin} ${p.lev}x`).join(', ')
      : 'flat';
    console.log(
      `${short(t.address)}  acct ${usd(t.accountValue).padStart(11)} | ` +
        `month ROI ${pct(t.monthRoi).padStart(7)} | week ${pct(t.weekRoi).padStart(7)} | ` +
        `month PnL ${usd(t.monthTradingPnl ?? 0).padStart(11)} | turnover ${t.turnover.toFixed(1)}x | ${t.netBias}`,
    );
    console.log(`        now: ${posStr}`);
  }

  console.log('\n── Attrition (how rare is a clean copyable trader?) ──');
  console.log(`Candidate pool inspected:   ${inspected.length}`);
  console.log(`Passed consistency+directional: ${copyable.length} (${pct(copyable.length / Math.max(1, inspected.length))})`);
  const rejects = inspected.filter((t) => !t.copyable);
  const reasons = new Map<string, number>();
  for (const t of rejects) {
    const key = t.rejectReason?.replace(/\d+/g, 'N') ?? 'unknown';
    reasons.set(key, (reasons.get(key) ?? 0) + 1);
  }
  for (const [reason, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`  rejected — ${reason}: ${n}`);

  if (copyable.length) {
    console.log('\n── The ROI verdict (among copyable traders) ──');
    console.log(`Median month ROI:        ${pct(median(copyable.map((t) => t.monthRoi)))}`);
    console.log(`Median week ROI:         ${pct(median(copyable.map((t) => t.weekRoi)))}`);
    console.log(`Median month trading PnL:${usd(median(copyable.map((t) => t.monthTradingPnl ?? 0)))}`);
  }

  // Positioning heatmap among copyable traders — the cleaner hyperliquid-smart-money signal
  const coinAgg = new Map<string, { long: number; short: number; net: number }>();
  for (const t of copyable) {
    for (const p of t.positions ?? []) {
      const c = coinAgg.get(p.coin) ?? { long: 0, short: 0, net: 0 };
      if (p.dir === 'LONG') c.long++; else c.short++;
      c.net += p.dir === 'LONG' ? p.notional : -p.notional;
      coinAgg.set(p.coin, c);
    }
  }
  const heat = [...coinAgg.entries()].sort((a, b) => (b[1].long + b[1].short) - (a[1].long + a[1].short)).slice(0, 12);
  console.log('\n── Smart-money positioning among COPYABLE traders (the endpoint preview) ──\n');
  for (const [coin, c] of heat) {
    const bias = c.net > 0 ? 'NET LONG' : c.net < 0 ? 'NET SHORT' : 'BALANCED';
    console.log(`${coin.padEnd(8)} ${c.long}L / ${c.short}S  ${bias.padEnd(10)} net ${usd(c.net)}`);
  }

  const fs = await import('node:fs');
  fs.mkdirSync('local/research', { recursive: true });
  fs.writeFileSync('local/research/hl-copy-edge-validation.json', JSON.stringify({
    generated_at: new Date().toISOString(),
    filters: { MIN_ACCT, MAX_ACCT, MAX_TURNOVER, MAX_POSITIONS },
    funnel: { in_band: inBand, not_mm: notMM, positive_roi: candidates.length, inspected: inspected.length, copyable: copyable.length },
    copyable, positioning: heat.map(([coin, c]) => ({ coin, ...c })),
  }, null, 2));
  console.log(`\nReceipts → local/research/hl-copy-edge-validation.json\n`);
}

main().catch((e) => { console.error('Validation failed:', e); process.exit(1); });
