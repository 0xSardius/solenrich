import type { TokenAnalyzer, TokenEnrichment } from './token-analyzer';
import type { WalletProfiler, WalletEnrichment } from './wallet-profiler';
import { formatTimestamp } from '../utils/normalize';

// --- Token Comparison ---

export interface TokenRanking {
  metric: string;
  winner: string;  // mint address
  values: Record<string, number | string>;
}

export interface TokenComparison {
  tokens: TokenEnrichment[];
  rankings: TokenRanking[];
  summary: {
    safest: string;
    most_liquid: string;
    best_distributed: string;
    lowest_volatility: string | null;
  };
  last_updated: string;
}

export class TokenComparator {
  constructor(private tokenAnalyzer: TokenAnalyzer) {}

  async compare(mints: string[]): Promise<TokenComparison> {
    const tokens = await Promise.all(
      mints.map((mint) => this.tokenAnalyzer.enrich(mint, true)),
    );

    const rankings: TokenRanking[] = [];

    // Price
    rankings.push(rank('price', tokens, (t) => t.price_usd, 'high', (t) => `$${t.price_usd}`));

    // Market cap
    rankings.push(rank('market_cap', tokens, (t) => t.market_cap, 'high', (t) => `$${fmt(t.market_cap)}`));

    // 24h volume
    rankings.push(rank('volume_24h', tokens, (t) => t.volume_24h, 'high', (t) => `$${fmt(t.volume_24h)}`));

    // Liquidity
    rankings.push(rank('liquidity', tokens, (t) => t.liquidity, 'high', (t) => `$${fmt(t.liquidity)}`));

    // Risk flags (fewer = better)
    rankings.push(rank('risk_flags', tokens, (t) => t.risk_flags.length, 'low', (t) => `${t.risk_flags.length} flags`));

    // Holder concentration — lower HHI = more distributed
    const withHHI = tokens.filter((t) => t.concentration);
    if (withHHI.length === tokens.length) {
      rankings.push(rank('holder_concentration_hhi', tokens, (t) => t.concentration!.herfindahl_index, 'low', (t) => `HHI ${t.concentration!.herfindahl_index}`));
    }

    // Volatility — lower = more stable
    const withVol = tokens.filter((t) => t.volatility);
    if (withVol.length === tokens.length) {
      rankings.push(rank('volatility', tokens, (t) => t.volatility!.daily_std_7d, 'low', (t) => `${t.volatility!.daily_std_7d}% daily`));
    }

    // Summary picks
    const safest = [...tokens].sort((a, b) => a.risk_flags.length - b.risk_flags.length)[0];
    const mostLiquid = [...tokens].sort((a, b) => b.liquidity - a.liquidity)[0];
    const bestDistributed = tokens.filter((t) => t.concentration)
      .sort((a, b) => (a.concentration?.herfindahl_index ?? 9999) - (b.concentration?.herfindahl_index ?? 9999))[0] ?? tokens[0];
    const lowestVol = tokens.filter((t) => t.volatility)
      .sort((a, b) => (a.volatility?.daily_std_7d ?? 999) - (b.volatility?.daily_std_7d ?? 999))[0];

    return {
      tokens,
      rankings,
      summary: {
        safest: safest.mint,
        most_liquid: mostLiquid.mint,
        best_distributed: bestDistributed.mint,
        lowest_volatility: lowestVol?.mint ?? null,
      },
      last_updated: formatTimestamp(),
    };
  }
}

// --- Wallet Comparison ---

export interface WalletRanking {
  metric: string;
  winner: string;  // address
  values: Record<string, number | string>;
}

export interface WalletComparison {
  wallets: WalletEnrichment[];
  rankings: WalletRanking[];
  summary: {
    highest_value: string;
    most_active: string;
    lowest_risk: string;
    oldest: string | null;
  };
  last_updated: string;
}

export class WalletComparator {
  constructor(private walletProfiler: WalletProfiler) {}

  async compare(addresses: string[], depth: 'light' | 'full'): Promise<WalletComparison> {
    const wallets = await Promise.all(
      addresses.map((addr) => this.walletProfiler.enrich(addr, depth)),
    );

    const rankings: WalletRanking[] = [];

    // Portfolio value
    rankings.push(rankW('portfolio_value', wallets, (w) => w.portfolio_value_usd, 'high', (w) => `$${fmt(w.portfolio_value_usd)}`));

    // SOL balance
    rankings.push(rankW('sol_balance', wallets, (w) => w.sol_balance, 'high', (w) => `${w.sol_balance.toFixed(2)} SOL`));

    // Token count
    rankings.push(rankW('token_diversity', wallets, (w) => w.token_count, 'high', (w) => `${w.token_count} tokens`));

    // Activity (tx count 30d)
    rankings.push(rankW('activity_30d', wallets, (w) => w.tx_count_30d, 'high', (w) => `${w.tx_count_30d} txs`));

    // Risk score (lower = better)
    rankings.push(rankW('risk_score', wallets, (w) => w.risk_score, 'low', (w) => `${w.risk_score.toFixed(2)} (${w.risk_level})`));

    // Wallet age (older = more established)
    const withDates = wallets.filter((w) => w.first_tx_date);
    if (withDates.length === wallets.length) {
      rankings.push(rankW('wallet_age', wallets, (w) => new Date(w.first_tx_date!).getTime(), 'low', (w) => w.first_tx_date!.split('T')[0]));
    }

    // Summary picks
    const highestValue = [...wallets].sort((a, b) => b.portfolio_value_usd - a.portfolio_value_usd)[0];
    const mostActive = [...wallets].sort((a, b) => b.tx_count_30d - a.tx_count_30d)[0];
    const lowestRisk = [...wallets].sort((a, b) => a.risk_score - b.risk_score)[0];
    const oldest = withDates.sort((a, b) => new Date(a.first_tx_date!).getTime() - new Date(b.first_tx_date!).getTime())[0];

    return {
      wallets,
      rankings,
      summary: {
        highest_value: highestValue.address,
        most_active: mostActive.address,
        lowest_risk: lowestRisk.address,
        oldest: oldest?.address ?? null,
      },
      last_updated: formatTimestamp(),
    };
  }
}

// --- Helpers ---

function fmt(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(2);
}

function rank(
  metric: string,
  tokens: TokenEnrichment[],
  getValue: (t: TokenEnrichment) => number,
  direction: 'high' | 'low',
  formatValue: (t: TokenEnrichment) => string,
): TokenRanking {
  const sorted = [...tokens].sort((a, b) =>
    direction === 'high' ? getValue(b) - getValue(a) : getValue(a) - getValue(b),
  );
  const values: Record<string, string> = {};
  for (const t of tokens) values[t.mint] = formatValue(t);
  return { metric, winner: sorted[0].mint, values };
}

function rankW(
  metric: string,
  wallets: WalletEnrichment[],
  getValue: (w: WalletEnrichment) => number,
  direction: 'high' | 'low',
  formatValue: (w: WalletEnrichment) => string,
): WalletRanking {
  const sorted = [...wallets].sort((a, b) =>
    direction === 'high' ? getValue(b) - getValue(a) : getValue(a) - getValue(b),
  );
  const values: Record<string, string> = {};
  for (const w of wallets) values[w.address] = formatValue(w);
  return { metric, winner: sorted[0].address, values };
}
