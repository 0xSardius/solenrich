// Phase 7: Server-level verification
// Tests HTTP endpoints: /health, /.well-known/agent.json, /entrypoints, invoke
// Requires server running on port 3000: bun run dev
// Run: bun run test/test-server.ts

const BASE = 'http://127.0.0.1:3000';

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

async function get(path: string) {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: await res.json() };
}

async function post(path: string, body: any) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// ============================================================
// 1. Health endpoint
// ============================================================
console.log('\n=== 1. Health ===');
const health = await get('/health');
check('/health returns 200', health.status === 200);
check('response has ok: true', health.body.ok === true);

// ============================================================
// 2. Agent Card
// ============================================================
console.log('\n=== 2. Agent Card ===');
const card = await get('/.well-known/agent.json');
check('agent card returns 200', card.status === 200);
check('card has name', typeof card.body.name === 'string');
check('card has version', typeof card.body.version === 'string');
const skills = card.body.skills ?? card.body.entrypoints ?? [];
check('card has skills/entrypoints', Array.isArray(skills) && skills.length > 0,
  `got ${skills.length} skills`);

// ============================================================
// 3. Entrypoints listing
// ============================================================
console.log('\n=== 3. Entrypoints ===');
const entrypoints = await get('/entrypoints');
check('/entrypoints returns 200', entrypoints.status === 200);
check('has items array', Array.isArray(entrypoints.body.items));

const keys = entrypoints.body.items.map((e: any) => e.key);
check('has enrich-wallet-light', keys.includes('enrich-wallet-light'));
check('has enrich-wallet-full', keys.includes('enrich-wallet-full'));
check('has enrich-token-light', keys.includes('enrich-token-light'));
check('has enrich-token-full', keys.includes('enrich-token-full'));
check('has parse-transaction', keys.includes('parse-transaction'));
console.log(`  Registered: ${keys.join(', ')}`);

// ============================================================
// 4. Invoke: enrich-wallet-light (json)
// ============================================================
console.log('\n=== 4. Invoke: enrich-wallet-light (json) ===');
const walletJson = await post('/entrypoints/enrich-wallet-light/invoke', {
  input: { address: 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg', format: 'json' },
});
check('wallet invoke returns 200', walletJson.status === 200);
check('status is succeeded', walletJson.body.status === 'succeeded');
check('output has address', walletJson.body.output?.address === 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg');
check('output has labels', Array.isArray(walletJson.body.output?.labels));
check('output has risk_score', typeof walletJson.body.output?.risk_score === 'number');

// ============================================================
// 5. Invoke: enrich-wallet-light (llm)
// ============================================================
console.log('\n=== 5. Invoke: enrich-wallet-light (llm) ===');
const walletLlm = await post('/entrypoints/enrich-wallet-light/invoke', {
  input: { address: 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg', format: 'llm' },
});
check('llm invoke returns 200', walletLlm.status === 200);
check('output has briefing', typeof walletLlm.body.output?.briefing === 'string');
check('output has content_type', walletLlm.body.output?.content_type === 'text/markdown');
check('briefing contains wallet info', walletLlm.body.output?.briefing?.includes('Wallet Profile'));

// ============================================================
// 6. Invoke: enrich-wallet-light (both)
// ============================================================
console.log('\n=== 6. Invoke: enrich-wallet-light (both) ===');
const walletBoth = await post('/entrypoints/enrich-wallet-light/invoke', {
  input: { address: 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg', format: 'both' },
});
check('both invoke returns 200', walletBoth.status === 200);
check('output has address (json data)', typeof walletBoth.body.output?.address === 'string');
check('output has llm_summary', typeof walletBoth.body.output?.llm_summary === 'string');

// ============================================================
// 7. Input validation
// ============================================================
console.log('\n=== 7. Input Validation ===');
const badAddr = await post('/entrypoints/enrich-wallet-light/invoke', {
  input: { address: '0xinvalid', format: 'json' },
});
check('invalid address rejected', badAddr.body.error !== undefined || badAddr.status >= 400);

// ============================================================
// Summary
// ============================================================
console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
if (failed === 0) {
  console.log('✓ All Phase 7 server verification tests passed');
} else {
  console.log(`✗ ${failed} test(s) failed`);
  process.exit(1);
}
