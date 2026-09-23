/**
 * Endpoint suites, in the order surfaces present them (B3, 2026-09-20).
 * The order is a sales decision: what has paying buyers goes first. Inside a
 * suite, the entry call comes first and the loop follows the order the skill
 * files teach (find → vet → size → hold → exit).
 *
 * Used by llms.txt, llms-full.txt, and (B4/B5) the generated landing pages.
 * `test/llms-order.test.ts` fails CI if a priced endpoint is missing from
 * every suite or listed twice. New endpoint → add it here (CLAUDE.md checklist).
 */
export interface EndpointSuite {
  id: string;
  title: string;
  /** One line under the header. */
  blurb: string;
  keys: string[];
}

export const ENDPOINT_SUITES: EndpointSuite[] = [
  {
    id: 'stonkfun',
    title: 'StonkFun reward coins',
    blurb: 'Token-2022 coins paired to xStocks, pre-stocks, ZEC and other quote assets; a transfer tax pays holders in the quote. Find, cost, and time a stonk trade, or decide what to launch.',
    keys: ['stonk-pairs', 'stonk-gems', 'stonk-screener', 'stonk-reward-risk', 'stonk-yield', 'stonk-yield-batch', 'stonk-quote', 'stonk-launch-intel', 'stonk-launch-preflight'],
  },
  {
    id: 'trenches',
    title: 'Trenches (fresh-launch trade lifecycle)',
    blurb: 'Memecoins minutes to hours old: what is running, who is buying, should I enter this one, should I exit the one I hold.',
    keys: ['runner-scan', 'smart-money-trenches', 'trenches-check', 'trenches-scan', 'exit-signal', 'attention-momentum'],
  },
  {
    id: 'smart-money',
    title: 'Smart money and whales',
    blurb: 'Proven-winner wallets and large holders: where they move on Solana spot and on Hyperliquid perps.',
    keys: ['smart-money-flow', 'copy-trade-signals', 'whale-watch', 'hyperliquid-smart-money', 'hyperliquid-trader-profile'],
  },
  {
    id: 'perps',
    title: 'Perps (Jupiter, Adrena, Flash, Hyperliquid, dYdX)',
    blurb: 'Cross-venue funding, open interest, entry cost at size, basis, and trader positioning.',
    keys: ['perps-venue-comparison', 'perps-cross-venue-funding', 'perps-market-structure', 'perps-basis-signal', 'perps-market-trend', 'perps-trader-profile'],
  },
  {
    id: 'core',
    title: 'Core wallet, token, and transaction intelligence',
    blurb: 'The primitives every other suite composes: token safety and slippage, wallet risk and bot flags, parsed transactions.',
    keys: ['due-diligence', 'enrich-token-light', 'enrich-token-full', 'enrich-wallet-light', 'enrich-wallet-full', 'parse-transaction'],
  },
  {
    id: 'discovery',
    title: 'Discovery, signals, and alerts',
    blurb: 'What is worth attention right now, what other agents are querying, and event alerts against a watchlist.',
    keys: ['query', 'trending-signals', 'new-tokens', 'consensus-signal', 'feed-latest', 'check-alerts', 'protocol-profile'],
  },
  {
    id: 'temporal',
    title: 'Temporal (what changed)',
    blurb: 'Daily snapshots with direction per metric.',
    keys: ['token-trend', 'wallet-history', 'portfolio-history'],
  },
  {
    id: 'composition',
    title: 'Batch, comparison, and graph',
    blurb: 'Many addresses in one call, side-by-side rankings, wallet connection maps.',
    keys: ['batch-enrich', 'compare-tokens', 'compare-wallets', 'wallet-graph'],
  },
  {
    id: 'collectibles',
    title: 'Collectibles',
    blurb: 'Jupiter Gacha pack expected value.',
    keys: ['gacha-ev-scan'],
  },
];

/** Every key across all suites, in presentation order. */
export const SUITE_ORDER: string[] = ENDPOINT_SUITES.flatMap((s) => s.keys);
