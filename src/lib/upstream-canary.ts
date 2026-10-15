/**
 * Upstream canary (2026-10-14). Once an hour, call each upstream through OUR client code with a known input, and
 * report failures in /status.
 *
 * Why: upstreams change under us and enrichers swallow the error (Promise.allSettled, null fallbacks), so an
 * endpoint keeps returning 200 with less data. Four silent breaks so far: Birdeye free tier exhausted, Jupiter's
 * tokens.jup.ag host died, the x402scan logo URL, and Helius rejecting `/v0/transactions/` (trailing slash).
 *
 * The probes call the real client methods so a bug in our request code is caught too. Clients get a cache that
 * stores nothing, so every probe reaches the upstream and the shared cache is untouched.
 * A failure is a note in /status, not "degraded": the paid endpoints still answer, with less data.
 */
import type { Cache } from '../cache/index';

export interface Probe {
  name: string;
  /** Resolves true when the upstream answered with the expected shape. Throwing counts as a failure. */
  run: () => Promise<boolean>;
}

export interface ProbeResult {
  ok: boolean;
  checked_at: string;
  ms: number;
  error: string | null;
}

export const CANARY_INTERVAL_MS = 60 * 60_000;
export const PROBE_TIMEOUT_MS = 15_000;

/** A cache that never stores: probes always reach the upstream. */
export const NULL_CACHE = new Proxy({}, { get: () => async () => null }) as unknown as Cache;

/** Pure: the /status reasons for the current results. */
export function canaryReasons(results: Record<string, ProbeResult>): string[] {
  return Object.entries(results)
    .filter(([, r]) => !r.ok)
    .map(([name, r]) => `upstream ${name} failing since check at ${r.checked_at}${r.error ? `: ${r.error}` : ''}`);
}

export class UpstreamCanary {
  private results: Record<string, ProbeResult> = {};
  private running = false;

  constructor(private probes: Probe[], private timeoutMs = PROBE_TIMEOUT_MS) {}

  async runOnce(): Promise<Record<string, ProbeResult>> {
    if (this.running) return this.results;
    this.running = true;
    try {
      await Promise.all(
        this.probes.map(async (p) => {
          const t0 = Date.now();
          let ok = false;
          let error: string | null = null;
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const timeout = new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error(`timeout after ${this.timeoutMs / 1000}s`)), this.timeoutMs);
            });
            ok = await Promise.race([p.run(), timeout]);
            if (!ok) error = 'unexpected response shape';
          } catch (err) {
            error = (err instanceof Error ? err.message : String(err)).slice(0, 160);
          } finally {
            clearTimeout(timer);
          }
          const prev = this.results[p.name];
          if (prev && prev.ok !== ok) console.warn(`[canary] ${p.name} ${ok ? 'recovered' : `failing: ${error}`}`);
          else if (!prev && !ok) console.warn(`[canary] ${p.name} failing: ${error}`);
          this.results[p.name] = { ok, checked_at: new Date().toISOString(), ms: Date.now() - t0, error };
        }),
      );
    } finally {
      this.running = false;
    }
    return this.results;
  }

  status(): Record<string, ProbeResult> {
    return this.results;
  }

  start(firstDelayMs = 2 * 60_000): void {
    setTimeout(() => void this.runOnce(), firstDelayMs).unref?.();
    setInterval(() => void this.runOnce(), CANARY_INTERVAL_MS).unref?.();
  }
}
