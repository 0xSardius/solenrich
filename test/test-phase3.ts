// Smoke test for Phase 3 — enrichers (pure functions + live API integration)
import { labelWallet, type WalletData } from '../src/enrichers/labeler';
import { scoreWalletRisk, type RiskInput } from '../src/enrichers/risk-scorer';
import { WalletProfiler } from '../src/enrichers/wallet-profiler';
import { TokenAnalyzer } from '../src/enrichers/token-analyzer';
import { TxParser } from '../src/enrichers/tx-parser';
import { Cache } from '../src/cache';
import { HeliusClient } from '../src/sources/helius';
import { BirdeyeClient } from '../src/sources/birdeye';
import { JupiterClient } from '../src/sources/jupiter';
import { SolanaRpcClient } from '../src/sources/solana-rpc';

// --- 1. Labeler (pure function) ---
console.log('--- Labeler ---');

const whaleData: WalletData = {
  balance_sol: 5000,
  portfolio_value_usd: 500_000,
  token_count: 15,
  nft_count: 25,
  tx_count_30d: 100,
  first_tx_date: '2022-01-01T00:00:00.000Z',
  defi_positions: [
    { protocol: 'Marinade', type: 'stake', value_usd: 50_000 },
    { protocol: 'Orca', type: 'lp', value_usd: 30_000 },
    { protocol: 'Raydium', type: 'lp', value_usd: 20_000 },
  ],
  top_holdings: [
    { symbol: 'SOL', usd_value: 200_000, pct_portfolio: 40 },
    { symbol: 'JTO', usd_value: 150_000, pct_portfolio: 30 },
  ],
  swap_count_30d: 60,
  daily_tx_counts: new Array(30).fill(3),
  protocols_interacted: ['Marinade', 'Orca', 'Raydium', 'Jupiter', 'Kamino'],
  stablecoin_pct: 10,
};

const labels = labelWallet(whaleData);
console.log('Labels:', labels);
console.assert(labels.includes('whale'), 'Should have whale label');
console.assert(labels.includes('active_trader'), 'Should have active_trader label');
console.assert(labels.includes('defi_user'), 'Should have defi_user label');
console.assert(labels.includes('nft_collector'), 'Should have nft_collector label');
console.assert(labels.includes('lp_provider'), 'Should have lp_provider label');
console.assert(labels.includes('airdrop_farmer'), 'Should have airdrop_farmer (5+ protocols)');

// New wallet test
const newWalletData: WalletData = {
  ...whaleData,
  first_tx_date: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
  top_holdings: [{ symbol: 'SOL', usd_value: 100, pct_portfolio: 100 }],
  nft_count: 0,
  defi_positions: [],
  swap_count_30d: 0,
  protocols_interacted: [],
  stablecoin_pct: 80,
};
const newLabels = labelWallet(newWalletData);
console.log('New wallet labels:', newLabels);
console.assert(newLabels.includes('new_wallet'), 'Should have new_wallet');
console.assert(newLabels.includes('stablecoin_heavy'), 'Should have stablecoin_heavy');

// --- 2. Risk Scorer (pure function) ---
console.log('\n--- Risk Scorer ---');

const riskyInput: RiskInput = {
  wallet_age_days: 5,
  tx_diversity: 0.05,
  protocol_breadth: 1,
  concentration: 90,
  flagged_associations: 2,
  labels: ['bot_suspect', 'airdrop_farmer'],
};

const risk = scoreWalletRisk(riskyInput);
console.log('Risk score:', risk.score, '/ 1.0');
console.log('Risk factors:', risk.factors);
console.assert(risk.score === 1.0, 'Max risky wallet should clamp to 1.0');
console.assert(risk.factors.length >= 6, 'Should have 6+ risk factors');

const safeInput: RiskInput = {
  wallet_age_days: 365,
  tx_diversity: 0.8,
  protocol_breadth: 10,
  concentration: 20,
  flagged_associations: 0,
  labels: [],
};

const safeRisk = scoreWalletRisk(safeInput);
console.log('Safe risk score:', safeRisk.score);
console.assert(safeRisk.score === 0, 'Safe wallet should be 0');

// --- 3. Live integration tests (enricher classes) ---
console.log('\n--- Live Integration ---');

const cache = new Cache();
const helius = new HeliusClient(cache);
const birdeye = new BirdeyeClient(cache);
const jupiter = new JupiterClient(cache);
const solanaRpc = new SolanaRpcClient();

// Wallet Profiler — light mode
const profiler = new WalletProfiler(helius, birdeye, solanaRpc, jupiter, cache);
try {
  const wallet = await profiler.enrich('vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg', 'light');
  console.log('Wallet profiler (light):', {
    address: wallet.address,
    sol_balance: wallet.sol_balance,
    token_count: wallet.token_count,
    labels: wallet.labels,
    risk_score: wallet.risk_score,
  });
} catch (e: any) {
  console.log('Wallet profiler: SKIPPED (', e.message, ')');
}

// Tx Parser
const txParser = new TxParser(helius, cache);
try {
  const tx = await txParser.enrich(
    '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW',
  );
  if (tx) {
    console.log('Tx parser:', {
      type: tx.type,
      protocol: tx.protocol,
      fee_sol: tx.fee_sol,
      success: tx.success,
    });
  } else {
    console.log('Tx parser: transaction not found');
  }
} catch (e: any) {
  console.log('Tx parser: SKIPPED (', e.message, ')');
}

console.log('\n✓ Phase 3 smoke tests complete');
