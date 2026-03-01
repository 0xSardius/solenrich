export interface ParallelTask<T> {
  name: string;
  fn: () => Promise<T>;
  fallback?: T;
}

const DEFAULT_TIMEOUT = 10_000;

function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms),
    ),
  ]);
}

/**
 * Run tasks in parallel with per-task timeouts.
 * Uses Promise.allSettled — one slow/failing task never blocks others.
 * Returns a record keyed by task name.
 */
export async function parallelFetch<T>(
  tasks: ParallelTask<T>[],
  timeout = DEFAULT_TIMEOUT,
): Promise<Record<string, T | null>> {
  const results = await Promise.allSettled(
    tasks.map((task) => withTimeout(task.fn, timeout)),
  );

  const out: Record<string, T | null> = {};
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const result = results[i];
    if (result.status === 'fulfilled') {
      out[task.name] = result.value;
    } else {
      console.warn(`[parallelFetch] ${task.name} failed: ${result.reason}`);
      out[task.name] = task.fallback ?? null;
    }
  }
  return out;
}
