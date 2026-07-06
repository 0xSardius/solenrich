// Build a TIERED seed-wallet candidate list for smart-money-trenches.
//   Pool A = Birdeye gainers-losers leaderboard, filtered to REALIZED winners (not paper gains).
//   Pool B = top traders/holders of hand-verified known-good runners (memecoin-linked).
// Tier 1 = in BOTH (PnL-verified AND trades known memecoin runners) — strongest.
// Tier 2 = realized winner only.   Tier 3 = memecoin-linked only (PnL unverified).
// Run: bun run test/trenches-build-seeds.ts   (Bun auto-loads .env)

const B = 'https://public-api.birdeye.so';
const K = process.env.BIRDEYE_API_KEY ?? '';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RUNNERS: Record<string, string> = {
  ANSEM: '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump',
  TRIPLET: 'J8PSdNP3QewKq2Z1JJJFDMaqF7KcaiJhR7gbr5KZpump',
  NEET: 'Ce2gx9KGXJ6C9Mp5b5x1sn9Mg87JwEbrQby4Zqo3pump',
  BUTTCOIN: 'Cm6fNnMk7NfzStP9CZpsQA2v3jjzbcYGAxdJySmHpump',
  JOTCHUA: 'BcHEaaTCvycPwwsJ9yQTXdHP9X2gCLkznDbZ8VySpump',
};

async function be(path: string) {
  await sleep(1300);
  const r = await fetch(`${B}${path}`, { headers: { 'X-API-KEY': K, 'x-chain': 'solana' } });
  if (!r.ok) return null;
  return r.json();
}

async function main() {
  // --- Pool A: leaderboard realized winners (10 pages = up to 100) ---
  const board: any[] = [];
  for (let off = 0; off < 100; off += 10) {
    const b = await be(`/trader/gainers-losers?type=1W&sort_by=PnL&sort_type=desc&offset=${off}&limit=10`);
    const items = b?.data?.items ?? [];
    board.push(...items);
    if (items.length < 10) break;
  }
  const realizedWinners = new Map<string, { realized: number; trades: number }>();
  for (const t of board) {
    if ((t.realized_pnl ?? 0) > 0 && (t.trade_count ?? 0) >= 5) {
      realizedWinners.set(t.address, { realized: t.realized_pnl, trades: t.trade_count });
    }
  }
  console.log(`Pool A: leaderboard pulled ${board.length}, realized winners (>0 & >=5 trades): ${realizedWinners.size}`);

  // --- Pool B: runner top traders + holders ---
  const runnerHits = new Map<string, Set<string>>();
  for (const [name, mint] of Object.entries(RUNNERS)) {
    const tt = await be(`/defi/v2/tokens/top_traders?address=${mint}&time_frame=24h&sort_by=volume&sort_type=desc&offset=0&limit=10`);
    const hd = await be(`/defi/v3/token/holder?address=${mint}&offset=0&limit=20`);
    const traders = (tt?.data?.items ?? []).map((i: any) => i.owner).filter(Boolean);
    const holders = (hd?.data?.items ?? []).map((i: any) => i.owner).filter(Boolean);
    for (const w of [...traders, ...holders]) {
      if (!runnerHits.has(w)) runnerHits.set(w, new Set());
      runnerHits.get(w)!.add(name);
    }
    console.log(`  ${name.padEnd(9)} traders=${traders.length} holders=${holders.length}`);
  }

  const k = (n: number) => `$${(n / 1000).toFixed(0)}K`;
  const tier1: string[] = [], tier2: string[] = [], tier3: string[] = [];

  console.log(`\n=== TIER 1 — realized winner AND trades known runners (STRONGEST) ===`);
  for (const [w, pnl] of realizedWinners) {
    if (runnerHits.has(w)) {
      tier1.push(w);
      console.log(`  ${w}  realized=${k(pnl.realized)} trades=${pnl.trades}  runners=[${[...runnerHits.get(w)!].join(',')}]`);
    }
  }
  if (!tier1.length) console.log('  (none — leaderboard is all-Solana; memecoin overlap is rare at this sample size)');

  console.log(`\n=== TIER 2 — realized winner only (top 20 by realized) ===`);
  for (const [w, pnl] of [...realizedWinners].filter(([w]) => !runnerHits.has(w)).sort((a, b) => b[1].realized - a[1].realized).slice(0, 20)) {
    tier2.push(w);
    console.log(`  ${w}  realized=${k(pnl.realized)} trades=${pnl.trades}`);
  }

  console.log(`\n=== TIER 3 — memecoin-linked only, across 2+ runners (PnL unverified) ===`);
  for (const [w, runners] of [...runnerHits].filter(([w, r]) => r.size >= 2 && !realizedWinners.has(w))) {
    tier3.push(w);
    console.log(`  ${w}  runners=[${[...runners].join(',')}]`);
  }

  console.log(`\nSUMMARY: tier1=${tier1.length} tier2=${tier2.length} tier3=${tier3.length}  -> ${tier1.length + tier2.length + tier3.length} candidates to vet`);
}

main().catch((e) => console.error(e));
