/**
 * Demand-driven cache warmer.
 *
 * Some endpoints take 25–60s cold and 0s warm (their result is cached for
 * minutes). A paid call that lands on a cold cache risks outliving the
 * payer's blockhash. The warmer re-runs the DEFAULT-input invocation of a
 * registered endpoint shortly after its cache expires, but only while the
 * endpoint has been called recently (the demand window). Nobody pays upstream
 * cost to keep an endpoint warm that no one is calling; an agent that polls
 * keeps it warm for itself.
 *
 * `run` is the same enricher call the handler makes with schema defaults, so
 * it fills the same cache key. On a cache hit it costs one Redis GET.
 *
 * Pure scheduling logic; `tick()` is explicit so tests drive the clock.
 */
export interface WarmEntry {
  /** Endpoint key, e.g. "smart-money-flow". */
  key: string;
  /** Cache TTL of the default-input result, seconds. */
  ttlSec: number;
  /** Re-run the default invocation (fills the cache as a side effect). */
  run: () => Promise<unknown>;
  /** Only warm while the endpoint was called within this window. Default: warmer's default. */
  demandWindowSec?: number;
}

interface WarmState extends WarmEntry {
  lastDemandMs: number | null;
  lastRunMs: number | null;
  running: boolean;
  runs: number;
  failures: number;
  lastRunDurationMs: number | null;
  lastError: string | null;
}

export interface WarmerOptions {
  now?: () => number;
  log?: (msg: string) => void;
  /** Default demand window, seconds. */
  defaultDemandWindowSec?: number;
  /** Seconds to wait past TTL before re-running (lets the key actually expire). */
  graceSec?: number;
}

export class CacheWarmer {
  private readonly entries = new Map<string, WarmState>();
  private readonly now: () => number;
  private readonly log: (msg: string) => void;
  private readonly defaultDemandWindowSec: number;
  private readonly graceSec: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: WarmerOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? ((m) => console.log(m));
    this.defaultDemandWindowSec = opts.defaultDemandWindowSec ?? 2 * 3600;
    this.graceSec = opts.graceSec ?? 5;
  }

  register(entry: WarmEntry): void {
    this.entries.set(entry.key, {
      ...entry,
      lastDemandMs: null,
      lastRunMs: null,
      running: false,
      runs: 0,
      failures: 0,
      lastRunDurationMs: null,
      lastError: null,
    });
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  /** Record that `key` was called (any input). Unregistered keys are ignored. */
  note(key: string, at: number = this.now()): void {
    const e = this.entries.get(key);
    if (e) e.lastDemandMs = at;
  }

  /** Keys that are in demand, past TTL+grace since their last warm run, and not running. */
  due(at: number = this.now()): string[] {
    const out: string[] = [];
    for (const e of this.entries.values()) {
      if (e.running || e.lastDemandMs == null) continue;
      const window = (e.demandWindowSec ?? this.defaultDemandWindowSec) * 1000;
      if (at - e.lastDemandMs > window) continue;
      const minGap = (e.ttlSec + this.graceSec) * 1000;
      if (e.lastRunMs != null && at - e.lastRunMs < minGap) continue;
      out.push(e.key);
    }
    return out;
  }

  /** Run every due entry in parallel. Never throws. */
  async tick(at: number = this.now()): Promise<string[]> {
    const keys = this.due(at);
    await Promise.all(
      keys.map(async (key) => {
        const e = this.entries.get(key)!;
        e.running = true;
        const started = this.now();
        try {
          await e.run();
          e.runs++;
          e.lastError = null;
        } catch (err) {
          e.failures++;
          e.lastError = err instanceof Error ? err.message : String(err);
          this.log(`[warm] ${key} failed: ${e.lastError}`);
        } finally {
          e.running = false;
          e.lastRunMs = this.now();
          e.lastRunDurationMs = e.lastRunMs - started;
          this.log(`[warm] ${key} ${e.lastError ? 'FAIL' : 'ok'} ${e.lastRunDurationMs}ms`);
        }
      }),
    );
    return keys;
  }

  start(intervalMs = 15_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((err) => this.log(`[warm] tick error: ${err}`));
    }, intervalMs);
    // Do not keep the process alive for the warmer alone.
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  stats(at: number = this.now()): Record<string, {
    in_demand: boolean;
    warm: boolean;
    last_demand_at: string | null;
    last_run_at: string | null;
    last_run_ms: number | null;
    runs: number;
    failures: number;
    last_error: string | null;
  }> {
    const out: ReturnType<CacheWarmer['stats']> = {};
    for (const e of this.entries.values()) {
      const window = (e.demandWindowSec ?? this.defaultDemandWindowSec) * 1000;
      out[e.key] = {
        in_demand: e.lastDemandMs != null && at - e.lastDemandMs <= window,
        warm: e.lastRunMs != null && e.lastError == null && at - e.lastRunMs < e.ttlSec * 1000,
        last_demand_at: e.lastDemandMs ? new Date(e.lastDemandMs).toISOString() : null,
        last_run_at: e.lastRunMs ? new Date(e.lastRunMs).toISOString() : null,
        last_run_ms: e.lastRunDurationMs,
        runs: e.runs,
        failures: e.failures,
        last_error: e.lastError,
      };
    }
    return out;
  }
}
