/**
 * Multi-source price aggregation.
 * Fetches from Helius DAS, DexScreener, and Jupiter in parallel.
 * Returns the median price (resists outliers) plus source count and spread.
 */

import type { DexScreenerClient } from '../sources/dexscreener';
import type { JupiterClient } from '../sources/jupiter';

export interface AggregatedPrice {
  price: number;
  sources: number;
  spread_pct: number;       // how much sources disagree (0 = perfect agreement)
  source_prices: Record<string, number>;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

export function spreadPct(values: number[]): number {
  if (values.length < 2) return 0;
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === 0) return 0;
  return ((max - min) / min) * 100;
}

export class PriceAggregator {
  constructor(
    private dexscreener: DexScreenerClient,
    private jupiter: JupiterClient,
  ) {}

  /**
   * Get aggregated price for a single mint.
   * heliusPrice is optional — pass it when you already have it from a DAS response.
   */
  async getPrice(mint: string, heliusPrice?: number): Promise<AggregatedPrice> {
    const sourcePrices: Record<string, number> = {};

    if (heliusPrice && heliusPrice > 0) {
      sourcePrices.helius = heliusPrice;
    }

    // Fetch DexScreener + Jupiter in parallel
    const [dexResult, jupResult] = await Promise.allSettled([
      this.dexscreener.getTokenPrice(mint),
      this.jupiter.getPrice([mint]).then((r) => r[mint]?.price ?? 0),
    ]);

    if (dexResult.status === 'fulfilled' && dexResult.value > 0) {
      sourcePrices.dexscreener = dexResult.value;
    }
    if (jupResult.status === 'fulfilled' && jupResult.value > 0) {
      sourcePrices.jupiter = jupResult.value;
    }

    const values = Object.values(sourcePrices);

    return {
      price: median(values),
      sources: values.length,
      spread_pct: Math.round(spreadPct(values) * 100) / 100,
      source_prices: sourcePrices,
    };
  }

  /**
   * Batch price lookup — fetches all mints from Jupiter in one call,
   * DexScreener individually (their API is per-token), then aggregates.
   */
  async getBatchPrices(
    mints: string[],
    heliusPrices?: Map<string, number>,
  ): Promise<Map<string, AggregatedPrice>> {
    const results = new Map<string, AggregatedPrice>();
    if (mints.length === 0) return results;

    // Jupiter batch (up to 50 per call)
    const jupPrices = new Map<string, number>();
    try {
      const chunks: string[][] = [];
      for (let i = 0; i < mints.length; i += 50) {
        chunks.push(mints.slice(i, i + 50));
      }
      const chunkResults = await Promise.allSettled(
        chunks.map((chunk) => this.jupiter.getPrice(chunk)),
      );
      for (const result of chunkResults) {
        if (result.status === 'fulfilled') {
          for (const [mint, data] of Object.entries(result.value)) {
            if (data.price > 0) jupPrices.set(mint, data.price);
          }
        }
      }
    } catch { /* graceful */ }

    // DexScreener parallel (individual per mint)
    const dexResults = await Promise.allSettled(
      mints.map((mint) => this.dexscreener.getTokenPrice(mint)),
    );

    // Aggregate per mint
    for (let i = 0; i < mints.length; i++) {
      const mint = mints[i];
      const sourcePrices: Record<string, number> = {};

      const helius = heliusPrices?.get(mint);
      if (helius && helius > 0) sourcePrices.helius = helius;

      const dex = dexResults[i];
      if (dex.status === 'fulfilled' && dex.value > 0) sourcePrices.dexscreener = dex.value;

      const jup = jupPrices.get(mint);
      if (jup && jup > 0) sourcePrices.jupiter = jup;

      const values = Object.values(sourcePrices);
      results.set(mint, {
        price: median(values),
        sources: values.length,
        spread_pct: Math.round(spreadPct(values) * 100) / 100,
        source_prices: sourcePrices,
      });
    }

    return results;
  }
}
