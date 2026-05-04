import { z } from 'zod';
import { FormatSchema } from './common';

/**
 * Input schema for `feed-latest`. Minimal — Feed V1 returns one canonical
 * daily brief, no per-call parameterization needed. Optional `since` lets
 * agents skip paying for data they already polled.
 */
export const FeedLatestInput = z.object({
  /** Agent's last successful poll timestamp (ISO 8601). If the cached brief is
   *  not newer than this, the response includes `unchanged: true` and an empty
   *  payload — agent can short-circuit without re-processing. */
  since: z.string().datetime().optional(),
  format: FormatSchema,
});
export type FeedLatestInput = z.infer<typeof FeedLatestInput>;
