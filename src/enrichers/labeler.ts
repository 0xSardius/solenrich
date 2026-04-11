// Pure function — receives wallet data, returns label strings. No API calls.

export interface WalletData {
  balance_sol: number;
  portfolio_value_usd: number;
  token_count: number;
  nft_count: number;
  tx_count_30d: number;
  first_tx_date: string | null;
  defi_positions: { protocol: string; type: string; value_usd: number }[];
  top_holdings: { symbol: string; usd_value: number; pct_portfolio: number }[];
  swap_count_30d: number;
  daily_tx_counts: number[];
  protocols_interacted: string[];
  stablecoin_pct: number;
  // Behavioral signal data (optional — older callers may not provide these)
  tx_timestamps?: number[];    // blockTime values (unix seconds) for recent txs
  tx_type_counts?: Record<string, number>; // e.g. { SWAP: 80, TRANSFER: 15, UNKNOWN: 5 }
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

const LP_TYPES = new Set(['lp', 'liquidity', 'pool', 'amm', 'clmm']);

export function labelWallet(data: WalletData): string[] {
  const labels: string[] = [];
  const now = Date.now();

  // whale: any single holding > $100k
  if (data.top_holdings.some((h) => h.usd_value > 100_000)) {
    labels.push('whale');
  }

  // active_trader: 50+ swaps in 30d
  if (data.swap_count_30d > 50) {
    labels.push('active_trader');
  }

  // defi_user: positions in 2+ distinct protocols
  const uniqueProtocols = new Set(data.defi_positions.map((p) => p.protocol));
  if (uniqueProtocols.size >= 2) {
    labels.push('defi_user');
  }

  // nft_collector: 10+ NFTs
  if (data.nft_count >= 10) {
    labels.push('nft_collector');
  }

  // new_wallet: first tx within last 30 days
  if (data.first_tx_date) {
    const firstTxTime = new Date(data.first_tx_date).getTime();
    if (now - firstTxTime < THIRTY_DAYS_MS) {
      labels.push('new_wallet');
    }
  }

  // dormant: no txs in 30d and last tx > 90 days ago
  if (data.tx_count_30d === 0 && data.first_tx_date) {
    const firstTxTime = new Date(data.first_tx_date).getTime();
    if (now - firstTxTime > NINETY_DAYS_MS) {
      labels.push('dormant');
    }
  }

  // airdrop_farmer: 5+ protocols interacted in 30d
  if (data.protocols_interacted.length >= 5) {
    labels.push('airdrop_farmer');
  }

  // bot_suspect: any day with 500+ txs
  if (data.daily_tx_counts.some((count) => count > 500)) {
    labels.push('bot_suspect');
  }

  // stablecoin_heavy: >60% portfolio in stables
  if (data.stablecoin_pct > 60) {
    labels.push('stablecoin_heavy');
  }

  // lp_provider: 2+ LP-type defi positions
  const lpPositions = data.defi_positions.filter((p) =>
    LP_TYPES.has(p.type.toLowerCase()),
  );
  if (lpPositions.length >= 2) {
    labels.push('lp_provider');
  }

  // --- Behavioral / automated activity signals ---
  // These analyze transaction timing patterns to surface automated behavior.
  // Framed as signals, not binary bot/human classification.

  if (data.tx_timestamps && data.tx_timestamps.length >= 10) {
    const ts = data.tx_timestamps;

    if (detectRegularIntervals(ts)) labels.push('regular_intervals');
    if (detectHighFrequency(ts)) labels.push('high_frequency');
    if (detect247Active(ts)) labels.push('24_7_active');
  }

  if (data.tx_type_counts && data.tx_count_30d >= 20) {
    if (detectRepetitiveActions(data.tx_type_counts, data.tx_count_30d)) {
      labels.push('repetitive_actions');
    }
  }

  return labels.sort();
}

// --- Behavioral detection helpers (pure functions, exported for protocol-analyzer) ---

/**
 * Regular intervals: low coefficient of variation in time gaps between txs.
 * Humans trade irregularly; bots trade on schedule.
 * CV < 0.3 with at least 10 txs = strong regularity signal.
 */
export function detectRegularIntervals(timestamps: number[]): boolean {
  if (timestamps.length < 10) return false;
  const sorted = [...timestamps].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length < 9) return false;

  const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  if (mean < 10) return false; // too close together to be meaningful
  const variance = gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length;
  const std = Math.sqrt(variance);
  const cv = std / mean; // coefficient of variation

  return cv < 0.3;
}

/**
 * High frequency: sustained rate of 20+ txs per hour over the analysis window.
 */
export function detectHighFrequency(timestamps: number[]): boolean {
  if (timestamps.length < 20) return false;
  const sorted = [...timestamps].sort((a, b) => a - b);
  const windowSeconds = sorted[sorted.length - 1] - sorted[0];
  if (windowSeconds < 3600) return false; // need at least 1 hour window
  const txPerHour = (timestamps.length / windowSeconds) * 3600;
  return txPerHour >= 20;
}

/**
 * 24/7 active: no gaps longer than 6 hours across a multi-day window.
 * Humans sleep; bots don't.
 */
export function detect247Active(timestamps: number[]): boolean {
  if (timestamps.length < 20) return false;
  const sorted = [...timestamps].sort((a, b) => a - b);
  const windowSeconds = sorted[sorted.length - 1] - sorted[0];
  // Need at least 48 hours of data to detect sleep patterns
  if (windowSeconds < 48 * 3600) return false;

  const sixHours = 6 * 3600;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] > sixHours) return false; // found a sleep gap
  }
  return true;
}

/**
 * Repetitive actions: >70% of txs are the same type.
 * Humans diversify; bots repeat the same action.
 */
function detectRepetitiveActions(typeCounts: Record<string, number>, totalTxs: number): boolean {
  if (totalTxs < 20) return false;
  const maxTypeCount = Math.max(...Object.values(typeCounts));
  return maxTypeCount / totalTxs > 0.7;
}
