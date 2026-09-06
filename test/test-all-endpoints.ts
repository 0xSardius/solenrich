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
// 13. smart-money-trenches
// ============================================================
console.log('━━━ 13. smart-money-trenches ━━━');
const smt = await invoke('smart-money-trenches', { hours_back: 24, max_token_age_hours: 48, format: 'both' }, 90000);
check('returns 200', smt.status === 200, `got ${smt.status}`);
check('has signals (array)', Array.isArray(smt.body?.output?.signals));
check('scanned seeds', typeof smt.body?.output?.seeds_scanned === 'number' && smt.body.output.seeds_scanned > 0);
check('has seed_set provenance', typeof smt.body?.output?.seed_set?.derived_at === 'string');
check('has bot-guard fields', Array.isArray(smt.body?.output?.seeds_skipped_bot_cadence));
check('has llm_summary', typeof smt.body?.output?.llm_summary === 'string' && smt.body.output.llm_summary.includes('Trenches'));
console.log(`  ⏱ ${smt.ms}ms\n`);

// ============================================================
// 14. gacha-ev-scan
// ============================================================
console.log('━━━ 14. gacha-ev-scan ━━━');
const gacha = await invoke('gacha-ev-scan', { franchise: 'pokemon', exit_strategy: 'both', format: 'both' }, 30000);
check('returns 200', gacha.status === 200, `got ${gacha.status}`);
check('has machines (array)', Array.isArray(gacha.body?.output?.machines));
check('machine_count > 0', typeof gacha.body?.output?.machine_count === 'number' && gacha.body.output.machine_count > 0);
check('each machine has a verdict', (gacha.body?.output?.machines ?? []).every((m: any) => ['POSITIVE_EV', 'HOUSE_EDGE', 'NEGATIVE_EV'].includes(m.verdict)));
check('has summary counts', typeof gacha.body?.output?.summary?.house_edge_count === 'number');
check('has llm_summary', typeof gacha.body?.output?.llm_summary === 'string' && gacha.body.output.llm_summary.includes('Gacha'));
console.log(`  ⏱ ${gacha.ms}ms\n`);

// ============================================================
// 15. runner-scan
// ============================================================
console.log('━━━ 15. runner-scan ━━━');
const runner = await invoke('runner-scan', { max_token_age_hours: 48, min_liquidity_usd: 5000, min_volume_h1_usd: 2000, limit: 10, format: 'both' }, 60000);
check('returns 200', runner.status === 200, `got ${runner.status}`);
check('has runners (array)', Array.isArray(runner.body?.output?.runners));
check('scanned candidates', typeof runner.body?.output?.candidates_scanned === 'number' && runner.body.output.candidates_scanned > 0);
check('has stage_counts', typeof runner.body?.output?.stage_counts?.RUNNING === 'number');
check('runner_score in range', (runner.body?.output?.runners ?? []).every((r: any) => r.runner_score >= 0 && r.runner_score <= 1));
check('each runner has a stage', (runner.body?.output?.runners ?? []).every((r: any) => ['IGNITING', 'RUNNING', 'PARABOLIC_LATE', 'FADING', 'QUIET'].includes(r.stage)));
check('has caveats', Array.isArray(runner.body?.output?.caveats) && runner.body.output.caveats.length > 0);
check('has llm_summary', typeof runner.body?.output?.llm_summary === 'string' && runner.body.output.llm_summary.includes('Runner Scan'));
console.log(`  ⏱ ${runner.ms}ms\n`);

// ============================================================
// 16. attention-momentum
// ============================================================
console.log('━━━ 16. attention-momentum ━━━');
const am = await invoke('attention-momentum', { window: '6h', limit: 10, format: 'both' }, 30000);
check('returns 200', am.status === 200, `got ${am.status}`);
check('has entries (array)', Array.isArray(am.body?.output?.entries));
check('entries have acceleration + 3-window queries', (am.body?.output?.entries ?? []).every((e: any) => typeof e.acceleration === 'number' && typeof e.queries?.prior2 === 'number'));
check('attention direction valid', (am.body?.output?.entries ?? []).every((e: any) => ['accelerating', 'rising', 'cooling', 'flat'].includes(e.attention)));
check('has sample_quality', ['low', 'moderate', 'ok'].includes(am.body?.output?.aggregate?.sample_quality));
check('has llm_summary', typeof am.body?.output?.llm_summary === 'string' && am.body.output.llm_summary.includes('Attention Momentum'));
console.log(`  ⏱ ${am.ms}ms\n`);

// ============================================================
// 17. trenches-scan
// ============================================================
console.log('━━━ 17. trenches-scan ━━━');
const ts = await invoke('trenches-scan', { max_token_age_hours: 24, min_liquidity_usd: 5000, limit: 10, format: 'both' }, 120000);
check('returns 200', ts.status === 200, `got ${ts.status}`);
check('has picks (array)', Array.isArray(ts.body?.output?.picks));
check('has confluence_counts', typeof ts.body?.output?.confluence_counts?.triple === 'number');
check('all three legs reported', ts.body?.output?.legs?.runner != null && ts.body?.output?.legs?.smart_money != null && ts.body?.output?.legs?.attention != null);
check('picks have valid verdict', (ts.body?.output?.picks ?? []).every((p: any) => ['HIGH_CONFLUENCE', 'MODERATE', 'SINGLE_SIGNAL'].includes(p.verdict)));
check('picks have reasoning', (ts.body?.output?.picks ?? []).every((p: any) => typeof p.reasoning === 'string' && p.reasoning.length > 0));
check('has llm_summary', typeof ts.body?.output?.llm_summary === 'string' && ts.body.output.llm_summary.includes('Trenches Scan'));
console.log(`  ⏱ ${ts.ms}ms\n`);

// ============================================================
// 18. trenches-check
// ============================================================
console.log('━━━ 18. trenches-check ━━━');
const tc = await invoke('trenches-check', { mint: TEST_TOKEN, format: 'both' }, 60000);
check('returns 200', tc.status === 200, `got ${tc.status}`);
check('echoes mint', tc.body?.output?.mint === TEST_TOKEN);
check('has valid verdict', ['HIGH_CONFLUENCE', 'MODERATE', 'SINGLE_SIGNAL', 'NO_SIGNAL'].includes(tc.body?.output?.verdict));
check('composite_score 0-1', tc.body?.output?.composite_score >= 0 && tc.body?.output?.composite_score <= 1);
check('has reasoning', typeof tc.body?.output?.reasoning === 'string' && tc.body.output.reasoning.length > 0);
check('has llm_summary', typeof tc.body?.output?.llm_summary === 'string' && tc.body.output.llm_summary.includes('Trenches Check'));
console.log(`  ⏱ ${tc.ms}ms\n`);

// ============================================================
// 19. exit-signal
// ============================================================
console.log('━━━ 19. exit-signal ━━━');
const ex = await invoke('exit-signal', { mint: TEST_TOKEN, entry_price_usd: 0.00001, format: 'both' }, 60000);
check('returns 200', ex.status === 200, `got ${ex.status}`);
check('echoes mint', ex.body?.output?.mint === TEST_TOKEN);
check('has valid verdict', ['EXIT', 'DERISK', 'HOLD', 'INSUFFICIENT_DATA'].includes(ex.body?.output?.verdict));
check('exit_score 0-1', ex.body?.output?.exit_score >= 0 && ex.body?.output?.exit_score <= 1);
check('has position with pnl context', ex.body?.output?.position?.entry_price_usd === 0.00001);
check('has reasoning', typeof ex.body?.output?.reasoning === 'string' && ex.body.output.reasoning.length > 0);
check('has llm_summary', typeof ex.body?.output?.llm_summary === 'string' && ex.body.output.llm_summary.includes('Exit Signal'));
console.log(`  ⏱ ${ex.ms}ms\n`);

// ============================================================
// 20. StonkFun product line
// ============================================================
import { buildExampleLaunchTransaction, EXAMPLE_LAUNCH } from '../src/sources/launchlab';
const STONK_MINT = 'HcRLc9VDgjLeK154xDawfb1dmVJ98DoSqcwTHGqiDeJR'; // ZCAT (reward, ZEC quote)

console.log('━━━ 20a. stonk-pairs (free) ━━━');
const sp = await invoke('stonk-pairs', { launchable_only: true, format: 'both' }, 30000);
check('returns 200', sp.status === 200, `got ${sp.status}`);
check('has pairs array', Array.isArray(sp.body?.output?.pairs) && sp.body.output.pairs.length > 0);
check('all rows agent-launchable', (sp.body?.output?.pairs ?? []).every((p: any) => p.is_agent_launchable === true));
check('has by_category', sp.body?.output?.by_category != null);
check('has llm_summary', typeof sp.body?.output?.llm_summary === 'string' && sp.body.output.llm_summary.includes('Pairs'));
console.log(`  ⏱ ${sp.ms}ms\n`);

console.log('━━━ 20b. stonk-reward-risk ━━━');
const sr = await invoke('stonk-reward-risk', { mint: STONK_MINT, format: 'both' }, 45000);
check('returns 200', sr.status === 200, `got ${sr.status}`);
check('score 0-100', sr.body?.output?.score >= 0 && sr.body?.output?.score <= 100, `score=${sr.body?.output?.score}`);
check('listed + withdraw authority is stonkfun', sr.body?.output?.adoption?.listed_on_stonkfun === true && sr.body?.output?.adoption?.withdraw_authority_is_stonkfun === true);
check('not BROKEN', sr.body?.output?.level !== 'BROKEN', `level=${sr.body?.output?.level}`);
check('has llm_brief', typeof sr.body?.output?.llm_brief === 'string');
console.log(`  ⏱ ${sr.ms}ms\n`);

console.log('━━━ 20c. stonk-yield ━━━');
const sy = await invoke('stonk-yield', { mint: STONK_MINT, format: 'both' }, 45000);
check('returns 200', sy.status === 200, `got ${sy.status}`);
check('lifetime yield computed', typeof sy.body?.output?.lifetime?.yield_pct === 'number', `lifetime=${sy.body?.output?.lifetime?.yield_pct}`);
check('windows carry caution flags', typeof sy.body?.output?.trailing_7d?.caution === 'boolean' && typeof sy.body?.output?.trailing_30d?.caution === 'boolean');
check('quote exposure', sy.body?.output?.quote_exposure?.long?.length === 2);
check('has llm_summary', typeof sy.body?.output?.llm_summary === 'string' && sy.body.output.llm_summary.includes('Holder Yield'));
console.log(`  ⏱ ${sy.ms}ms\n`);

console.log('━━━ 20d. stonk-screener ━━━');
const ss = await invoke('stonk-screener', { sort: 'volume24h', limit: 5, format: 'both' }, 30000);
check('returns 200', ss.status === 200, `got ${ss.status}`);
check('has rows + index status', Array.isArray(ss.body?.output?.rows) && typeof ss.body?.output?.index?.rows === 'number', `rows=${ss.body?.output?.rows?.length} index=${ss.body?.output?.index?.rows}`);
check('rows ≤ limit', (ss.body?.output?.rows?.length ?? 0) <= 5);
check('fast from cache', ss.ms < 1500, `${ss.ms}ms`);
check('has llm_summary', typeof ss.body?.output?.llm_summary === 'string' && ss.body.output.llm_summary.includes('Screener'));
console.log(`  ⏱ ${ss.ms}ms\n`);

console.log('━━━ 20e. stonk-launch-preflight ━━━');
const okTx = buildExampleLaunchTransaction();
const pf = await invoke('stonk-launch-preflight', { unsigned_transaction: okTx, quote_mint: EXAMPLE_LAUNCH.quoteMint, mode: 'reward', format: 'both' }, 30000);
check('returns 200', pf.status === 200, `got ${pf.status}`);
check('reference launch passes', pf.body?.output?.ok === true, JSON.stringify(pf.body?.output?.mismatches));
const badTx = buildExampleLaunchTransaction({ transferFee: { present: true, transferFeeBasePoints: 0, maxinumFee: '0' } }, []);
const pf2 = await invoke('stonk-launch-preflight', { unsigned_transaction: badTx, quote_mint: EXAMPLE_LAUNCH.quoteMint, mode: 'reward', launch_params: { transferFeeExtensionParams: { transferFeeBasisPoints: 300, maximumFee: '1000000000000000' } }, format: 'json' }, 30000);
check('zero-rate + missing curve rule + misspelled fields rejected', pf2.body?.output?.ok === false && (pf2.body?.output?.mismatches?.length ?? 0) >= 3, `mismatches=${pf2.body?.output?.mismatches?.map((m: any) => m.field).join(',')}`);
check('names the misspelled field', (pf2.body?.output?.mismatches ?? []).some((m: any) => m.actual === 'maximumFee' && m.expected === 'maxinumFee'));
console.log(`  ⏱ ${pf.ms}ms / ${pf2.ms}ms\n`);

console.log('━━━ 20f. stonk-gems ━━━');
const sg = await invoke('stonk-gems', { max_age_days: 30, min_holders: 10, limit: 10, format: 'both' }, 30000);
check('returns 200', sg.status === 200, `got ${sg.status}`);
check('has gems + stage counts', Array.isArray(sg.body?.output?.gems) && typeof sg.body?.output?.stage_counts?.GEM === 'number', `gems=${sg.body?.output?.gems?.length} passed=${sg.body?.output?.passed_filters}`);
check('ranked by gem_score', (sg.body?.output?.gems?.length ?? 0) < 2 || sg.body.output.gems[0].gem_score >= sg.body.output.gems.at(-1).gem_score);
check('rows carry payout_status + round_trip_pct', (sg.body?.output?.gems ?? []).every((g: any) => typeof g.payout_status === 'string' && 'round_trip_pct' in g));
check('has llm_summary', typeof sg.body?.output?.llm_summary === 'string' && sg.body.output.llm_summary.includes('Gems'));
console.log(`  ⏱ ${sg.ms}ms\n`);

console.log('━━━ 20g. stonk-launch-intel ━━━');
const si = await invoke('stonk-launch-intel', { min_coins: 20, limit: 10, format: 'both' }, 30000);
check('returns 200', si.status === 200, `got ${si.status}`);
check('has quotes + overall', Array.isArray(si.body?.output?.quotes) && typeof si.body?.output?.overall?.coins === 'number', `quotes=${si.body?.output?.quotes?.length} coins=${si.body?.output?.overall?.coins}`);
check('quotes meet min_coins', (si.body?.output?.quotes ?? []).every((q: any) => q.coins >= 20));
check('has recommendations', Array.isArray(si.body?.output?.recommendations));
check('has llm_summary', typeof si.body?.output?.llm_summary === 'string' && si.body.output.llm_summary.includes('Launch Intel'));
console.log(`  ⏱ ${si.ms}ms\n`);

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
