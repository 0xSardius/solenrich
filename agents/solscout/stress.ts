/**
 * Stress test runner — hits all 13 endpoints and validates response quality
 */

const TEST_WALLET = 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg';
const TEST_TOKEN = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'; // BONK
const TEST_TOKEN_2 = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'; // JUP

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
      { name: 'has llm_summary', test: (d) => typeof d.llm_summary === 'string' },
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
];

export class StressRunner {
  private baseUrl: string;
  private fetchFn: typeof fetch;

  constructor(baseUrl: string, fetchFn?: typeof fetch) {
    this.baseUrl = baseUrl;
    this.fetchFn = fetchFn ?? globalThis.fetch;
  }

  async run(): Promise<StressResults> {
    const results: EndpointResult[] = [];

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

      console.log(`  Testing ${ep.key}...`);
      const result = await this.testEndpoint(ep.key, input, ep.checks, ep.timeout);
      results.push(result);

      const icon = result.passed ? '✓' : '✗';
      const failedChecks = result.checks.filter(c => !c.passed);
      console.log(`  ${icon} ${ep.key} — ${result.status} — ${result.latency_ms}ms — ${result.checks.length - failedChecks.length}/${result.checks.length} checks`);
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
  ): Promise<EndpointResult> {
    const start = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

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
          endpoint: key,
          status: 402,
          latency_ms: latency,
          passed: true,
          checks: [{ name: '402 paywall active', passed: true }],
        };
      }

      if (res.status !== 200) {
        const body = await res.text().catch(() => '');
        return {
          endpoint: key,
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
        endpoint: key,
        status: 200,
        latency_ms: latency,
        passed: checkResults.every(c => c.passed),
        checks: checkResults,
      };
    } catch (e: any) {
      clearTimeout(timer);
      return {
        endpoint: key,
        status: 0,
        latency_ms: Date.now() - start,
        passed: false,
        checks: [],
        error: e.message,
      };
    }
  }
}
