#!/usr/bin/env bun
/**
 * SolScout — SolEnrich consumer agent + stress test runner
 *
 * Usage:
 *   bun run agents/solscout/index.ts --target local                    # stress test (free, local)
 *   bun run agents/solscout/index.ts --target production               # stress test (402 verification)
 *   bun run agents/solscout/index.ts --target production --paid        # stress test WITH real USDC payments
 *   bun run agents/solscout/index.ts --target local --mode demo        # demo consumer mode
 *   bun run agents/solscout/index.ts --target local --mode report      # stress test + save report
 *   bun run agents/solscout/index.ts --target production --paid --mode demo "Is JUP safe?"
 */

import { StressRunner } from './stress';
import { DemoConsumer } from './demo';
import { Reporter } from './reporter';

// --- CLI args ---
const args = process.argv.slice(2);
const target = args.includes('--target')
  ? args[args.indexOf('--target') + 1]
  : 'local';
const mode = args.includes('--mode')
  ? args[args.indexOf('--mode') + 1]
  : 'stress';
const paid = args.includes('--paid');
const only = args.includes('--only')
  ? (args[args.indexOf('--only') + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  : undefined;

const BASE_URLS: Record<string, string> = {
  local: 'http://127.0.0.1:3000',
  production: 'https://api.solenrich.com',
};

const baseUrl = BASE_URLS[target];
if (!baseUrl) {
  console.error(`Unknown target "${target}". Use: local | production`);
  process.exit(1);
}

console.log(`\n╔═══════════════════════════════════════╗`);
console.log(`║  SolScout — SolEnrich Consumer Agent  ║`);
console.log(`╚═══════════════════════════════════════╝`);
console.log(`  Target:  ${target} (${baseUrl})`);
console.log(`  Mode:    ${mode}`);
console.log(`  Payment: ${paid ? 'ENABLED (x402 USDC)' : 'disabled'}`);
console.log('');

// --- Set up fetch (paid or free) ---
let fetchFn: typeof fetch = globalThis.fetch;

if (paid) {
  const { createPaidFetch } = await import('./paid-fetch');
  fetchFn = await createPaidFetch();
}

// --- Health check ---
try {
  const res = await fetch(`${baseUrl}/health`);
  const body = await res.json() as any;
  if (!body.ok) throw new Error('Health check failed');
  console.log(`  Health: OK\n`);
} catch (e: any) {
  console.error(`  Health: FAILED — ${e.message}`);
  if (target === 'local') {
    console.error('  Start the server with: bun run dev\n');
  }
  process.exit(1);
}

// --- Run mode ---
if (mode === 'stress' || mode === 'report') {
  const runner = new StressRunner(baseUrl, paid ? fetchFn : undefined, only);
  const results = await runner.run();
  const reporter = new Reporter(results, target);
  reporter.print();
  if (mode === 'report') {
    await reporter.save();
  }
} else if (mode === 'demo') {
  const question = args.filter(a => !a.startsWith('--') && a !== target && a !== mode).join(' ')
    || 'Is JUP a safe token to hold?';
  const demo = new DemoConsumer(baseUrl, paid ? fetchFn : undefined);
  await demo.ask(question);
} else {
  console.error(`Unknown mode "${mode}". Use: stress | report | demo`);
  process.exit(1);
}
