export interface ParallelTask<T> {
  name: string;
  fn: () => Promise<T>;
  fallback?: T;
}

const DEFAULT_TIMEOUT = 10_000;

function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    fn(),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms);
    }),
    // Clear the loser: without this the pending timer's closure stays alive for
    // the full timeout after the task already resolved.
  ]).finally(() => clearTimeout(timer));
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
  return (await parallelFetchDetailed(tasks, timeout)).results;
}

/**
 * Same as parallelFetch, and also names the tasks that FAILED (threw or timed out).
 * A task that resolved to null (for example a 404 for an unknown mint) is not a failure.
 * Callers use `failed` to tell "the source said nothing" apart from "the source did not answer".
 */
export async function parallelFetchDetailed<T>(
  tasks: ParallelTask<T>[],
  timeout = DEFAULT_TIMEOUT,
): Promise<{ results: Record<string, T | null>; failed: string[] }> {
  const settled = await Promise.allSettled(
    tasks.map((task) => withTimeout(task.fn, timeout)),
  );

  const results: Record<string, T | null> = {};
  const failed: string[] = [];
  for (let i = 0; i < tasks.length; i++) {
    const task = tasks[i];
    const result = settled[i];
    if (result.status === 'fulfilled') {
      results[task.name] = result.value;
    } else {
      console.warn(`[parallelFetch] ${task.name} failed: ${result.reason}`);
      results[task.name] = task.fallback ?? null;
      failed.push(task.name);
    }
  }
  return { results, failed };
}
