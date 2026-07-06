// Resolve the REAL contract addresses for known community runners (user-supplied)
// so we can mine their early/top buyers for the smart-money-trenches seed set.
// Many imposters share a ticker -> rank by liquidity+mcap, show top matches to confirm.
// Run: bun run test/trenches-find-runners.ts

const DS = 'https://api.dexscreener.com';
const TICKERS = ['ANSEM', 'JOTCHUA', 'TRIPLET', 'NEET', 'BUTTCOIN'];

const fmt = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${n.toFixed(0)}`);
const age = (h: number | null) => (h == null ? '?' : h >= 24 ? `${(h / 24).toFixed(0)}d` : `${h.toFixed(0)}h`);

async function search(q: string) {
  const res = await fetch(`${DS}/latest/dex/search?q=${encodeURIComponent(q)}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) return [];
  const raw: any = await res.json();
  const pairs = (raw.pairs ?? []).filter((p: any) => p.chainId === 'solana');
  // Collapse to unique base token, keep highest-liquidity pair per token
  const byMint = new Map<string, any>();
  for (const p of pairs) {
    const mint = p.baseToken?.address;
    if (!mint) continue;
    const prev = byMint.get(mint);
    if (!prev || (p.liquidity?.usd ?? 0) > (prev.liquidity?.usd ?? 0)) byMint.set(mint, p);
  }
  return [...byMint.values()]
    .map((p) => ({
      mint: p.baseToken.address,
      symbol: p.baseToken.symbol,
      name: p.baseToken.name,
      mcap: p.marketCap ?? p.fdv ?? 0,
      liq: p.liquidity?.usd ?? 0,
      vol24: p.volume?.h24 ?? 0,
      ageH: p.pairCreatedAt ? (Date.now() - p.pairCreatedAt) / 3_600_000 : null,
    }))
    .sort((a, b) => b.liq - a.liq)
    .slice(0, 3);
}

async function main() {
  for (const t of TICKERS) {
    console.log(`\n=== ${t} ===`);
    const matches = await search(t);
    if (!matches.length) {
      console.log('  (no Solana matches)');
      continue;
    }
    for (const m of matches) {
      console.log(
        `  ${(m.symbol ?? '?').padEnd(10)} ${(m.name ?? '').slice(0, 20).padEnd(22)} mcap ${fmt(m.mcap).padEnd(8)} liq ${fmt(m.liq).padEnd(8)} vol24 ${fmt(m.vol24).padEnd(8)} age ${age(m.ageH).padEnd(5)} ${m.mint}`,
      );
    }
  }
}

main().catch((e) => console.error(e));
