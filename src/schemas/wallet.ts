import { z } from 'zod';
import { FormatSchema, DepthSchema, SolanaAddressSchema } from './common';

export const EnrichWalletInput = z.object({
  address: SolanaAddressSchema,
  depth: DepthSchema,
  format: FormatSchema,
});

export const WalletEnrichmentSchema = z.object({
  address: z.string(),
  sol_balance: z.number(),
  portfolio_value_usd: z.number(),
  token_count: z.number(),
  assets_truncated: z.boolean().optional().describe('True when the wallet holds more than the 3,000 assets read: counts and portfolio value are a floor'),
  top_holdings: z.array(z.object({
    mint: z.string(),
    symbol: z.string(),
    balance: z.number(),
    usd_value: z.number(),
  })),
  nft_count: z.number(),
  nft_summary: z.object({
    total: z.number(),
    collected: z.number(),
    airdropped: z.number(),
    suspected_spam: z.number(),
    distinct_collections: z.number(),
  }),
  nft_collections: z.array(z.object({
    name: z.string(),
    collection_mint: z.string().nullable(),
    count: z.number(),
    compressed: z.boolean(),
    suspected_spam: z.boolean(),
  })),
  defi_positions: z.array(z.object({
    protocol: z.string(),
    type: z.string().describe('Dominant recent transaction type: swap, transfer, or other'),
    value_usd: z.number().describe('Recent activity volume (token balance changes at today\'s price) — not an open position value'),
    value_basis: z.literal('recent_activity_volume').optional(),
    tx_count: z.number().optional().describe('Recent transactions that touched the protocol'),
  })).describe('Recent activity per known DeFi protocol, not open positions'),
  tx_count_30d: z.number(),
  tx_count_30d_capped: z.boolean().describe('True when tx_count_30d is a lower bound'),
  first_tx_date: z.string().nullable().describe('Null when the history is longer than the pages read'),
  first_seen_at_least: z.string().nullable().describe('Oldest transaction read: the wallet is at least this old'),
  last_tx_date: z.string().nullable(),
  history_complete: z.boolean(),
  labels: z.array(z.string()),
  risk_score: z.number(),
  risk_level: z.string(),
  risk_factors: z.array(z.string()),
  connected_wallets: z.array(z.object({ address: z.string(), entity_label: z.string().optional(), entity_type: z.string().optional() })),
  data_quality: z.object({ degraded: z.boolean(), unavailable: z.array(z.string()) }),
  last_updated: z.string(),
});
