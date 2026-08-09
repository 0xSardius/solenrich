/**
 * Read and discard a Response body.
 *
 * An unread body keeps its native stream alive on Bun 1.3.14 — ~0.7KB per
 * response, measured 2026-08-09. Same family as the abandoned `Request.clone()`
 * tee that cost 261KB/request and caused the recurring 8GB OOM (see the note in
 * `src/lib/agent.ts`). Individually small, but it only ever accumulates, so
 * drain before any early return or throw that abandons a Response.
 *
 * Never throws: a body that was already consumed, or never existed, is fine.
 */
export async function drain(res: Response): Promise<void> {
  try {
    await res.text();
  } catch {
    /* already consumed or bodyless — nothing to release */
  }
}
