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

  return labels.sort();
}
