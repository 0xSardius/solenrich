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

// --- 1b. Behavioral detection (pure functions) ---
console.log('\n--- Behavioral Detection ---');

import {
  detectRegularIntervals,
  detectHighFrequency,
  detect247Active,
} from '../src/enrichers/labeler';

// Bot-like pattern: 90 txs at 60s cadence (89 min span — clears the 1h window threshold)
const botPattern = Array.from({ length: 90 }, (_, i) => 1_700_000_000 + i * 60);
console.assert(
  detectRegularIntervals(botPattern) === true,
  'Bot pattern should trigger regular_intervals (CV ~ 0)',
);
console.assert(
  detectHighFrequency(botPattern) === true,
  'Bot pattern at 60s cadence should trigger high_frequency (60 tx/hr)',
);
console.log('✓ bot pattern — regular_intervals + high_frequency');

// Active human trader: 30 txs over 7 days with clear daily sleep gaps (12h+)
// Should exercise 24_7_active negative path (meets length threshold, fails gap check).
const humanPattern: number[] = [];
const DAY = 24 * 3600;
for (let day = 0; day < 7; day++) {
  // 4-5 txs bunched during "daytime" (hours 12-18), variable intervals
  const base = 1_700_000_000 + day * DAY + 12 * 3600;
  humanPattern.push(base);
  humanPattern.push(base + 1_800 + Math.floor(Math.random() * 600));
  humanPattern.push(base + 6_000 + Math.floor(Math.random() * 2_000));
  humanPattern.push(base + 14_000 + Math.floor(Math.random() * 3_000));
  humanPattern.push(base + 20_000);
}
console.assert(
  detectRegularIntervals(humanPattern) === false,
  'Human pattern should NOT trigger regular_intervals (high CV)',
);
console.assert(
  detect247Active(humanPattern) === false,
  'Human pattern with 18h+ daily sleep gaps should NOT trigger 24_7_active',
);
console.log('✓ human pattern — no behavioral flags');

// Sparse wallet (< 10 txs) — all detectors return false (not null per current impl)
const sparse = [1_700_000_000, 1_700_000_001, 1_700_000_002];
console.assert(
  detectRegularIntervals(sparse) === false,
  'Sparse (<10 tx) should not trigger regular_intervals',
);
console.assert(
  detectHighFrequency(sparse) === false,
  'Sparse (<20 tx) should not trigger high_frequency',
);
console.assert(
  detect247Active(sparse) === false,
  'Sparse (<20 tx) should not trigger 24_7_active',
);
console.log('✓ sparse wallet — no false positives');

// 24/7 active: one tx every 2 hours over 5 days (60 txs, no gaps > 6h)
const alwaysOn = Array.from({ length: 60 }, (_, i) => 1_700_000_000 + i * 7_200);
console.assert(
  detect247Active(alwaysOn) === true,
  '2h cadence over 5 days should trigger 24_7_active',
);
console.log('✓ always-on pattern — 24_7_active');

// Repetitive actions: via labelWallet integration (tx_type_counts route)
const repetitiveData: WalletData = {
  ...whaleData,
  tx_count_30d: 50,
  tx_type_counts: { SWAP: 40, TRANSFER: 10 }, // 80% swap
};
const repLabels = labelWallet(repetitiveData);
console.assert(
  repLabels.includes('repetitive_actions'),
  'Wallet with 80% same-type txs should get repetitive_actions',
);
console.log('✓ repetitive pattern — repetitive_actions');

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
