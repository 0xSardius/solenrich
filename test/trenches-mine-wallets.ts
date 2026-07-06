// Mine candidate seed wallets from KNOWN-GOOD runners (user-supplied, hand-verified CAs).
// Signal = a wallet that shows up as a top trader/holder across MULTIPLE proven runners.
// Uses Birdeye top_traders (who's actively winning) + top holders (conviction).
// Run: bun run test/trenches-mine-wallets.ts   (Bun auto-loads .env for BIRDEYE_API_KEY)

const BIRDEYE = 'https://public-api.birdeye.so';
const KEY = process.env.BIRDEYE_API_KEY ?? '';

const RUNNERS: Record<string, string> = {
  ANSEM: '9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump',
  TRIPLET: 'J8PSdNP3QewKq2Z1JJJFDMaqF7KcaiJhR7gbr5KZpump',
  NEET: 'Ce2gx9KGXJ6C9Mp5b5x1sn9Mg87JwEbrQby4Zqo3pump',
  BUTTCOIN: 'Cm6fNnMk7NfzStP9CZpsQA2v3jjzbcYGAxdJySmHpump',
};

// Known non-trader owners to exclude (LPs, routers, CEX, program vaults).
const EXCLUDE = new Set<string>([
  '5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', // Raydium authority V4 (common)
]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function birdeye(path: string) {
  await sleep(1200); // Birdeye free tier = 1 rps; pace every call
  const res = await fetch(`${BIRDEYE}${path}`, {
    headers: { 'X-API-KEY': KEY, 'x-chain': 'solana', Accept: 'application/json' },
  });
  if (!res.ok) return { ok: false, status: res.status, data: null as any };
  return { ok: true, status: 200, data: await res.json() };
}

async function topTraders(mint: string): Promise<string[]> {
  const r = await birdeye(`/defi/v2/tokens/top_traders?address=${mint}&time_frame=24h&sort_by=volume&sort_type=desc&offset=0&limit=10`);
  if (!r.ok) return [];
  const items = r.data?.data?.items ?? [];
  return items.map((i: any) => i.owner).filter(Boolean);
}

async function topHolders(mint: string): Promise<string[]> {
  const r = await birdeye(`/defi/v3/token/holder?address=${mint}&offset=0&limit=20`);
  if (!r.ok) return [];
  const items = r.data?.data?.items ?? [];
  return items.map((i: any) => i.owner).filter(Boolean);
}

async function main() {
  if (!KEY) {
    console.log('No BIRDEYE_API_KEY in env — cannot mine via Birdeye. Fall back to RPC top holders.');
    return;
  }

  // wallet -> { runners it appears in, whether via trader/holder }
  const tally = new Map<string, { runners: Set<string>; asTrader: Set<string>; asHolder: Set<string> }>();
  const bump = (w: string, runner: string, kind: 'trader' | 'holder') => {
    if (EXCLUDE.has(w)) return;
    if (!tally.has(w)) tally.set(w, { runners: new Set(), asTrader: new Set(), asHolder: new Set() });
    const e = tally.get(w)!;
    e.runners.add(runner);
    (kind === 'trader' ? e.asTrader : e.asHolder).add(runner);
  };

  for (const [name, mint] of Object.entries(RUNNERS)) {
    const traders = await topTraders(mint);
    const holders = await topHolders(mint);
    console.log(`${name.padEnd(9)} traders=${traders.length} holders=${holders.length}`);
    for (const w of traders) bump(w, name, 'trader');
    for (const w of holders) bump(w, name, 'holder');
  }

  const ranked = [...tally.entries()]
    .map(([w, e]) => ({ w, n: e.runners.size, runners: [...e.runners], traderN: e.asTrader.size, holderN: e.asHolder.size }))
    .filter((x) => x.n >= 2) // appears across 2+ proven runners = real signal
    .sort((a, b) => b.n - a.n || b.traderN - a.traderN);

  console.log(`\n=== SEED CANDIDATES (appear across 2+ proven runners) — ${ranked.length} found ===\n`);
  for (const x of ranked) {
    console.log(`  ${x.w}  x${x.n} [${x.runners.join(',')}]  trader:${x.traderN} holder:${x.holderN}`);
  }
  if (ranked.length === 0) {
    console.log('  (none crossed 2 runners — widen: more runners, or lower the bar to 1 + manual vet)');
  }
}

main().catch((e) => console.error(e));
