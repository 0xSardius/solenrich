// Pure function — receives wallet metrics, returns 0.0-1.0 risk score. No API calls.

export interface RiskInput {
  wallet_age_days: number;
  tx_diversity: number;
  protocol_breadth: number;
  concentration: number;
  flagged_associations: number;
  labels: string[];
}

export interface RiskResult {
  score: number;
  factors: string[];
}

export function scoreWalletRisk(data: RiskInput): RiskResult {
  let score = 0;
  const factors: string[] = [];

  // Wallet age
  if (data.wallet_age_days < 7) {
    score += 0.20;
    factors.push('Wallet less than 7 days old');
  } else if (data.wallet_age_days < 30) {
    score += 0.10;
    factors.push('Wallet less than 30 days old');
  }

  // Concentration
  if (data.concentration > 80) {
    score += 0.20;
    factors.push('Over 80% of portfolio in single holding');
  } else if (data.concentration > 50) {
    score += 0.10;
    factors.push('Over 50% of portfolio in single holding');
  }

  // Flagged associations
  if (data.flagged_associations > 0) {
    score += 0.25;
    factors.push(`${data.flagged_associations} transaction(s) with flagged addresses`);
  }

  // Bot suspect label
  if (data.labels.includes('bot_suspect')) {
    score += 0.15;
    factors.push('Bot-like transaction patterns detected');
  }

  // Airdrop farmer label
  if (data.labels.includes('airdrop_farmer')) {
    score += 0.10;
    factors.push('Airdrop farming behavior detected');
  }

  // Low tx diversity
  if (data.tx_diversity < 0.1) {
    score += 0.10;
    factors.push('Low transaction diversity');
  }

  // Low protocol breadth
  if (data.protocol_breadth < 2) {
    score += 0.05;
    factors.push('Interacts with fewer than 2 protocols');
  }

  return {
    score: Math.min(1.0, Math.max(0.0, score)),
    factors,
  };
}
