// Smoke test for Phase 4 — LLM formatters
import { formatResponse } from '../src/formatters';
import { formatWalletBriefing } from '../src/formatters/llm-wallet';
import { formatTokenBriefing } from '../src/formatters/llm-token';
import { formatTransactionBriefing } from '../src/formatters/llm-transaction';
import type { WalletEnrichment } from '../src/enrichers/wallet-profiler';
import type { TokenEnrichment } from '../src/enrichers/token-analyzer';
import type { TransactionEnrichment } from '../src/enrichers/tx-parser';

// --- Mock data ---

const walletData: WalletEnrichment = {
  address: 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg',
  sol_balance: 1234.56,
  portfolio_value_usd: 245_000,
  token_count: 18,
  top_holdings: [
    { mint: 'So11111111111111111111111111111111111111112', symbol: 'SOL', balance: 1234.56, usd_value: 180_000 },
    { mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK', balance: 50_000_000, usd_value: 35_000 },
    { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', balance: 20_000, usd_value: 20_000 },
  ],
  nft_count: 12,
  defi_positions: [
    { protocol: 'Marinade', type: 'stake', value_usd: 50_000 },
    { protocol: 'Orca', type: 'lp', value_usd: 30_000 },
  ],
  tx_count_30d: 87,
  first_tx_date: '2022-03-15T10:00:00.000Z',
  labels: ['whale', 'defi_user', 'nft_collector'],
  risk_score: 0.15,
  risk_factors: ['Over 50% of portfolio in single holding'],
  connected_wallets: ['abc123', 'def456'],
  last_updated: '2026-03-02T12:00:00.000Z',
};

const tokenData: TokenEnrichment = {
  mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  symbol: 'BONK',
  name: 'Bonk',
  decimals: 5,
  supply: 93_526_183_000_000,
  holder_count: 834_000,
  price_usd: 0.0000234,
  market_cap: 1_540_000_000,
  volume_24h: 89_000_000,
  price_change_24h: -5.67,
  top_holders: [
    { address: 'abc123holder', balance: 1_000_000_000, pct_supply: 2.3 },
  ],
  liquidity: 45_000_000,
  risk_flags: [],
  verified: true,
  last_updated: '2026-03-02T12:00:00.000Z',
};

const txData: TransactionEnrichment = {
  signature: '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW',
  type: 'SWAP',
  description: 'Swapped 10 SOL for 15,000,000 BONK via Jupiter',
  protocol: 'Jupiter',
  fee_sol: 0.000005,
  fee_payer: 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg',
  timestamp: '2026-03-01T18:30:00.000Z',
  success: true,
  native_transfers: [
    { from: 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg', to: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', amount_sol: 10 },
  ],
  token_transfers: [
    { from: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', to: 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', symbol: 'BONK', amount: 15_000_000 },
  ],
  accounts_involved: ['vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg', 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'],
  last_updated: '2026-03-02T12:00:00.000Z',
};

// --- Test formatters ---

console.log('=== Wallet Briefing ===');
const walletBriefing = formatWalletBriefing(walletData);
console.log(walletBriefing);
console.log();

console.log('=== Token Briefing ===');
const tokenBriefing = formatTokenBriefing(tokenData);
console.log(tokenBriefing);
console.log();

console.log('=== Transaction Briefing ===');
const txBriefing = formatTransactionBriefing(txData);
console.log(txBriefing);
console.log();

// --- Test format router ---

console.log('=== Format Router: json ===');
const jsonOut = formatResponse(walletData, 'json', formatWalletBriefing);
console.assert('address' in jsonOut && !('briefing' in jsonOut), 'json format returns raw data');
console.log('json: returns raw object with', Object.keys(jsonOut).length, 'keys');

console.log('=== Format Router: llm ===');
const llmOut = formatResponse(walletData, 'llm', formatWalletBriefing) as any;
console.assert('briefing' in llmOut && llmOut.content_type === 'text/markdown', 'llm format returns briefing');
console.log('llm: returns briefing with', llmOut.briefing.length, 'chars');

console.log('=== Format Router: both ===');
const bothOut = formatResponse(walletData, 'both', formatWalletBriefing) as any;
console.assert('address' in bothOut && 'llm_summary' in bothOut, 'both format returns data + summary');
console.log('both: returns object with', Object.keys(bothOut).length, 'keys including llm_summary');

console.log('\n✓ Phase 4 smoke tests complete');
