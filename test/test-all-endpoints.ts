// Full endpoint test — verifies all 11 entrypoints return real data via HTTP
// Runs against local server with payments DISABLED
// Requires: bun run dev (or bun src/index.ts) on port 3000
// Run: bun run test/test-all-endpoints.ts

const BASE = 'http://127.0.0.1:3000';
const TEST_WALLET = 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg';
const TEST_TOKEN = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'; // BONK

let passed = 0;
let failed = 0;
let skipped = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

function skip(label: string, reason: string) {
  console.log(`  ⊘ ${label} — SKIPPED: ${reason}`);
  skipped++;
}

async function invoke(key: string, input: any, timeoutMs = 30000): Promise<{ status: number; body: any; ms: number }> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${BASE}/entrypoints/${key}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const body = await res.json();
    return { status: res.status, body, ms: Date.now() - start };
  } catch (e: any) {
    clearTimeout(timer);
    return { status: 0, body: { error: e.message }, ms: Date.now() - start };
  }
}

// ============================================================
console.log('\n╔══════════════════════════════════════════════════╗');
console.log('║  SolEnrich — Full Endpoint Verification Suite    ║');
console.log('║  All 11 entrypoints, real data, format: "both"   ║');
console.log('╚══════════════════════════════════════════════════╝\n');

// ============================================================
// 1. enrich-wallet-light
// ============================================================
console.log('━━━ 1. enrich-wallet-light ━━━');
const wl = await invoke('enrich-wallet-light', { address: TEST_WALLET, format: 'both' });
check('returns 200', wl.status === 200, `got ${wl.status}`);
check('has address', wl.body?.output?.address === TEST_WALLET);
check('has sol_balance (number)', typeof wl.body?.output?.sol_balance === 'number');
check('has top_holdings (array)', Array.isArray(wl.body?.output?.top_holdings));
check('has labels (array)', Array.isArray(wl.body?.output?.labels));
check('has risk_score (number)', typeof wl.body?.output?.risk_score === 'number');
check('has llm_summary (string)', typeof wl.body?.output?.llm_summary === 'string' && wl.body.output.llm_summary.length > 50);
console.log(`  ⏱ ${wl.ms}ms\n`);

// ============================================================
// 2. enrich-wallet-full
// ============================================================
console.log('━━━ 2. enrich-wallet-full ━━━');
const wf = await invoke('enrich-wallet-full', { address: TEST_WALLET, format: 'both' }, 45000);
check('returns 200', wf.status === 200, `got ${wf.status}`);
check('has address', wf.body?.output?.address === TEST_WALLET);
check('has defi_positions', Array.isArray(wf.body?.output?.defi_positions));
check('has connected_wallets', Array.isArray(wf.body?.output?.connected_wallets));
check('has llm_summary', typeof wf.body?.output?.llm_summary === 'string' && wf.body.output.llm_summary.length > 50);
console.log(`  ⏱ ${wf.ms}ms\n`);

// ============================================================
// 3. enrich-token-light
// ============================================================
console.log('━━━ 3. enrich-token-light ━━━');
const tl = await invoke('enrich-token-light', { mint: TEST_TOKEN, format: 'both' });
check('returns 200', tl.status === 200, `got ${tl.status}`);
check('has mint', tl.body?.output?.mint === TEST_TOKEN);
check('has price_usd (number)', typeof tl.body?.output?.price_usd === 'number');
check('has market_cap', typeof tl.body?.output?.market_cap === 'number');
check('has risk_flags (array)', Array.isArray(tl.body?.output?.risk_flags));
check('has llm_summary', typeof tl.body?.output?.llm_summary === 'string' && tl.body.output.llm_summary.length > 50);
console.log(`  ⏱ ${tl.ms}ms\n`);

// ============================================================
// 4. enrich-token-full
// ============================================================
console.log('━━━ 4. enrich-token-full ━━━');
const tf = await invoke('enrich-token-full', { mint: TEST_TOKEN, format: 'both' });
check('returns 200', tf.status === 200, `got ${tf.status}`);
check('has mint', tf.body?.output?.mint === TEST_TOKEN);
check('has top_holders (array)', Array.isArray(tf.body?.output?.top_holders));
if (tf.body?.output?.top_holders?.length > 0) {
  check('holders have pct_supply field', typeof tf.body.output.top_holders[0].pct_supply === 'number');
}
check('has concentration', tf.body?.output?.concentration != null);
check('has llm_summary', typeof tf.body?.output?.llm_summary === 'string' && tf.body.output.llm_summary.length > 50);
console.log(`  ⏱ ${tf.ms}ms\n`);

// ============================================================
// 5. parse-transaction
// ============================================================
console.log('━━━ 5. parse-transaction ━━━');
// Fetch a real signature first
let testSig: string | null = null;
try {
  const sigRes = await fetch(`${BASE}/entrypoints/enrich-wallet-light/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: { address: TEST_WALLET, format: 'json' } }),
  });
  const sigData = await sigRes.json();
  // Get a signature from the wallet's recent transactions
  const recentTxRes = await fetch(`https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress',
      params: [TEST_WALLET, { limit: 1 }],
    }),
  });
  const recentTx = await recentTxRes.json();
  testSig = recentTx?.result?.[0]?.signature ?? null;
} catch {}

if (testSig) {
  console.log(`  Using sig: ${testSig.slice(0, 20)}...`);
  const tx = await invoke('parse-transaction', { signature: testSig, format: 'both' });
  check('returns 200', tx.status === 200, `got ${tx.status}`);
  check('has signature', typeof tx.body?.output?.signature === 'string');
  check('has type', typeof tx.body?.output?.type === 'string');
  check('has llm_summary', typeof tx.body?.output?.llm_summary === 'string');
  console.log(`  ⏱ ${tx.ms}ms\n`);
} else {
  skip('parse-transaction', 'Could not fetch a test signature');
  console.log('');
}

// ============================================================
// 6. whale-watch
// ============================================================
console.log('━━━ 6. whale-watch ━━━');
const ww = await invoke('whale-watch', { mint: TEST_TOKEN, format: 'both' }, 45000);
check('returns 200', ww.status === 200, `got ${ww.status}`);
check('has mint', ww.body?.output?.mint === TEST_TOKEN);
check('has whales (array)', Array.isArray(ww.body?.output?.whales));
if (ww.body?.output?.whales?.length > 0) {
  const whale = ww.body.output.whales[0];
  check('whale has address', typeof whale.address === 'string');
  check('whale has balance_usd', typeof whale.balance_usd === 'number');
}
check('has llm_summary', typeof ww.body?.output?.llm_summary === 'string' && ww.body.output.llm_summary.length > 20);
console.log(`  ⏱ ${ww.ms}ms\n`);

// ============================================================
// 7. batch-enrich
// ============================================================
console.log('━━━ 7. batch-enrich ━━━');
const batch = await invoke('batch-enrich', {
  addresses: [TEST_WALLET, 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg'],
  type: 'wallet',
  depth: 'light',
  format: 'json',
}, 45000);
check('returns 200', batch.status === 200, `got ${batch.status}`);
check('has results (array)', Array.isArray(batch.body?.output?.results));
check('results count >= 1', (batch.body?.output?.results?.length ?? 0) >= 1);
if (batch.body?.output?.results?.[0]) {
  check('first result has address', typeof batch.body.output.results[0].address === 'string');
}
console.log(`  ⏱ ${batch.ms}ms\n`);

// ============================================================
// 8. wallet-graph
// ============================================================
console.log('━━━ 8. wallet-graph ━━━');
const graph = await invoke('wallet-graph', { address: TEST_WALLET, depth: 1, format: 'both' }, 45000);
check('returns 200', graph.status === 200, `got ${graph.status}`);
check('has address', typeof graph.body?.output?.address === 'string');
check('has nodes (array)', Array.isArray(graph.body?.output?.nodes));
check('has llm_summary', typeof graph.body?.output?.llm_summary === 'string');
console.log(`  ⏱ ${graph.ms}ms\n`);

// ============================================================
// 9. copy-trade-signals
// ============================================================
console.log('━━━ 9. copy-trade-signals ━━━');
const ct = await invoke('copy-trade-signals', { address: TEST_WALLET, format: 'both' }, 45000);
check('returns 200', ct.status === 200, `got ${ct.status}`);
check('has address', typeof ct.body?.output?.address === 'string');
check('has trades_analyzed', typeof ct.body?.output?.trades_analyzed === 'number');
check('has llm_summary', typeof ct.body?.output?.llm_summary === 'string');
console.log(`  ⏱ ${ct.ms}ms\n`);

// ============================================================
// 10. due-diligence
// ============================================================
console.log('━━━ 10. due-diligence ━━━');
const dd = await invoke('due-diligence', { mint: TEST_TOKEN, format: 'both' }, 60000);
check('returns 200', dd.status === 200, `got ${dd.status}`);
check('has token data', dd.body?.output?.token != null);
check('has overall_risk_score', typeof dd.body?.output?.overall_risk_score === 'number');
check('has risk_level', typeof dd.body?.output?.risk_level === 'string');
check('has recommendation', typeof dd.body?.output?.recommendation === 'string');
check('has llm_summary', typeof dd.body?.output?.llm_summary === 'string' && dd.body.output.llm_summary.length > 50);
console.log(`  ⏱ ${dd.ms}ms\n`);

// ============================================================
// 11. query (NL)
// ============================================================
console.log('━━━ 11. query ━━━');
const q = await invoke('query', { question: `What tokens does ${TEST_WALLET} hold?`, format: 'both' }, 45000);
check('returns 200', q.status === 200, `got ${q.status}`);
check('has output', q.body?.output != null);
const qOutput = q.body?.output;
const hasData = qOutput?.llm_summary || qOutput?.address || qOutput?.mint || qOutput?.briefing;
check('returned meaningful data', !!hasData, hasData ? undefined : JSON.stringify(Object.keys(qOutput || {})).slice(0, 100));
console.log(`  ⏱ ${q.ms}ms\n`);

// ============================================================
// 12. perps-market-structure
// ============================================================
console.log('━━━ 12. perps-market-structure ━━━');
const pms = await invoke('perps-market-structure', { format: 'both' }, 45000);
check('returns 200', pms.status === 200, `got ${pms.status}`);
check('has markets (array)', Array.isArray(pms.body?.output?.markets));
check('has 3 markets (SOL/BTC/ETH)', pms.body?.output?.markets?.length === 3);
check('has overall_health', typeof pms.body?.output?.overall_health === 'string');
check('has llm_summary', typeof pms.body?.output?.llm_summary === 'string' && pms.body.output.llm_summary.length > 50);
console.log(`  ⏱ ${pms.ms}ms\n`);

// ============================================================
// Summary
// ============================================================
console.log('═══════════════════════════════════════════════════');
console.log(`  PASSED: ${passed}  |  FAILED: ${failed}  |  SKIPPED: ${skipped}`);
console.log('═══════════════════════════════════════════════════');

if (failed > 0) {
  console.log('\n⚠ Some tests failed — check output above for details.\n');
  process.exit(1);
} else {
  console.log('\n✓ All endpoints returning real data.\n');
}
