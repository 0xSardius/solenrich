/**
 * Discovery metadata helpers for the x402 bazaar extension (routeConfig in agent.ts). Pure; unit-tested in
 * test/discovery-examples.test.ts.
 *
 * - describeSchema: fills a description on every parameter that has none, from a shared dictionary. Indexers that
 *   read the schema (the CDP bazaar) show it to agents; as of 2026-09-25 `format` had no description on any
 *   endpoint and the stonk filters had none either. An existing description is never overwritten.
 * - rankTags: the bazaar keeps 5 tags per resource and ranks on them. Generic tags ("solana", "onchain", …) match
 *   everything, so specific tags go first and generic ones fill what is left.
 */

export const PARAM_DESCRIPTIONS: Record<string, string> = {
  format: 'Response format: json (structured fields, default), llm (short deterministic briefing), or both (fields plus llm_summary).',
  limit: 'Maximum number of results to return.',
  address: 'Solana wallet address (base58).',
  addresses: 'Solana wallet addresses (base58).',
  mint: 'Solana token mint address (base58).',
  mints: 'Solana token mint addresses (base58).',
  quote_mint: 'Only coins paired against this StonkFun quote asset (mint, base58). stonk-pairs lists the quote assets.',
  category: 'StonkFun quote category: xstock, prestock, currency, leverage, solana, collectible, or custom.',
  min_holders: 'Minimum number of reward-receiving holders.',
  min_age_days: 'Minimum coin age in days.',
  max_age_days: 'Maximum coin age in days.',
  min_volume_24h_usd: 'Minimum 24-hour trading volume in USD.',
  max_market_cap_usd: 'Maximum market cap in USD.',
  paying_only: 'Only coins that paid holders in the last 24 hours.',
  live_only: 'Only coins that traded AND paid holders in the last 24 hours.',
  sort: 'Ranking key.',
  since: 'ISO 8601 time of your last check; events after it are returned.',
  depth: 'light (faster, fewer fields) or full (every field).',
  lookback: 'Comparison window.',
  period: 'History window.',
  window: 'Time window.',
  type: 'Entity type.',
  min_coins: 'Only quote assets with at least this many coins.',
  size_usd: 'Position size in USD.',
  hold_days: 'Planned holding period in days.',
  min_holders_change_pct: 'holders_change fires when holders moved at least this many percent since the snapshot nearest to since.',
  stale_after_hours: 'payout_stale fires when this many hours pass without a payout inside the window.',
  mode: 'StonkFun launch mode: standard or reward.',
  market: 'Perps market.',
  asset: 'Perps asset.',
  side: 'Position side: long or short.',
};

type JsonSchema = { type?: string; properties?: Record<string, Record<string, unknown>>; required?: string[]; [k: string]: unknown };

export function describeSchema<T extends JsonSchema>(schema: T): T {
  if (!schema?.properties) return schema;
  const properties: Record<string, Record<string, unknown>> = {};
  for (const [name, prop] of Object.entries(schema.properties)) {
    properties[name] = prop.description || !PARAM_DESCRIPTIONS[name] ? prop : { ...prop, description: PARAM_DESCRIPTIONS[name] };
  }
  return { ...schema, properties };
}

export const GENERIC_TAGS = new Set(['solana', 'onchain', 'onchain-data', 'ai-agents', 'defi', 'x402']);
export const MAX_TAGS = 5;

export function rankTags(tags: string[]): string[] {
  const unique = [...new Set(tags)];
  return [...unique.filter((t) => !GENERIC_TAGS.has(t)), ...unique.filter((t) => GENERIC_TAGS.has(t))].slice(0, MAX_TAGS);
}
