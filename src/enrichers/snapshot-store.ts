import type { Cache } from '../cache';
import { CACHE_TTL } from '../config';
import type { TokenEnrichment } from './token-analyzer';
import type { WalletEnrichment } from './wallet-profiler';
import type { PerpsTraderProfile, PerpsMarketStructure } from '../sources/jupiter-perps';

// --- Snapshot Types ---

export interface TokenSnapshot {
  date: string;
  price_usd: number;
  market_cap: number;
  volume_24h: number;
  liquidity: number;
  holder_count: number;
  concentration_hhi: number | null;
  top1_pct: number | null;
  top5_pct: number | null;
  volatility_std: number | null;
  risk_flag_count: number;
}

export interface WalletSnapshot {
  date: string;
  sol_balance: number;
  portfolio_value_usd: number;
  token_count: number;
  nft_count: number;
  tx_count_30d: number;
  risk_score: number;
  risk_level: string;
  label_count: number;
  defi_position_count: number;
  top_holding_mints: string[];
}

export interface PerpsPositionSnapshotEntry {
  position_id: string; // `${custody}:${side}` — stable identity across snapshots
  market_symbol: string;
  side: 'long' | 'short';
  size_usd: number;
  collateral_usd: number;
  leverage: number;
  entry_price_usd: number;
  mark_price_usd: number | null;
  unrealized_pnl_usd: number | null;
  unrealized_pnl_pct: number | null;
}

export interface PerpsSnapshot {
  date: string;
  address: string;
  has_positions: boolean;
  position_count: number;
  total_collateral_usd: number;
  total_unrealized_pnl_usd: number;
  weighted_leverage: number;
  positions: PerpsPositionSnapshotEntry[];
}

export interface PerpsMarketSnapshot {
  date: string;
  symbol: 'SOL' | 'BTC' | 'ETH';
  mark_price_usd: number | null;
  long_oi_usd: number;
  short_oi_usd: number;
  total_oi_usd: number;
  long_pct: number;
  short_pct: number;
  utilization_pct: number;
  borrow_rate_annualized_pct: number;
}

// --- Store ---

export class SnapshotStore {
  constructor(private cache: Cache) {}

  /** Capture a token snapshot (fire-and-forget, one per day per mint) */
  async captureTokenSnapshot(enrichment: TokenEnrichment): Promise<void> {
    const date = todayUTC();
    const key = `snapshot:token:${enrichment.mint}:${date}`;

    const snapshot: TokenSnapshot = {
      date,
      price_usd: enrichment.price_usd,
      market_cap: enrichment.market_cap,
      volume_24h: enrichment.volume_24h,
      liquidity: enrichment.liquidity,
      holder_count: enrichment.holder_count,
      concentration_hhi: enrichment.concentration?.herfindahl_index ?? null,
      top1_pct: enrichment.concentration?.top1_pct ?? null,
      top5_pct: enrichment.concentration?.top5_pct ?? null,
      volatility_std: enrichment.volatility?.daily_std_7d ?? null,
      risk_flag_count: enrichment.risk_flags.length,
    };

    await this.cache.setIfAbsent(key, snapshot, CACHE_TTL.snapshot);
  }

  /** Capture a wallet snapshot (fire-and-forget, one per day per address) */
  async captureWalletSnapshot(enrichment: WalletEnrichment): Promise<void> {
    const date = todayUTC();
    const key = `snapshot:wallet:${enrichment.address}:${date}`;

    const snapshot: WalletSnapshot = {
      date,
      sol_balance: enrichment.sol_balance,
      portfolio_value_usd: enrichment.portfolio_value_usd,
      token_count: enrichment.token_count,
      nft_count: enrichment.nft_count,
      tx_count_30d: enrichment.tx_count_30d,
      risk_score: enrichment.risk_score,
      risk_level: enrichment.risk_level,
      label_count: enrichment.labels.length,
      defi_position_count: enrichment.defi_positions.length,
      top_holding_mints: enrichment.top_holdings.slice(0, 5).map(h => h.mint),
    };

    await this.cache.setIfAbsent(key, snapshot, CACHE_TTL.snapshot);
  }

  /** Get token snapshots for the last N days */
  async getTokenSnapshots(mint: string, days: number): Promise<TokenSnapshot[]> {
    const keys = dateKeys(`snapshot:token:${mint}`, days);
    const results = await this.cache.mget<TokenSnapshot>(keys);
    return results.filter((r): r is TokenSnapshot => r !== null).sort((a, b) => a.date.localeCompare(b.date));
  }

  /** Get wallet snapshots for the last N days */
  async getWalletSnapshots(address: string, days: number): Promise<WalletSnapshot[]> {
    const keys = dateKeys(`snapshot:wallet:${address}`, days);
    const results = await this.cache.mget<WalletSnapshot>(keys);
    return results.filter((r): r is WalletSnapshot => r !== null).sort((a, b) => a.date.localeCompare(b.date));
  }

  /** Capture a perps position snapshot for a wallet (fire-and-forget, one per day) */
  async capturePerpsSnapshot(profile: PerpsTraderProfile): Promise<void> {
    const date = todayUTC();
    const key = `snapshot:perps:${profile.address}:${date}`;

    const positions: PerpsPositionSnapshotEntry[] = profile.positions.map(p => ({
      position_id: `${p.custody}:${p.side}`,
      market_symbol: p.market_symbol,
      side: p.side,
      size_usd: p.size_usd,
      collateral_usd: p.collateral_usd,
      leverage: p.leverage,
      entry_price_usd: p.entry_price_usd,
      mark_price_usd: p.mark_price_usd,
      unrealized_pnl_usd: p.unrealized_pnl_usd,
      unrealized_pnl_pct: p.unrealized_pnl_pct,
    }));

    const snapshot: PerpsSnapshot = {
      date,
      address: profile.address,
      has_positions: profile.has_positions,
      position_count: profile.positions.length,
      total_collateral_usd: profile.totals.total_collateral_usd,
      total_unrealized_pnl_usd: profile.totals.total_unrealized_pnl_usd,
      weighted_leverage: profile.totals.weighted_leverage,
      positions,
    };

    await this.cache.setIfAbsent(key, snapshot, CACHE_TTL.snapshot);
  }

  /** Get perps snapshots for the last N days */
  async getPerpsSnapshots(address: string, days: number): Promise<PerpsSnapshot[]> {
    const keys = dateKeys(`snapshot:perps:${address}`, days);
    const results = await this.cache.mget<PerpsSnapshot>(keys);
    return results.filter((r): r is PerpsSnapshot => r !== null).sort((a, b) => a.date.localeCompare(b.date));
  }

  /** Capture one perps market snapshot per tradable symbol (SOL/BTC/ETH) per day */
  async capturePerpsMarketSnapshot(structure: PerpsMarketStructure): Promise<void> {
    const date = todayUTC();
    await Promise.all(
      structure.markets.map(m => {
        const snapshot: PerpsMarketSnapshot = {
          date,
          symbol: m.symbol,
          mark_price_usd: m.mark_price_usd,
          long_oi_usd: m.open_interest.long_usd,
          short_oi_usd: m.open_interest.short_usd,
          total_oi_usd: m.open_interest.total_usd,
          long_pct: m.open_interest.long_pct,
          short_pct: m.open_interest.short_pct,
          utilization_pct: m.utilization_pct,
          borrow_rate_annualized_pct: m.borrow_rate.annualized_pct,
        };
        const key = `snapshot:perps-market:${m.symbol}:${date}`;
        return this.cache.setIfAbsent(key, snapshot, CACHE_TTL.snapshot);
      }),
    );
  }

  /** Get perps market snapshots for one symbol over the last N days */
  async getPerpsMarketSnapshots(
    symbol: 'SOL' | 'BTC' | 'ETH',
    days: number,
  ): Promise<PerpsMarketSnapshot[]> {
    const keys = dateKeys(`snapshot:perps-market:${symbol}`, days);
    const results = await this.cache.mget<PerpsMarketSnapshot>(keys);
    return results
      .filter((r): r is PerpsMarketSnapshot => r !== null)
      .sort((a, b) => a.date.localeCompare(b.date));
  }
}

// --- Helpers ---

function todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function dateKeys(prefix: string, days: number): string[] {
  const keys: string[] = [];
  const now = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - i);
    keys.push(`${prefix}:${d.toISOString().slice(0, 10)}`);
  }
  return keys;
}
