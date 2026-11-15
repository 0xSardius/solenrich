// Sliding-window request limiter with two priorities (2026-11-15).
// Built for the Jupiter Free plan (measured: ~10 requests per ~10 s per account). Without it, a burst sends
// requests that fail with 429 and every field from that source goes missing. With it:
//   - 'high' calls (token lookup, single quotes) may use the full budget; they wait up to their maxWait for a
//     slot, then go anyway (the client's own 429 retry handles a miss).
//   - 'low' calls (the 4 slippage quotes) may use only budget minus reserve, so they can never starve 'high'
//     calls; when no slot frees within maxWait they are skipped and the caller reports the field unavailable.

export type Priority = 'high' | 'low';

export interface LimiterOptions {
  windowMs: number;
  capacity: number;     // total slots per window ('high' limit)
  lowReserve: number;   // slots per window that 'low' calls may not use
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class SlidingLimiter {
  private stamps: number[] = [];
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private opts: LimiterOptions) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /** Clear all slots (tests). */
  reset(): void {
    this.stamps = [];
  }

  /** Slots used in the current window. */
  used(): number {
    this.prune();
    return this.stamps.length;
  }

  /**
   * Take a slot. Resolves 'go' (slot taken), 'waited' (slot taken after waiting), 'forced' (high priority, no
   * slot within maxWait, sent anyway) or 'skip' (low priority, no slot within maxWait, nothing sent).
   */
  async acquire(priority: Priority, maxWaitMs: number): Promise<'go' | 'waited' | 'forced' | 'skip'> {
    const limit = priority === 'high' ? this.opts.capacity : this.opts.capacity - this.opts.lowReserve;
    const start = this.now();
    let waited = false;
    for (;;) {
      this.prune();
      if (this.stamps.length < limit) {
        this.stamps.push(this.now());
        return waited ? 'waited' : 'go';
      }
      // Stamps are oldest-first. To get below `limit`, the oldest (len - limit + 1) stamps must expire; the last
      // of those is stamps[len - limit].
      const freeAt = this.stamps[this.stamps.length - limit] + this.opts.windowMs;
      const remaining = maxWaitMs - (this.now() - start);
      const wait = freeAt - this.now();
      if (wait > remaining) {
        if (priority === 'high') { this.stamps.push(this.now()); return 'forced'; }
        return 'skip';
      }
      waited = true;
      await this.sleep(Math.max(1, wait));
    }
  }

  private prune(): void {
    const cutoff = this.now() - this.opts.windowMs;
    let i = 0;
    while (i < this.stamps.length && this.stamps[i] <= cutoff) i++;
    if (i > 0) this.stamps.splice(0, i);
  }
}
