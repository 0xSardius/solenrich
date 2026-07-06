// Throwaway comb: surface recent-runner CANDIDATES from DexScreener for the
// smart-money-trenches seed-wallet bootstrap. We review these together, pick the
// real runners, then mine their early/top buyers for the seed list.
//
// Signal = boosted (someone's promoting it) AND already-run (decent mcap+vol,
// age past the first few hours so early buyers have shown themselves).
// Run: bun run test/trenches-comb-runners.ts

const DS = 'https://api.dexscreener.com';

interface Pair {
  chainId: string;
  baseToken: { address: string; name: string; symbol: string };
  priceChange?: { h1?: number; h6?: number; h24?: number };
  volume?: { h24?: number };
  liquidity?: { usd?: number };
  marketCap?: number;
  fdv?: number;
  pairCreatedAt?: number;
}

async function tokenMetrics(mint: string) {
  try {
    const res = await fetch(`${DS}/tokens/v1/solana/${mint}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    const pairs: Pair[] = await res.json();
    if (!pairs?.length) return null;
    const sorted = [...pairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const p = sorted[0];
    const created = pairs.map((x) => x.pairCreatedAt).filter((t): t is number => !!t);
    const ageH = created.length ? (Date.now() - Math.min(...created)) / 3_600_000 : null;
    return {
      mint,
      symbol: p.baseToken.symbol,
      name: p.baseToken.name,
      mcap: p.marketCap ?? p.fdv ?? 0,
      vol24: pairs.reduce((s, x) => s + (x.volume?.h24 ?? 0), 0),
      liq: pairs.reduce((s, x) => s + (x.liquidity?.usd ?? 0), 0),
      chg24: p.priceChange?.h24 ?? 0,
      chg6: p.priceChange?.h6 ?? 0,
      ageH,
    };
  } catch {
    return null;
  }
}

async function main() {
  // Boosted tokens = actively promoted (runner or attempted-runner proxy)
  const boostsRes = await fetch(`${DS}/token-boosts/top/v1`, { headers: { Accept: 'application/json' } });
  const boosts: any[] = boostsRes.ok ? await boostsRes.json() : [];
  const profilesRes = await fetch(`${DS}/token-profiles/latest/v1`, { headers: { Accept: 'application/json' } });
  const profiles: any[] = profilesRes.ok ? await profilesRes.json() : [];

  const solMints = new Set<string>();
  for (const b of boosts) if (b.chainId === 'solana' && b.tokenAddress) solMints.add(b.tokenAddress);
  for (const p of profiles) if (p.chainId === 'solana' && p.tokenAddress) solMints.add(p.tokenAddress);

  console.log(`Combed ${boosts.length} boosts + ${profiles.length} profiles -> ${solMints.size} unique Solana mints\n`);

  const mints = [...solMints].slice(0, 60);
  const metrics: any[] = [];
  for (let i = 0; i < mints.length; i += 6) {
    const batch = await Promise.all(mints.slice(i, i + 6).map(tokenMetrics));
    metrics.push(...batch.filter(Boolean));
  }

  // Runner candidate filter: past the first-hours chaos, real size, not a dead shell.
  const runners = metrics
    .filter((m) => m.ageH != null && m.ageH >= 6 && m.mcap >= 300_000 && m.vol24 >= 100_000 && m.liq >= 20_000)
    .sort((a, b) => b.vol24 / Math.max(1, b.mcap) - a.vol24 / Math.max(1, a.mcap)); // vol/mcap = real churn

  const fmt = (n: number) => (n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${(n / 1e3).toFixed(0)}K`);
  const age = (h: number | null) => (h == null ? '?' : h >= 24 ? `${(h / 24).toFixed(1)}d` : `${h.toFixed(0)}h`);

  console.log(`RUNNER CANDIDATES (age>=6h, mcap>=$300K, vol24>=$100K, liq>=$20K) — ${runners.length} found\n`);
  console.log('SYMBOL'.padEnd(14) + 'MCAP'.padEnd(9) + 'VOL24'.padEnd(9) + 'LIQ'.padEnd(9) + 'AGE'.padEnd(7) + '24H%'.padEnd(9) + 'MINT');
  for (const m of runners.slice(0, 30)) {
    console.log(
      (m.symbol ?? '?').slice(0, 12).padEnd(14) +
        fmt(m.mcap).padEnd(9) +
        fmt(m.vol24).padEnd(9) +
        fmt(m.liq).padEnd(9) +
        age(m.ageH).padEnd(7) +
        `${m.chg24 > 0 ? '+' : ''}${m.chg24.toFixed(0)}%`.padEnd(9) +
        m.mint,
    );
  }
}

main().catch((e) => console.error(e));
