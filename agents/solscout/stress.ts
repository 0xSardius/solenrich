/**
 * Stress test runner — hits a config for EVERY paid endpoint and validates
 * response quality. Coverage is guarded against `PRICING` (see `STRESS_COVERAGE`
 * below + the CLAUDE.md "new endpoint checklist" rule): adding an endpoint to
 * PRICING without a config here logs a warning at runtime AND fails the unit
 * coverage test in `test/unit.test.ts`.
 */

import { PRICING } from '../../src/config';

const TEST_WALLET = 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg';
const TEST_TOKEN = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'; // BONK
const TEST_TOKEN_2 = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'; // JUP
// Known Jupiter Perps trader with 5 open positions, all risk flags firing (verified 2026-05-03).
const TEST_PERPS_TRADER = 'BvgzoCUMgtos1KRsWwLoabt2a35ErqphzAV3xYEJzrRu';
// Known active Hyperliquid trader (EVM 0x). Positions move, so checks are shape-based.
const TEST_HL_TRADER = '0xd21d931890d27b6e7e2e668f27931e17698e90f1';

export interface EndpointResult {
  endpoint: string;
  status: number;
  latency_ms: number;
  passed: boolean;
  checks: CheckResult[];
  error?: string;
}

export interface CheckResult {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface StressResults {
  target: string;
  timestamp: string;
  total: number;
  passed: number;
  failed: number;
  avg_latency_ms: number;
  endpoints: EndpointResult[];
}

// All endpoint configs with their inputs and quality checks
const ENDPOINTS: Array<{
  key: string;
  label?: string; // optional display name when multiple entries share a key
  input: any;
  checks: Array<{ name: string; test: (data: any) => boolean; detail?: (data: any) => string }>;
  timeout?: number;
}> = [
  {
    key: 'enrich-wallet-light',
    input: { address: TEST_WALLET, format: 'both' },
    checks: [
      { name: 'has address', test: (d) => d.address === TEST_WALLET },
      { name: 'has sol_balance', test: (d) => typeof d.sol_balance === 'number' },
      { name: 'has top_holdings array', test: (d) => Array.isArray(d.top_holdings) },
      { name: 'has labels array', test: (d) => Array.isArray(d.labels) },
      { name: 'has risk_score', test: (d) => typeof d.risk_score === 'number' },
      { name: 'has risk_level', test: (d) => typeof d.risk_level === 'string' },
      { name: 'has llm_summary', test: (d) => typeof d.llm_summary === 'string' && d.llm_summary.length > 50 },
    ],
  },
  {
    key: 'enrich-wallet-full',
    input: { address: TEST_WALLET, format: 'both' },
    timeout: 45000,
    checks: [
      { name: 'has address', test: (d) => d.address === TEST_WALLET },
      { name: 'has defi_positions', test: (d) => Array.isArray(d.defi_positions) },
      { name: 'has connected_wallets', test: (d) => Array.isArray(d.connected_wallets) },
      { name: 'has llm_summary', test: (d) => typeof d.llm_summary === 'string' && d.llm_summary.length > 50 },
    ],
  },
  {
    key: 'enrich-token-light',
    input: { mint: TEST_TOKEN, format: 'both' },
    checks: [
      { name: 'has mint', test: (d) => d.mint === TEST_TOKEN },
      { name: 'has price_usd (non-zero)', test: (d) => typeof d.price_usd === 'number', detail: (d) => `price=${d.price_usd}` },
      { name: 'price is real (> 0)', test: (d) => d.price_usd > 0, detail: (d) => `price=${d.price_usd} — DATA QUALITY ISSUE if 0` },
      { name: 'has symbol', test: (d) => typeof d.symbol === 'string' && d.symbol.length > 0, detail: (d) => `symbol="${d.symbol}"` },
      { name: 'has market_cap', test: (d) => typeof d.market_cap === 'number' },
      { name: 'has risk_flags', test: (d) => Array.isArray(d.risk_flags) },
      { name: 'has llm_summary', test: (d) => typeof d.llm_summary === 'string' && d.llm_summary.length > 50 },
    ],
  },
  {
    key: 'enrich-token-full',
    input: { mint: TEST_TOKEN, format: 'both' },
    checks: [
      { name: 'has top_holders', test: (d) => Array.isArray(d.top_holders) && d.top_holders.length > 0 },
      { name: 'holders have pct_supply', test: (d) => d.top_holders?.[0]?.pct_supply > 0 },
      { name: 'has concentration', test: (d) => d.concentration != null },
      { name: 'has HHI', test: (d) => typeof d.concentration?.herfindahl_index === 'number' },
      { name: 'has volatility', test: (d) => d.volatility != null },
      { name: 'has llm_summary', test: (d) => typeof d.llm_summary === 'string' && d.llm_summary.length > 50 },
    ],
  },
  {
    key: 'parse-transaction',
    input: { signature: '__FETCH_SIG__', format: 'both' },
    checks: [
      { name: 'has signature', test: (d) => typeof d.signature === 'string' },
      { name: 'has type', test: (d) => typeof d.type === 'string' },
      { name: 'has timestamp', test: (d) => typeof d.timestamp === 'string' },
      { name: 'has llm_summary', test: (d) => typeof d.llm_summary === 'string' },
    ],
  },
  {
    key: 'whale-watch',
    input: { mint: TEST_TOKEN, format: 'both' },
    timeout: 60000,
    checks: [
      { name: 'has mint', test: (d) => d.mint === TEST_TOKEN },
      { name: 'has whales array', test: (d) => Array.isArray(d.whales) },
      // BONK has ~1M holders → routes through Birdeye fallback. whale_count > 0
      // validates the May-1 holder-fallback fix actually populated whales.
      { name: 'whale_count > 0', test: (d) => typeof d.whale_count === 'number' && d.whale_count > 0, detail: (d) => `whale_count=${d.whale_count}, holders_source=${d.holders_source}` },
      { name: 'has net_flow_direction', test: (d) => typeof d.net_flow_direction === 'string' },
      { name: 'has holders_source', test: (d) => ['rpc', 'birdeye', 'unavailable'].includes(d.holders_source) },
      { name: 'has llm_summary', test: (d) => typeof d.llm_summary === 'string' },
    ],
  },
  {
    key: 'batch-enrich',
    input: { addresses: [TEST_WALLET], type: 'wallet', depth: 'light', format: 'json' },
    timeout: 45000,
    checks: [
      { name: 'has results array', test: (d) => Array.isArray(d.results) },
      { name: 'results count >= 1', test: (d) => d.results?.length >= 1 },
      { name: 'first result has address', test: (d) => typeof d.results?.[0]?.address === 'string' },
    ],
  },
  {
    key: 'wallet-graph',
    input: { address: TEST_WALLET, depth: 1, format: 'both' },
    timeout: 45000,
    checks: [
      { name: 'has address', test: (d) => typeof d.address === 'string' },
      { name: 'has nodes', test: (d) => Array.isArray(d.nodes) },
      { name: 'has edges', test: (d) => Array.isArray(d.edges) },
      { name: 'has llm_summary', test: (d) => typeof d.llm_summary === 'string' },
    ],
  },
  {
    key: 'copy-trade-signals',
    input: { address: TEST_WALLET, format: 'both' },
    timeout: 45000,
    checks: [
      { name: 'has address', test: (d) => typeof d.address === 'string' },
      { name: 'has trades_analyzed', test: (d) => typeof d.trades_analyzed === 'number' },
      { name: 'has win_rate', test: (d) => typeof d.win_rate === 'number' },
      { name: 'has llm_summary', test: (d) => typeof d.llm_summary === 'string' },
    ],
  },
  {
    key: 'due-diligence',
    input: { mint: TEST_TOKEN, format: 'both' },
    timeout: 60000,
    checks: [
      { name: 'has token data', test: (d) => d.token != null },
      { name: 'has overall_risk_score', test: (d) => typeof d.overall_risk_score === 'number' },
      { name: 'has risk_level', test: (d) => typeof d.risk_level === 'string' },
      { name: 'has recommendation', test: (d) => typeof d.recommendation === 'string' },
      { name: 'has llm_summary', test: (d) => typeof d.llm_summary === 'string' && d.llm_summary.length > 50 },
    ],
  },
  {
    key: 'query',
    input: { question: `What tokens does ${TEST_WALLET} hold?`, format: 'both' },
    timeout: 45000,
    checks: [
      { name: 'returned data', test: (d) => d != null && Object.keys(d).length > 0 },
      { name: 'has meaningful content', test: (d) => d.llm_summary || d.address || d.briefing },
    ],
  },
  {
    key: 'compare-tokens',
    input: { mints: [TEST_TOKEN, TEST_TOKEN_2], format: 'both' },
    timeout: 60000,
    checks: [
      { name: 'has tokens array', test: (d) => Array.isArray(d.tokens) && d.tokens.length === 2 },
      { name: 'has rankings', test: (d) => Array.isArray(d.rankings) && d.rankings.length > 0 },
      { name: 'has summary', test: (d) => d.summary != null },
      { name: 'has safest pick', test: (d) => typeof d.summary?.safest === 'string' },
      { name: 'token prices are real', test: (d) => d.tokens?.every((t: any) => t.price_usd > 0), detail: (d) => d.tokens?.map((t: any) => `${t.symbol}=$${t.price_usd}`).join(', ') },
      { name: 'has llm_summary', test: (d) => typeof d.llm_summary === 'string' && d.llm_summary.length > 100 },
    ],
  },
  {
    key: 'compare-wallets',
    input: { addresses: [TEST_WALLET, TEST_TOKEN], depth: 'light', format: 'both' },
    timeout: 45000,
    checks: [
      { name: 'has wallets array', test: (d) => Array.isArray(d.wallets) && d.wallets.length === 2 },
      { name: 'has rankings', test: (d) => Array.isArray(d.rankings) && d.rankings.length > 0 },
      { name: 'has summary', test: (d) => d.summary != null },
      { name: 'has llm_summary', test: (d) => typeof d.llm_summary === 'string' && d.llm_summary.length > 100 },
    ],
  },
  {
    key: 'token-trend',
    input: { mint: TEST_TOKEN, lookback: '7d', format: 'both' },
    timeout: 60000,
    checks: [
      { name: 'has current data', test: (d) => d.current != null },
      { name: 'has snapshots array', test: (d) => Array.isArray(d.snapshots) },
      { name: 'has lookback_days', test: (d) => d.lookback_days === 7 },
      { name: 'has overall_direction', test: (d) => typeof d.overall_direction === 'string' },
      { name: 'has llm_summary', test: (d) => typeof d.llm_summary === 'string' },
    ],
  },
  {
    key: 'wallet-history',
    input: { address: TEST_WALLET, lookback: '7d', format: 'both' },
    timeout: 45000,
    checks: [
      { name: 'has current data', test: (d) => d.current != null },
      { name: 'has snapshots array', test: (d) => Array.isArray(d.snapshots) },
      { name: 'has overall_direction', test: (d) => typeof d.overall_direction === 'string' },
      { name: 'has llm_summary', test: (d) => typeof d.llm_summary === 'string' },
    ],
  },
  {
    key: 'new-tokens',
    input: { min_liquidity_usd: 1000, max_risk_score: 0.8, limit: 5, format: 'both' },
    timeout: 120000,
    checks: [
      { name: 'has tokens array', test: (d) => Array.isArray(d.tokens) },
      { name: 'has total_scanned', test: (d) => typeof d.total_scanned === 'number' },
      { name: 'has filters', test: (d) => d.filters != null },
      { name: 'has llm_summary', test: (d) => typeof d.llm_summary === 'string' },
    ],
  },
  {
    key: 'protocol-profile',
    input: { protocol: 'jupiter', format: 'both' },
    timeout: 60000,
    checks: [
      { name: 'has protocol.name', test: (d) => typeof d.protocol?.name === 'string' && d.protocol.name.length > 0 },
      { name: 'has tvl block', test: (d) => d.tvl != null && typeof d.tvl.total_usd === 'number' },
      { name: 'has activity block', test: (d) => d.activity != null },
      { name: 'has health_signals', test: (d) => d.health_signals != null },
      { name: 'has llm_summary', test: (d) => typeof d.llm_summary === 'string' && d.llm_summary.length > 50 },
    ],
  },
  {
    key: 'perps-market-structure',
    input: { format: 'both' },
    timeout: 30000,
    checks: [
      { name: 'has pool', test: (d) => typeof d.pool === 'string' },
      { name: 'has markets array (3)', test: (d) => Array.isArray(d.markets) && d.markets.length === 3, detail: (d) => `markets=${d.markets?.length}` },
      { name: 'SOL market has OI', test: (d) => d.markets?.[0]?.open_interest?.total_usd > 0, detail: (d) => `SOL_OI=$${d.markets?.[0]?.open_interest?.total_usd?.toFixed(0)}` },
      { name: 'SOL borrow APR > 0', test: (d) => d.markets?.[0]?.borrow_rate?.annualized_pct > 0, detail: (d) => `SOL_APR=${d.markets?.[0]?.borrow_rate?.annualized_pct?.toFixed(2)}%` },
      { name: 'SOL mark price real', test: (d) => d.markets?.[0]?.mark_price_usd > 1, detail: (d) => `SOL=$${d.markets?.[0]?.mark_price_usd?.toFixed(2)}` },
      { name: 'has totals', test: (d) => d.totals?.total_oi_usd > 0 },
      { name: 'has overall_health', test: (d) => typeof d.overall_health === 'string' },
      { name: 'has llm_summary', test: (d) => typeof d.llm_summary === 'string' && d.llm_summary.length > 100 },
    ],
  },
  {
    key: 'perps-trader-profile',
    input: { address: TEST_WALLET, format: 'both' },
    timeout: 30000,
    checks: [
      { name: 'has address', test: (d) => d.address === TEST_WALLET },
      { name: 'has has_positions flag', test: (d) => typeof d.has_positions === 'boolean' },
      { name: 'has positions array', test: (d) => Array.isArray(d.positions) },
      { name: 'has profile classification', test: (d) => typeof d.profile === 'string' },
      { name: 'has directional_bias', test: (d) => ['long', 'short', 'neutral'].includes(d.directional_bias) },
      { name: 'has totals', test: (d) => d.totals != null },
      { name: 'has by_venue.jupiter + by_venue.adrena', test: (d) => d.by_venue?.jupiter != null && d.by_venue?.adrena != null },
      { name: 'multi_venue flag present', test: (d) => typeof d.flags?.multi_venue === 'boolean' },
      { name: 'has llm_summary', test: (d) => typeof d.llm_summary === 'string' },
    ],
  },
  {
    // Multi-venue trader-profile check against a known Jupiter Perps trader.
    // Verifies the venue tagging + per-venue totals work when at least one
    // venue has real positions, not just shape correctness on an empty wallet.
    key: 'perps-trader-profile',
    label: 'perps-trader-profile (Jupiter trader)',
    input: { address: TEST_PERPS_TRADER, format: 'both' },
    timeout: 30000,
    checks: [
      { name: 'has positions', test: (d) => Array.isArray(d.positions) && d.positions.length > 0, detail: (d) => `count=${d.positions?.length}` },
      { name: 'every position tagged with venue', test: (d) => Array.isArray(d.positions) && d.positions.every((p: any) => p.venue === 'jupiter' || p.venue === 'adrena') },
      { name: 'Jupiter venue has positions', test: (d) => d.by_venue?.jupiter?.has_positions === true, detail: (d) => `jup=${d.by_venue?.jupiter?.positions?.length}` },
      { name: 'combined totals.gross_exposure_usd > 0', test: (d) => typeof d.totals?.gross_exposure_usd === 'number' && d.totals.gross_exposure_usd > 0 },
      { name: 'briefing references trader', test: (d) => typeof d.llm_summary === 'string' && d.llm_summary.includes('Perps Trader') },
    ],
  },
  {
    key: 'trending-signals',
    input: { limit: 5, min_liquidity_usd: 10000, format: 'both' },
    timeout: 60000,
    checks: [
      { name: 'has tokens array', test: (d) => Array.isArray(d.tokens) },
      { name: 'has total_scanned', test: (d) => typeof d.total_scanned === 'number' },
      { name: 'has overall_sentiment', test: (d) => ['accumulation', 'distribution', 'mixed'].includes(d.overall_sentiment) },
      { name: 'has filters', test: (d) => d.filters != null && d.filters.limit === 5 },
      { name: 'has llm_summary', test: (d) => typeof d.llm_summary === 'string' && d.llm_summary.length > 100 },
    ],
  },
  {
    key: 'smart-money-flow',
    // No `wallets` input — exercises the programmatic seed-derivation path
    // (May-2 fix). seed_source should be 'derived' on success, 'fallback' if
    // derivation is broken upstream.
    input: { lookback_days: 14, format: 'both' },
    timeout: 120000,
    checks: [
      { name: 'has seed_wallets_considered', test: (d) => typeof d.seed_wallets_considered === 'number' },
      { name: 'has qualifying_smart_wallets array', test: (d) => Array.isArray(d.qualifying_smart_wallets) },
      { name: 'has accumulated_tokens array', test: (d) => Array.isArray(d.accumulated_tokens) },
      { name: 'seed_source is derived', test: (d) => d.seed_source === 'derived', detail: (d) => `seed_source=${d.seed_source}, seeds=${d.seed_wallets_considered}` },
      { name: 'has llm_summary', test: (d) => typeof d.llm_summary === 'string' },
    ],
  },
  {
    key: 'feed-latest',
    // Daily brief endpoint. Lazy-cached, so first run after deploy hits
    // cache-miss (~10-15s); subsequent runs hit cache (<1s).
    input: { format: 'both' },
    timeout: 60000,
    checks: [
      { name: 'has source', test: (d) => ['cached', 'fresh'].includes(d.source), detail: (d) => `source=${d.source}` },
      { name: 'has generated_at', test: (d) => typeof d.generated_at === 'string' },
      { name: 'unchanged is false (no since param)', test: (d) => d.unchanged === false },
      { name: 'brief is populated', test: (d) => d.brief != null && Array.isArray(d.brief.tokens) },
      { name: 'has llm_summary', test: (d) => typeof d.llm_summary === 'string' && d.llm_summary.includes('Daily Brief') },
    ],
  },
  {
    // Priority 8 — proprietary attention signal. Top-N mode (no address).
    // Will return empty top_n if no other endpoint calls hit recently — that's
    // a valid shape, just check the structure.
    key: 'consensus-signal',
    input: { type: 'token', window: '1h', limit: 5, format: 'both' },
    timeout: 30000,
    checks: [
      { name: 'has type token', test: (d) => d.type === 'token' },
      { name: 'has window 1h', test: (d) => d.window === '1h' },
      { name: 'has window_start/end', test: (d) => typeof d.window_start === 'string' && typeof d.window_end === 'string' },
      { name: 'has top_n array', test: (d) => Array.isArray(d.top_n) },
      { name: 'has aggregate', test: (d) => d.aggregate != null && typeof d.aggregate.total_unique_entities === 'number' },
      { name: 'entity is null in top-N mode', test: (d) => d.entity === null },
      { name: 'has llm_summary', test: (d) => typeof d.llm_summary === 'string' && d.llm_summary.includes('attention') },
    ],
  },
  {
    // Priority 12 — portfolio time-series. Uses Solana Foundation wallet so we
    // get reproducible snapshot density across test runs.
    key: 'portfolio-history',
    input: { address: TEST_WALLET, period: '7d', format: 'both' },
    timeout: 45000,
    checks: [
      { name: 'has address', test: (d) => d.address === TEST_WALLET },
      { name: 'has current block', test: (d) => d.current != null && typeof d.current.portfolio_value_usd === 'number' },
      { name: 'has series array', test: (d) => Array.isArray(d.series), detail: (d) => `series length=${d.series?.length}` },
      { name: 'series is sorted oldest→newest', test: (d) => d.series.length < 2 || d.series[0].date <= d.series[d.series.length - 1].date },
      { name: 'has summary block', test: (d) => d.summary != null && typeof d.summary.data_points === 'number' },
      { name: 'summary has lookback_days=7', test: (d) => d.summary?.lookback_days === 7 },
      { name: 'has llm_summary', test: (d) => typeof d.llm_summary === 'string' && d.llm_summary.includes('Portfolio History') },
    ],
  },
  {
    // Priority 13 V1 — poll-based event detection. Uses a 3-day window which
    // should fire at least one alert on the Solana Foundation wallet from the
    // existing snapshot history (risk_score has shifted recently in tests).
    key: 'check-alerts',
    input: {
      tokens: [TEST_TOKEN],
      wallets: [TEST_WALLET],
      since: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      format: 'both',
    },
    timeout: 60000,
    checks: [
      { name: 'has since timestamp', test: (d) => typeof d.since === 'string' },
      { name: 'has checked_at', test: (d) => typeof d.checked_at === 'string' },
      { name: 'has alerts array', test: (d) => Array.isArray(d.alerts), detail: (d) => `alerts=${d.alerts?.length}` },
      { name: 'has watchlist echo', test: (d) => Array.isArray(d.watchlist?.tokens) && Array.isArray(d.watchlist?.wallets) },
      { name: 'watchlist has 1 token + 1 wallet', test: (d) => d.watchlist?.tokens?.length === 1 && d.watchlist?.wallets?.length === 1 },
      { name: 'has counts_by_severity', test: (d) => d.counts_by_severity != null && typeof d.counts_by_severity === 'object' },
      { name: 'has counts_by_type', test: (d) => d.counts_by_type != null && typeof d.counts_by_type === 'object' },
      { name: 'has llm_summary', test: (d) => typeof d.llm_summary === 'string' && d.llm_summary.includes('Alert Check') },
    ],
  },
  {
    // Phase 2D #5 — Jupiter Perps market trend across SOL/BTC/ETH. Cold-cache
    // first call seeds snapshots fire-and-forget; deltas populate from the next
    // day onward. Confirms current-state + market list + lookback echo today.
    key: 'perps-market-trend',
    input: { lookback: '7d', format: 'both' },
    timeout: 60000,
    checks: [
      { name: 'has pool address', test: (d) => typeof d.pool === 'string' && d.pool.length > 0 },
      { name: 'has lookback_days=7', test: (d) => d.lookback_days === 7 },
      { name: 'returns 3 markets (SOL/BTC/ETH)', test: (d) => Array.isArray(d.markets) && d.markets.length === 3 },
      {
        name: 'every market has current state',
        test: (d) => Array.isArray(d.markets) && d.markets.every((m: any) => m.current && typeof m.current.total_oi_usd === 'number'),
        detail: (d) => `markets=${(d.markets ?? []).map((m: any) => m.symbol).join(',')}`,
      },
      { name: 'totals.current_total_oi_usd > 0', test: (d) => typeof d.totals?.current_total_oi_usd === 'number' && d.totals.current_total_oi_usd > 0 },
      { name: 'has overall_direction', test: (d) => typeof d.totals?.overall_direction === 'string' },
      { name: 'has llm_summary', test: (d) => typeof d.llm_summary === 'string' && d.llm_summary.includes('Market Trend') },
    ],
  },
  {
    // Phase 2D #4 — perp position alerts. Targets a known Jupiter Perps trader
    // (5 open positions with high leverage + losing collateral as of 2026-05-03).
    // First call seeds the snapshot; subsequent calls may surface add/close/pnl_swing
    // deltas. perp_at_risk and liquidation_approaching fire on current state alone.
    key: 'check-alerts',
    label: 'check-alerts (perps trader)',
    input: {
      wallets: [TEST_PERPS_TRADER],
      since: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      format: 'both',
    },
    timeout: 60000,
    checks: [
      { name: 'has alerts array', test: (d) => Array.isArray(d.alerts), detail: (d) => `alerts=${d.alerts?.length}` },
      { name: 'watchlist echoes perps trader', test: (d) => d.watchlist?.wallets?.[0] === TEST_PERPS_TRADER },
      {
        name: 'fires at least one perp_* alert',
        test: (d) => Array.isArray(d.alerts) && d.alerts.some((a: any) => typeof a.type === 'string' && (a.type.startsWith('perp_') || a.type === 'liquidation_approaching' || a.type === 'pnl_swing')),
        detail: (d) => `types=${[...new Set((d.alerts ?? []).map((a: any) => a.type))].join(',')}`,
      },
      { name: 'has llm_summary', test: (d) => typeof d.llm_summary === 'string' && d.llm_summary.includes('Alert Check') },
    ],
  },
  {
    // Priority 11 — compound intent path on /query. Tests the wallet-deep
    // compound (3-enricher parallel chain). Single-intent /query is covered by
    // the existing entry above; this verifies the new orchestration path.
    key: 'query',
    input: { question: `wallet deep dive on ${TEST_WALLET}`, format: 'both' },
    timeout: 60000,
    checks: [
      { name: 'returned data', test: (d) => d != null && Object.keys(d).length > 0 },
      { name: 'compound intent: has components', test: (d) => d.intent === 'wallet-deep' && d.components != null, detail: (d) => `intent=${d.intent}` },
      { name: 'wallet sub-component present', test: (d) => d.components?.wallet != null },
      { name: 'history sub-component key present', test: (d) => 'history' in (d.components ?? {}) },
      { name: 'perps sub-component key present', test: (d) => 'perps' in (d.components ?? {}) },
      { name: 'llm_summary chains briefings', test: (d) => typeof d.llm_summary === 'string' && d.llm_summary.includes('Wallet Deep Dive') },
    ],
  },
  // --- Cross-venue perps suite (Jupiter + Adrena + Flash + Hyperliquid + dYdX) ---
  {
    key: 'perps-cross-venue-funding',
    input: { market: 'SOL', include_reference: true, format: 'both' },
    timeout: 30000,
    checks: [
      { name: 'market is SOL', test: (d) => d.market === 'SOL' },
      { name: 'has venues array (>=4)', test: (d) => Array.isArray(d.venues) && d.venues.length >= 4, detail: (d) => `venues=${(d.venues ?? []).map((v: any) => v.venue).join(',')}` },
      { name: 'jupiter + flash venues present', test: (d) => d.venues?.some((v: any) => v.venue === 'jupiter-perps') && d.venues?.some((v: any) => v.venue === 'flash') },
      { name: 'has best_entry long/short', test: (d) => d.best_entry?.long != null && d.best_entry?.short != null },
      { name: 'has basis + arbitrage_opportunities', test: (d) => d.basis != null && Array.isArray(d.arbitrage_opportunities) },
      { name: 'has llm_summary', test: (d) => typeof d.llm_summary === 'string' && d.llm_summary.length > 50 },
    ],
  },
  {
    key: 'perps-venue-comparison',
    input: { market: 'SOL', size_usd: 5000, side: 'long', format: 'both' },
    timeout: 30000,
    checks: [
      { name: 'market/side/size echoed', test: (d) => d.market === 'SOL' && d.side === 'long' && d.size_usd === 5000 },
      { name: 'has venues array (>=4)', test: (d) => Array.isArray(d.venues) && d.venues.length >= 4 },
      { name: 'has rankings.by_entry_cost', test: (d) => Array.isArray(d.rankings?.by_entry_cost) },
      { name: 'has recommendation', test: (d) => d.recommendation != null },
      { name: 'has llm_summary', test: (d) => typeof d.llm_summary === 'string' && d.llm_summary.length > 50 },
    ],
  },
  {
    key: 'perps-basis-signal',
    input: { asset: 'SOL', min_yield_apr_pct: 5, format: 'both' },
    timeout: 30000,
    checks: [
      { name: 'asset is SOL', test: (d) => d.asset === 'SOL' },
      { name: 'min_yield_apr_pct=5', test: (d) => d.min_yield_apr_pct === 5 },
      { name: 'has venues array', test: (d) => Array.isArray(d.venues) },
      { name: 'has opportunities array', test: (d) => Array.isArray(d.opportunities) },
      { name: 'has llm_summary', test: (d) => typeof d.llm_summary === 'string' && d.llm_summary.length > 50 },
    ],
  },
  // --- Hyperliquid (first first-class off-Solana venue) ---
  {
    key: 'hyperliquid-trader-profile',
    input: { address: TEST_HL_TRADER, format: 'both' },
    timeout: 30000,
    checks: [
      { name: 'address echoed', test: (d) => d.address === TEST_HL_TRADER },
      { name: 'venue is hyperliquid', test: (d) => d.venue === 'hyperliquid' },
      { name: 'has account.value_usd', test: (d) => typeof d.account?.value_usd === 'number' },
      { name: 'has positions array', test: (d) => Array.isArray(d.positions) },
      { name: 'has profile', test: (d) => typeof d.profile === 'string' },
      { name: 'directional_bias valid', test: (d) => ['long', 'short', 'neutral'].includes(d.directional_bias) },
      { name: 'has llm_summary', test: (d) => typeof d.llm_summary === 'string' && d.llm_summary.includes('Hyperliquid Trader') },
    ],
  },
  {
    key: 'hyperliquid-smart-money',
    // Orchestration — scans the HL leaderboard + per-trader pulls; slow on cold cache.
    input: { format: 'both', top_traders: 5 },
    timeout: 90000,
    checks: [
      { name: 'has trader_universe.qualified', test: (d) => typeof d.trader_universe?.qualified === 'number', detail: (d) => `qualified=${d.trader_universe?.qualified}` },
      { name: 'has positioning array', test: (d) => Array.isArray(d.positioning) },
      { name: 'has consensus_longs/shorts arrays', test: (d) => Array.isArray(d.consensus_longs) && Array.isArray(d.consensus_shorts) },
      { name: 'has top_traders array', test: (d) => Array.isArray(d.top_traders) },
      { name: 'has summary', test: (d) => typeof d.summary === 'string' },
      { name: 'has llm_summary', test: (d) => typeof d.llm_summary === 'string' && d.llm_summary.includes('Hyperliquid Smart Money') },
    ],
  },
];

// --- Coverage guard ---------------------------------------------------------
// Every paid endpoint in PRICING MUST have at least one stress config above.
// `STRESS_COVERAGE.missing` is asserted empty by test/unit.test.ts (CI), and
// warned at runtime in run(). When you add an endpoint, add a config here too.
const COVERED_KEYS = new Set(ENDPOINTS.map((e) => e.key));
export const STRESS_COVERAGE = {
  covered: [...COVERED_KEYS],
  missing: Object.keys(PRICING).filter((k) => !COVERED_KEYS.has(k)),
};

export class StressRunner {
  private baseUrl: string;
  private fetchFn: typeof fetch;

  constructor(baseUrl: string, fetchFn?: typeof fetch) {
    this.baseUrl = baseUrl;
    this.fetchFn = fetchFn ?? globalThis.fetch;
  }

  async run(): Promise<StressResults> {
    const results: EndpointResult[] = [];

    if (STRESS_COVERAGE.missing.length) {
      console.warn(`\n⚠️  STRESS COVERAGE GAP — these paid endpoints have NO stress config: ${STRESS_COVERAGE.missing.join(', ')}.\n    Add them to agents/solscout/stress.ts (see CLAUDE.md "new endpoint checklist").\n`);
    }

    // Fetch a real tx signature for parse-transaction
    let testSig: string | null = null;
    try {
      const heliusKey = process.env.HELIUS_API_KEY;
      if (heliusKey) {
        const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${heliusKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress',
            params: [TEST_WALLET, { limit: 1 }],
          }),
        });
        const data = await res.json() as any;
        testSig = data?.result?.[0]?.signature ?? null;
      }
    } catch {}

    for (let i = 0; i < ENDPOINTS.length; i++) {
      const ep = ENDPOINTS[i];
      const input = { ...ep.input };

      // Small delay between paid calls to avoid facilitator rate limiting
      if (i > 0 && this.fetchFn !== globalThis.fetch) {
        await new Promise(r => setTimeout(r, 2000));
      }

      // Inject real sig for parse-transaction
      if (input.signature === '__FETCH_SIG__') {
        if (!testSig) {
          results.push({
            endpoint: ep.key,
            status: 0,
            latency_ms: 0,
            passed: false,
            checks: [],
            error: 'No test signature available (set HELIUS_API_KEY)',
          });
          continue;
        }
        input.signature = testSig;
      }

      const displayName = ep.label ?? ep.key;
      console.log(`  Testing ${displayName}...`);
      const result = await this.testEndpoint(ep.key, input, ep.checks, ep.timeout, displayName);
      results.push(result);

      const icon = result.passed ? '✓' : '✗';
      const failedChecks = result.checks.filter(c => !c.passed);
      console.log(`  ${icon} ${displayName} — ${result.status} — ${result.latency_ms}ms — ${result.checks.length - failedChecks.length}/${result.checks.length} checks`);
      for (const fc of failedChecks) {
        console.log(`    ✗ ${fc.name}${fc.detail ? ` — ${fc.detail}` : ''}`);
      }
    }

    const passed = results.filter(r => r.passed).length;
    const totalLatency = results.reduce((s, r) => s + r.latency_ms, 0);

    return {
      target: this.baseUrl,
      timestamp: new Date().toISOString(),
      total: results.length,
      passed,
      failed: results.length - passed,
      avg_latency_ms: Math.round(totalLatency / results.length),
      endpoints: results,
    };
  }

  private async testEndpoint(
    key: string,
    input: any,
    checks: Array<{ name: string; test: (d: any) => boolean; detail?: (d: any) => string }>,
    timeout = 30000,
    displayName?: string,
  ): Promise<EndpointResult> {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const display = displayName ?? key;

    try {
      const res = await this.fetchFn(`${this.baseUrl}/entrypoints/${key}/invoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const latency = Date.now() - start;

      if (res.status === 402) {
        // Production with payments — 402 is expected
        return {
          endpoint: display,
          status: 402,
          latency_ms: latency,
          passed: true,
          checks: [{ name: '402 paywall active', passed: true }],
        };
      }

      if (res.status !== 200) {
        const body = await res.text().catch(() => '');
        return {
          endpoint: display,
          status: res.status,
          latency_ms: latency,
          passed: false,
          checks: [],
          error: `HTTP ${res.status}: ${body.slice(0, 200)}`,
        };
      }

      const body = await res.json() as any;
      const data = body.output ?? body;

      const checkResults: CheckResult[] = checks.map(c => {
        let passed = false;
        let detail: string | undefined;
        try {
          passed = c.test(data);
          if (c.detail) detail = c.detail(data);
        } catch (e: any) {
          detail = e.message;
        }
        return { name: c.name, passed, detail };
      });

      return {
        endpoint: display,
        status: 200,
        latency_ms: latency,
        passed: checkResults.every(c => c.passed),
        checks: checkResults,
      };
    } catch (e: any) {
      clearTimeout(timer);
      return {
        endpoint: display,
        status: 0,
        latency_ms: Date.now() - start,
        passed: false,
        checks: [],
        error: e.message,
      };
    }
  }
}
