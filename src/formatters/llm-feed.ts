import type { FeedLatestResult } from '../enrichers/feed-store';
import { formatTrendingBriefing } from './llm-trending';

export function formatFeedLatestBriefing(data: FeedLatestResult): string {
  if (data.unchanged) {
    return [
      '## SolEnrich Daily Brief — No Update',
      '',
      `The brief generated at \`${data.generated_at}\` is older than your provided \`since\` timestamp. Nothing new since your last poll.`,
      '',
      `Next refresh expected by ~24h after \`${data.generated_at}\`.`,
    ].join('\n');
  }

  if (!data.brief) {
    return [
      '## SolEnrich Daily Brief — Empty',
      '',
      'No brief is available yet. Try again in a few seconds.',
    ].join('\n');
  }

  // Reuse the trending-signals briefing — same data shape, same narrative.
  // Add a one-line preface noting the feed cadence.
  const trending = formatTrendingBriefing(data.brief);
  const sourceNote =
    data.source === 'fresh'
      ? '_Brief generated just now (first poll since 24h cache expiry)._'
      : `_Brief cached at \`${data.generated_at}\` — refreshes daily._`;

  return [
    '## SolEnrich Daily Brief',
    '',
    sourceNote,
    '',
    trending,
  ].join('\n');
}
