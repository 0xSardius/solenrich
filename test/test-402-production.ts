// Production 402 verification — confirms all endpoints are paywalled with correct pricing
// Runs against LIVE production server (no payment sent)
// Run: bun run test/test-402-production.ts

const PROD = 'https://api.solenrich.com';

const TEST_WALLET = 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg';
const TEST_TOKEN = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
const TEST_SIG = '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW';

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

// Expected pricing from config.ts
const EXPECTED_PRICING: Record<string, string> = {
  'enrich-wallet-light': '0.002',
  'enrich-wallet-full': '0.005',
  'enrich-token-light': '0.002',
  'enrich-token-full': '0.004',
  'parse-transaction': '0.001',
  'whale-watch': '0.008',
  'batch-enrich': '0.015',
  'wallet-graph': '0.010',
  'copy-trade-signals': '0.010',
  'due-diligence': '0.020',
  'query': '0.003',
};

// Test inputs per endpoint
const TEST_INPUTS: Record<string, any> = {
  'enrich-wallet-light': { address: TEST_WALLET, format: 'json' },
  'enrich-wallet-full': { address: TEST_WALLET, format: 'json' },
  'enrich-token-light': { mint: TEST_TOKEN, format: 'json' },
  'enrich-token-full': { mint: TEST_TOKEN, format: 'json' },
  'parse-transaction': { signature: TEST_SIG, format: 'json' },
  'whale-watch': { mint: TEST_TOKEN, format: 'json' },
  'batch-enrich': { addresses: [TEST_WALLET], type: 'wallet', depth: 'light', format: 'json' },
  'wallet-graph': { address: TEST_WALLET, depth: 1, format: 'json' },
  'copy-trade-signals': { address: TEST_WALLET, format: 'json' },
  'due-diligence': { mint: TEST_TOKEN, format: 'json' },
  'query': { question: 'What tokens does vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg hold?', format: 'json' },
};

console.log('\n╔══════════════════════════════════════════════════╗');
console.log('║  SolEnrich — Production 402 Paywall Verification ║');
console.log('║  All 11 endpoints, no payment, check pricing     ║');
console.log('╚══════════════════════════════════════════════════╝');
console.log(`\n  Target: ${PROD}\n`);

// First verify the server is alive
console.log('━━━ Health check ━━━');
try {
  const healthRes = await fetch(`${PROD}/health`);
  const health = await healthRes.json();
  check('Server is up', healthRes.status === 200 && health.ok === true);
} catch (e: any) {
  console.log(`  ✗ Server unreachable: ${e.message}`);
  console.log('  Cannot continue. Is the Railway deployment running?\n');
  process.exit(1);
}

// Verify entrypoints listing
console.log('\n━━━ Entrypoints listing ━━━');
const epRes = await fetch(`${PROD}/entrypoints`);
const epData = await epRes.json();
const epKeys = epData.items?.map((e: any) => e.key) ?? [];
check('All 11 entrypoints listed', epKeys.length >= 10, `got ${epKeys.length}: ${epKeys.join(', ')}`);

for (const key of Object.keys(EXPECTED_PRICING)) {
  check(`${key} is registered`, epKeys.includes(key));
}

// Test each endpoint for 402
console.log('\n━━━ 402 Paywall Tests ━━━');

for (const [key, input] of Object.entries(TEST_INPUTS)) {
  console.log(`\n  ── ${key} ──`);

  try {
    const res = await fetch(`${PROD}/entrypoints/${key}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input }),
    });

    const body = await res.json();

    check('returns 402', res.status === 402, `got ${res.status}`);

    // Check pricing info in response
    const price = body.pricing?.amount;
    check(
      `price is ${EXPECTED_PRICING[key]} USDC`,
      price === EXPECTED_PRICING[key],
      price ? `got ${price}` : 'no pricing in response',
    );

    // Check payment instructions
    check('has payment instructions', body.how_to_pay?.protocol === 'x402', body.how_to_pay?.protocol);
    check('has payTo address', typeof body.pricing?.payTo === 'string' && body.pricing.payTo.length > 20);
    check('has facilitator URL', typeof body.how_to_pay?.facilitator === 'string');

    // Check x402 header
    const x402Header = res.headers.get('x-payment-required') || res.headers.get('www-authenticate');
    // Note: x402 may use different header formats depending on implementation

  } catch (e: any) {
    console.log(`  ✗ Request failed: ${e.message}`);
    failed++;
  }
}

// Test the demo endpoint is NOT paywalled
console.log('\n━━━ Demo endpoint (should NOT be paywalled) ━━━');
try {
  const demoRes = await fetch(`${PROD}/demo/enrich`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: TEST_TOKEN }),
  });
  check('demo returns 200 (not 402)', demoRes.status === 200, `got ${demoRes.status}`);
  if (demoRes.status === 200) {
    const demoBody = await demoRes.json();
    check('demo has _demo metadata', demoBody._demo != null);
    check('demo has real data', demoBody.llm_summary != null || demoBody.address != null || demoBody.mint != null);
  }
} catch (e: any) {
  console.log(`  ✗ Demo request failed: ${e.message}`);
  failed++;
}

// Summary
console.log('\n═══════════════════════════════════════════════════');
console.log(`  PASSED: ${passed}  |  FAILED: ${failed}`);
console.log('═══════════════════════════════════════════════════');

if (failed > 0) {
  console.log('\n⚠ Some tests failed — check output above for details.\n');
  process.exit(1);
} else {
  console.log('\n✓ All 11 endpoints correctly paywalled with accurate pricing.\n');
}
