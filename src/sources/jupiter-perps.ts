// Jupiter Perps on-chain data client
// Reads custody + position accounts via @coral-xyz/anchor + the published IDL.
// No REST API exists for Jupiter Perps — everything lives in Anchor accounts.

import {
  AnchorProvider,
  BN,
  Program,
  type IdlAccounts,
  type Wallet as AnchorWallet,
} from '@coral-xyz/anchor';
import { Connection, Keypair, PublicKey, type Transaction, type VersionedTransaction } from '@solana/web3.js';

/**
 * Minimal read-only Wallet adapter. Anchor 0.29 ships `Wallet` in CJS but
 * doesn't re-export it from the ESM entry, which breaks `bun build` (static
 * bundler) even though `bun run` tolerates it. We only need .publicKey for
 * AnchorProvider — fetch-only Program calls never invoke the sign methods.
 */
function makeReadOnlyWallet(keypair: Keypair): AnchorWallet {
  return {
    publicKey: keypair.publicKey,
    payer: keypair,
    async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> {
      throw new Error('Read-only wallet — signing not supported');
    },
    async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> {
      throw new Error('Read-only wallet — signing not supported');
    },
  };
}
import { CONFIG, CACHE_TTL } from '../config';
import type { Cache } from '../cache';
import { IDL as PERPS_IDL, type Perpetuals } from '../idl/jupiter-perpetuals-idl';
import { IDL as DOVES_IDL, type Doves } from '../idl/doves-idl';

// --- Constants ---

export const JUPITER_PERPS_PROGRAM_ID = new PublicKey(
  'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu',
);

export const DOVES_PROGRAM_ID = new PublicKey(
  'DoVEsk76QybCEHQGzkvYPWLQu9gzNoZZZt3TPiL597e',
);

export const JLP_POOL = new PublicKey(
  '5BUwFW4nRbftYTDMbgxykoFWqWHPzahFSNAaaaJtVKsq',
);

export const CUSTODY_PUBKEY = {
  SOL: new PublicKey('7xS2gz2bTp3fwCC7knJvUWTEU9Tycczu6VhJYKgi1wdz'),
  BTC: new PublicKey('5Pv3gM9JrFFH883SWAhvJC9RPYmo8UNxuFtv5bMMALkm'),
  ETH: new PublicKey('AQCGyheWPLeo6Qp9WpYS9m3Qj479t7R636N9ey1rEjEn'),
  USDC: new PublicKey('G18jKKXQwBbrHeiK3C9MRXhkHsLHf7XgCSisykV46EZa'),
  USDT: new PublicKey('4vkNeXiYEUizLdrpdPS1eC2mccyM4NUPRtERrk6ZETkk'),
} as const;

// Tradable markets (USDC/USDT are collateral-only)
const TRADABLE_MARKETS: Array<{ symbol: 'SOL' | 'BTC' | 'ETH'; custody: PublicKey }> = [
  { symbol: 'SOL', custody: CUSTODY_PUBKEY.SOL },
  { symbol: 'BTC', custody: CUSTODY_PUBKEY.BTC },
  { symbol: 'ETH', custody: CUSTODY_PUBKEY.ETH },
];

// Scale constants from Jupiter Perps
const USDC_DECIMALS = 6;
const BPS_POWER = 10_000;
const DBPS_POWER = 100_000;
const RATE_POWER = 1_000_000_000; // targetUtilizationRate and cumulativeInterestRate are scaled by 1e9

// --- Types ---

type Custody = IdlAccounts<Perpetuals>['custody'];
type Position = IdlAccounts<Perpetuals>['position'];

export interface PerpsMarketSnapshot {
  symbol: 'SOL' | 'BTC' | 'ETH';
  custody: string;
  mark_price_usd: number | null;
  open_interest: {
    long_usd: number;
    short_usd: number;
    total_usd: number;
    long_pct: number;
    short_pct: number;
    net_skew: 'long' | 'short' | 'balanced';
  };
  utilization_pct: number;
  borrow_rate: {
    hourly_pct: number;
    annualized_pct: number;
    model: 'jump' | 'linear';
  };
  pool_assets: {
    owned_tokens: number;
    locked_tokens: number;
    guaranteed_usd: number;
    global_short_sizes_usd: number;
  };
  limits: {
    max_long_oi_usd: number;
    max_short_oi_usd: number;
    max_position_size_usd: number;
  };
}

export interface PerpsPositionData {
  pool: string;
  custody: string;
  market_symbol: string;
  side: 'long' | 'short';
  size_usd: number;
  collateral_usd: number;
  leverage: number;
  entry_price_usd: number;
  mark_price_usd: number | null;
  unrealized_pnl_usd: number | null;
  unrealized_pnl_pct: number | null;
  realized_pnl_usd: number;
  open_time: number;
  update_time: number;
  age_hours: number;
}

export interface PerpsMarketStructure {
  pool: string;
  markets: PerpsMarketSnapshot[];
  totals: {
    long_oi_usd: number;
    short_oi_usd: number;
    total_oi_usd: number;
    net_skew: 'long' | 'short' | 'balanced';
  };
  fetched_at: number;
}

export interface PerpsTraderProfile {
  address: string;
  has_positions: boolean;
  positions: PerpsPositionData[];
  totals: {
    gross_exposure_usd: number;
    net_exposure_usd: number;
    total_collateral_usd: number;
    total_unrealized_pnl_usd: number;
    weighted_leverage: number;
  };
  fetched_at: number;
}

// --- Helpers ---

function toNumber(bn: BN | undefined | null): number {
  if (!bn) return 0;
  try {
    return bn.toNumber();
  } catch {
    // Too big for JS number — downscale via string
    return Number(bn.toString());
  }
}

function bnDivScaled(num: BN, decimals: number): number {
  // Safely convert a BN with `decimals` decimals to a float
  const str = num.toString();
  const sign = str.startsWith('-') ? -1 : 1;
  const abs = str.startsWith('-') ? str.slice(1) : str;
  if (abs.length <= decimals) {
    return sign * (Number(abs) / 10 ** decimals);
  }
  const whole = abs.slice(0, abs.length - decimals);
  const frac = abs.slice(abs.length - decimals);
  return sign * Number(`${whole}.${frac}`);
}

function computeBorrowRate(custody: Custody): {
  hourly_pct: number;
  annualized_pct: number;
  model: 'jump' | 'linear';
  utilization_pct: number;
} {
  const locked = custody.assets.locked as BN;
  const owned = custody.assets.owned as BN;
  const utilization = owned.isZero() ? 0 : toNumber(locked) / toNumber(owned);

  const jump = custody.jumpRateState;
  const maxRateBps = toNumber(jump.maxRateBps as BN);

  let annualBps = 0;
  let model: 'jump' | 'linear' = 'linear';

  if (maxRateBps > 0) {
    // Jump rate model — rates are annualized bps; utilization target scaled by RATE_POWER (1e9)
    const minBps = toNumber(jump.minRateBps as BN);
    const targetBps = toNumber(jump.targetRateBps as BN);
    const targetUtil = toNumber(jump.targetUtilizationRate as BN) / RATE_POWER;

    if (utilization <= targetUtil && targetUtil > 0) {
      annualBps = minBps + ((targetBps - minBps) * utilization) / targetUtil;
    } else if (targetUtil < 1) {
      annualBps =
        targetBps + ((maxRateBps - targetBps) * (utilization - targetUtil)) / (1 - targetUtil);
    } else {
      annualBps = targetBps;
    }
    model = 'jump';
  } else {
    // Linear: hourlyFundingDbps is in decibels-bps; DBPS_POWER = 100_000 per unit hourly rate
    const dbps = toNumber(custody.fundingRateState.hourlyFundingDbps as BN);
    const hourly_rate = dbps / DBPS_POWER;
    annualBps = hourly_rate * 24 * 365 * BPS_POWER;
    model = 'linear';
  }

  const annual_rate = annualBps / BPS_POWER;
  const hourly_rate = annual_rate / (24 * 365);

  return {
    hourly_pct: hourly_rate * 100,
    annualized_pct: annual_rate * 100,
    model,
    utilization_pct: utilization * 100,
  };
}

// --- Client ---

export class JupiterPerpsClient {
  private conn: Connection;
  private perps: Program<Perpetuals>;
  private doves: Program<Doves>;
  private cache: Cache;

  constructor(cache: Cache) {
    this.conn = new Connection(CONFIG.helius.rpcUrl, 'confirmed');
    this.cache = cache;

    const provider = new AnchorProvider(
      this.conn,
      makeReadOnlyWallet(Keypair.generate()),
      AnchorProvider.defaultOptions(),
    );
    this.perps = new Program<Perpetuals>(PERPS_IDL, JUPITER_PERPS_PROGRAM_ID, provider);
    this.doves = new Program<Doves>(DOVES_IDL, DOVES_PROGRAM_ID, provider);
  }

  /** Fetch a Doves oracle price (u64 price + i8 expo). Tries agPriceFeed first, then priceFeed. */
  private async getOraclePrice(oraclePda: PublicKey): Promise<number | null> {
    try {
      const ag = await this.doves.account.agPriceFeed.fetch(oraclePda);
      const price = toNumber(ag.price as BN);
      const expo = ag.expo as number;
      return price * 10 ** expo;
    } catch {
      // Fall through to priceFeed
    }
    try {
      const feed = await this.doves.account.priceFeed.fetch(oraclePda);
      const price = toNumber(feed.price as BN);
      const expo = feed.expo as number;
      return price * 10 ** expo;
    } catch {
      return null;
    }
  }

  /** Fetch tradable custody + oracle data. Returns market snapshot per asset. */
  async getMarketStructure(): Promise<PerpsMarketStructure> {
    const cacheKey = `jupiter-perps:market-structure`;
    const cached = await this.cache.get<PerpsMarketStructure>(cacheKey);
    if (cached) return cached;

    // Fetch all 3 custodies in parallel
    const custodies = await Promise.all(
      TRADABLE_MARKETS.map(m => this.perps.account.custody.fetch(m.custody)),
    );

    // Fetch oracle prices (best-effort — if Doves fails, mark stays null)
    const oraclePrices = await Promise.all(
      custodies.map(async c => {
        const agOracle = (c.dovesAgOracle as PublicKey) ?? null;
        const oracle = (c.dovesOracle as PublicKey) ?? null;
        if (agOracle) {
          const p = await this.getOraclePrice(agOracle);
          if (p !== null) return p;
        }
        if (oracle) return this.getOraclePrice(oracle);
        return null;
      }),
    );

    const markets: PerpsMarketSnapshot[] = custodies.map((custody, i) => {
      const m = TRADABLE_MARKETS[i];
      const long_usd = bnDivScaled(custody.assets.guaranteedUsd as BN, USDC_DECIMALS);
      const short_usd = bnDivScaled(custody.assets.globalShortSizes as BN, USDC_DECIMALS);
      const total_usd = long_usd + short_usd;
      const long_pct = total_usd > 0 ? (long_usd / total_usd) * 100 : 0;
      const short_pct = total_usd > 0 ? (short_usd / total_usd) * 100 : 0;

      let net_skew: 'long' | 'short' | 'balanced' = 'balanced';
      if (total_usd > 0) {
        const ratio = long_usd / total_usd;
        if (ratio >= 0.6) net_skew = 'long';
        else if (ratio <= 0.4) net_skew = 'short';
      }

      const rate = computeBorrowRate(custody);
      const decimals = custody.decimals as number;
      const owned_tokens = Number((custody.assets.owned as BN).toString()) / 10 ** decimals;
      const locked_tokens = Number((custody.assets.locked as BN).toString()) / 10 ** decimals;

      return {
        symbol: m.symbol,
        custody: m.custody.toBase58(),
        mark_price_usd: oraclePrices[i],
        open_interest: { long_usd, short_usd, total_usd, long_pct, short_pct, net_skew },
        utilization_pct: rate.utilization_pct,
        borrow_rate: {
          hourly_pct: rate.hourly_pct,
          annualized_pct: rate.annualized_pct,
          model: rate.model,
        },
        pool_assets: {
          owned_tokens,
          locked_tokens,
          guaranteed_usd: long_usd,
          global_short_sizes_usd: short_usd,
        },
        limits: {
          max_long_oi_usd: bnDivScaled(custody.pricing.maxGlobalLongSizes as BN, USDC_DECIMALS),
          max_short_oi_usd: bnDivScaled(custody.pricing.maxGlobalShortSizes as BN, USDC_DECIMALS),
          max_position_size_usd: bnDivScaled(custody.maxPositionSizeUsd as BN, USDC_DECIMALS),
        },
      };
    });

    const long_oi_usd = markets.reduce((s, m) => s + m.open_interest.long_usd, 0);
    const short_oi_usd = markets.reduce((s, m) => s + m.open_interest.short_usd, 0);
    const total_oi_usd = long_oi_usd + short_oi_usd;
    let total_skew: 'long' | 'short' | 'balanced' = 'balanced';
    if (total_oi_usd > 0) {
      const r = long_oi_usd / total_oi_usd;
      if (r >= 0.6) total_skew = 'long';
      else if (r <= 0.4) total_skew = 'short';
    }

    const out: PerpsMarketStructure = {
      pool: JLP_POOL.toBase58(),
      markets,
      totals: {
        long_oi_usd,
        short_oi_usd,
        total_oi_usd,
        net_skew: total_skew,
      },
      fetched_at: Date.now(),
    };

    await this.cache.set(cacheKey, out, CACHE_TTL.perpsMarket);
    return out;
  }

  /** Fetch all open positions for a wallet, decoded and enriched with current PnL. */
  async getPositionsForWallet(
    address: string,
    markPrices?: Map<string, number | null>,
  ): Promise<PerpsTraderProfile> {
    const cacheKey = `jupiter-perps:trader:${address}`;
    const cached = await this.cache.get<PerpsTraderProfile>(cacheKey);
    if (cached) return cached;

    const owner = new PublicKey(address);

    // Anchor's .all() handles the 8-byte discriminator automatically
    const positions = await this.perps.account.position.all([
      { memcmp: { offset: 8, bytes: owner.toBase58() } },
    ]);

    // Filter out closed positions (sizeUsd = 0)
    const open = positions.filter(p => !(p.account.sizeUsd as BN).isZero());

    // Build custody → symbol map (only for tradable assets we care about)
    const custodyToSymbol = new Map<string, string>();
    for (const m of TRADABLE_MARKETS) custodyToSymbol.set(m.custody.toBase58(), m.symbol);
    custodyToSymbol.set(CUSTODY_PUBKEY.USDC.toBase58(), 'USDC');
    custodyToSymbol.set(CUSTODY_PUBKEY.USDT.toBase58(), 'USDT');

    // If no mark prices provided, skip fetching (PnL will be null)
    const marks = markPrices ?? new Map<string, number | null>();

    const decoded: PerpsPositionData[] = open.map(({ account }) => {
      const pos = account as Position;
      const sideKey = Object.keys(pos.side as object)[0] as string;
      const side: 'long' | 'short' = sideKey.toLowerCase() === 'long' ? 'long' : 'short';
      const size_usd = bnDivScaled(pos.sizeUsd as BN, USDC_DECIMALS);
      const collateral_usd = bnDivScaled(pos.collateralUsd as BN, USDC_DECIMALS);
      const entry_price_usd = bnDivScaled(pos.price as BN, USDC_DECIMALS);
      const custodyPk = (pos.custody as PublicKey).toBase58();
      const market_symbol = custodyToSymbol.get(custodyPk) ?? 'UNKNOWN';
      const mark = marks.get(custodyPk) ?? null;

      let unrealized_pnl_usd: number | null = null;
      let unrealized_pnl_pct: number | null = null;
      if (mark !== null && entry_price_usd > 0 && size_usd > 0) {
        const priceDelta = mark - entry_price_usd;
        const direction = side === 'long' ? 1 : -1;
        const sizeTokens = size_usd / entry_price_usd;
        unrealized_pnl_usd = priceDelta * direction * sizeTokens;
        unrealized_pnl_pct = collateral_usd > 0 ? (unrealized_pnl_usd / collateral_usd) * 100 : null;
      }

      const openTime = toNumber(pos.openTime as BN);
      const updateTime = toNumber(pos.updateTime as BN);
      const nowSec = Math.floor(Date.now() / 1000);
      const age_hours = openTime > 0 ? (nowSec - openTime) / 3600 : 0;

      return {
        pool: (pos.pool as PublicKey).toBase58(),
        custody: custodyPk,
        market_symbol,
        side,
        size_usd,
        collateral_usd,
        leverage: collateral_usd > 0 ? size_usd / collateral_usd : 0,
        entry_price_usd,
        mark_price_usd: mark,
        unrealized_pnl_usd,
        unrealized_pnl_pct,
        realized_pnl_usd: bnDivScaled(pos.realisedPnlUsd as BN, USDC_DECIMALS),
        open_time: openTime,
        update_time: updateTime,
        age_hours,
      };
    });

    const gross = decoded.reduce((s, p) => s + p.size_usd, 0);
    const net = decoded.reduce((s, p) => s + p.size_usd * (p.side === 'long' ? 1 : -1), 0);
    const collat = decoded.reduce((s, p) => s + p.collateral_usd, 0);
    const upnl = decoded.reduce((s, p) => s + (p.unrealized_pnl_usd ?? 0), 0);
    const weightedLev = collat > 0 ? gross / collat : 0;

    const out: PerpsTraderProfile = {
      address,
      has_positions: decoded.length > 0,
      positions: decoded,
      totals: {
        gross_exposure_usd: gross,
        net_exposure_usd: net,
        total_collateral_usd: collat,
        total_unrealized_pnl_usd: upnl,
        weighted_leverage: weightedLev,
      },
      fetched_at: Date.now(),
    };

    await this.cache.set(cacheKey, out, CACHE_TTL.perpsTrader);
    return out;
  }

  /** Convenience — build mark-price map from a market snapshot for PnL computation */
  buildMarkPriceMap(market: PerpsMarketStructure): Map<string, number | null> {
    const map = new Map<string, number | null>();
    for (const m of market.markets) map.set(m.custody, m.mark_price_usd);
    return map;
  }
}
