/**
 * Reporter — prints and saves stress test results
 */

import type { StressResults } from './stress';

export class Reporter {
  constructor(
    private results: StressResults,
    private target: string,
  ) {}

  print(): void {
    const r = this.results;

    console.log('\n══════════════════════════════════════════════════');
    console.log('  SOLENRICH STRESS TEST REPORT');
    console.log('══════════════════════════════════════════════════');
    console.log(`  Target:     ${this.target} (${r.target})`);
    console.log(`  Timestamp:  ${r.timestamp}`);
    console.log(`  Avg Latency: ${r.avg_latency_ms}ms`);
    console.log('');

    // Results table
    console.log('  Endpoint                 Status  Latency  Checks  Result');
    console.log('  ────────────────────────  ──────  ───────  ──────  ──────');

    for (const ep of r.endpoints) {
      const name = ep.endpoint.padEnd(24);
      const status = String(ep.status).padEnd(6);
      const latency = `${ep.latency_ms}ms`.padEnd(7);
      const totalChecks = ep.checks.length;
      const passedChecks = ep.checks.filter(c => c.passed).length;
      const checks = `${passedChecks}/${totalChecks}`.padEnd(6);
      const icon = ep.passed ? '  PASS' : '  FAIL';
      console.log(`  ${name}  ${status}  ${latency}  ${checks}  ${icon}`);

      if (ep.error) {
        console.log(`    Error: ${ep.error}`);
      }
    }

    console.log('');
    console.log('──────────────────────────────────────────────────');
    console.log(`  TOTAL: ${r.passed}/${r.total} passed  |  ${r.failed} failed  |  avg ${r.avg_latency_ms}ms`);
    console.log('──────────────────────────────────────────────────');

    // Data quality warnings
    const qualityIssues = r.endpoints.filter(ep =>
      ep.checks.some(c => !c.passed && c.detail?.includes('DATA QUALITY')),
    );
    if (qualityIssues.length > 0) {
      console.log('\n  DATA QUALITY WARNINGS:');
      for (const ep of qualityIssues) {
        for (const c of ep.checks.filter(c => !c.passed && c.detail)) {
          console.log(`    ${ep.endpoint}: ${c.name} — ${c.detail}`);
        }
      }
    }

    // Slow endpoints
    const slow = r.endpoints.filter(ep => ep.latency_ms > 10000);
    if (slow.length > 0) {
      console.log('\n  SLOW ENDPOINTS (>10s):');
      for (const ep of slow) {
        console.log(`    ${ep.endpoint}: ${ep.latency_ms}ms`);
      }
    }

    console.log('');
  }

  async save(): Promise<void> {
    const filename = `agents/solscout/reports/report-${this.target}-${new Date().toISOString().split('T')[0]}.json`;
    const dir = 'agents/solscout/reports';

    try {
      const { mkdir } = await import('fs/promises');
      await mkdir(dir, { recursive: true });
    } catch {}

    await Bun.write(filename, JSON.stringify(this.results, null, 2));
    console.log(`  Report saved to: ${filename}\n`);
  }
}
