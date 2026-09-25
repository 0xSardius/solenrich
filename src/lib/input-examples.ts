/**
 * One concrete, callable input per paid endpoint — EVERY endpoint, not only those with required parameters.
 *
 * Readers:
 * 1. The x402 bazaar discovery extension (`routeConfig` in agent.ts). CDP's bazaar only catalogs a parameterized
 *    endpoint it can demonstrate as callable (canary 2026-06-28). agentic.market builds each endpoint's parameter
 *    list ONLY from these example keys and ignores the schema (verified 2026-09-25: stonk-screener and stonk-gems
 *    had no example and showed no parameters at all). So each example names the useful optional parameters and
 *    `format`, with sensible values. Metadata only; the payment flow does not read this.
 * 2. The per-endpoint pages on www (B5, parked) and the example-response capture.
 *
 * Fixtures reuse the SolScout test fixtures: BONK (token), Solana Foundation (wallet), ZCAT (StonkFun reward coin on
 * ZEC). `test/discovery-examples.test.ts` checks every PRICING key has an example whose keys are in its schema and
 * whose required fields are present.
 */
import { buildExampleLaunchTransaction, EXAMPLE_LAUNCH_SOL } from '../sources/launchlab';

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const JUP = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN';
const WALLET = 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg';
const WALLET_2 = 'BvgzoCUMgtos1KRsWwLoabt2a35ErqphzAV3xYEJzrRu';
const ZCAT = 'HcRLc9VDgjLeK154xDawfb1dmVJ98DoSqcwTHGqiDeJR';
const GROK = '6HU4CmRb15C2nQDx8Ld2f2W2wTdmog6aZiiXdrT5Pzi8';
const NVDAX = 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh';
const SIG = 'bqTH7u2PJ33gDQwZMy9BXVxABRpgUbY8xSuK6y9PpKYxucFKhiJyiD7JTrH1zxFvMEJGz4847tvotMoP1Ekavaa';

export const INPUT_EXAMPLES: Record<string, Record<string, unknown>> = {
  // wallet
  'enrich-wallet-light': { address: WALLET, format: 'json' },
  'enrich-wallet-full': { address: WALLET, depth: 'full', format: 'json' },
  'wallet-graph': { address: WALLET, depth: 1, min_interactions: 2, format: 'json' },
  'wallet-history': { address: WALLET, lookback: '7d', format: 'json' },
  'portfolio-history': { address: WALLET, period: '30d', format: 'json' },
  'copy-trade-signals': { address: WALLET, lookback_days: 30, format: 'json' },
  'compare-wallets': { addresses: [WALLET, WALLET_2], depth: 'light', format: 'json' },
  // token
  'enrich-token-light': { mint: BONK, format: 'json' },
  'enrich-token-full': { mint: BONK, include_holders: true, format: 'json' },
  'due-diligence': { mint: BONK, format: 'json' },
  'trenches-check': { mint: BONK, format: 'json' },
  'exit-signal': { mint: BONK, entry_price_usd: 0.00002, format: 'json' },
  'whale-watch': { mint: BONK, threshold_usd: 10000, lookback_hours: 24, format: 'json' },
  'token-trend': { mint: BONK, lookback: '7d', format: 'json' },
  'compare-tokens': { mints: [BONK, JUP], format: 'json' },
  'new-tokens': { min_liquidity_usd: 10000, max_risk_score: 0.6, limit: 10, format: 'json' },
  // tx / batch / query / protocol
  'parse-transaction': { signature: SIG, format: 'json' },
  'batch-enrich': { addresses: [WALLET, WALLET_2], type: 'wallet', depth: 'light', format: 'json' },
  'query': { question: 'Is BONK a safe token to hold?', format: 'json' },
  'protocol-profile': { protocol: 'jupiter', include_yields: true, format: 'json' },
  // perps
  'perps-market-structure': { format: 'json' },
  'perps-trader-profile': { address: WALLET_2, format: 'json' },
  'perps-cross-venue-funding': { market: 'SOL', include_reference: true, format: 'json' },
  'perps-venue-comparison': { market: 'SOL', size_usd: 5000, side: 'long', format: 'json' },
  'perps-basis-signal': { asset: 'SOL', min_yield_apr_pct: 5, format: 'json' },
  'perps-market-trend': { lookback: '7d', format: 'json' },
  // hyperliquid
  'hyperliquid-trader-profile': { address: '0xd21d931890d27b6e7e2e668f27931e17698e90f1', format: 'json' },
  'hyperliquid-smart-money': { market: 'BTC', top_traders: 20, format: 'json' },
  // orchestration / discovery / signals
  'trending-signals': { min_liquidity_usd: 25000, max_risk_score: 0.6, limit: 10, include_whale_watch: true, format: 'json' },
  'smart-money-flow': { lookback_days: 14, min_win_rate: 0.55, top_n_tokens: 10, include_graph: false, format: 'json' },
  'smart-money-trenches': { hours_back: 6, max_token_age_hours: 12, min_buyers: 2, limit: 10, format: 'json' },
  'runner-scan': { max_token_age_hours: 24, min_liquidity_usd: 10000, min_volume_h1_usd: 5000, limit: 15, format: 'json' },
  'trenches-scan': { max_token_age_hours: 24, min_liquidity_usd: 5000, limit: 10, format: 'json' },
  'feed-latest': { format: 'json' },
  'consensus-signal': { type: 'token', window: '6h', limit: 10, format: 'json' },
  'attention-momentum': { window: '6h', limit: 10, format: 'json' },
  // alerts — the watchlist needs at least one token or wallet; `since` alone is a 400 (found 2026-09-21).
  'check-alerts': { tokens: [BONK], wallets: [WALLET], since: '2026-09-01T00:00:00Z', format: 'json' },
  // collectibles
  'gacha-ev-scan': { franchise: 'pokemon', exit_strategy: 'both', format: 'json' },
  // stonkfun — ZCAT = live reward coin on ZEC; the preflight example is a deterministic correct launch.
  'stonk-reward-risk': { mint: ZCAT, format: 'json' },
  'stonk-yield': { mint: ZCAT, format: 'json' },
  'stonk-yield-batch': { mints: [ZCAT, GROK], format: 'json' },
  // A fixed `since` stays valid: older than 31 days is clamped, not rejected.
  'stonk-alerts': { mints: [ZCAT, GROK], since: '2026-09-24T00:00:00Z', stale_after_hours: 24, format: 'json' },
  'stonk-screener': { quote_mint: NVDAX, paying_only: true, sort: 'volume24h', limit: 25, format: 'json' },
  'stonk-gems': { category: 'xstock', max_age_days: 14, min_holders: 50, limit: 15, format: 'json' },
  'stonk-launch-intel': { category: 'xstock', min_coins: 20, sort: 'demand', limit: 10, format: 'json' },
  'stonk-quote': { mint: ZCAT, size_usd: 100, hold_days: 7, format: 'json' },
  // SOL-quoted reference launch: its raise is a fixed 85 SOL, so the example never drifts into a mismatch.
  'stonk-launch-preflight': { unsigned_transaction: buildExampleLaunchTransaction({}, undefined, EXAMPLE_LAUNCH_SOL), quote_mint: EXAMPLE_LAUNCH_SOL.quoteMint, mode: EXAMPLE_LAUNCH_SOL.mode, format: 'json' },
};
