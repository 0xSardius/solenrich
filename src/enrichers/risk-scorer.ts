// Pure function — receives wallet/token metrics, returns 0.0-1.0 risk score. No API calls.

export type RiskLevel = 'LOW' | 'MODERATE' | 'ELEVATED' | 'HIGH' | 'CRITICAL';

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
  risk_level: RiskLevel;
  factors: string[];
}

export function getRiskLevel(score: number): RiskLevel {
  if (score < 0.2) return 'LOW';
  if (score < 0.4) return 'MODERATE';
  if (score < 0.6) return 'ELEVATED';
  if (score < 0.8) return 'HIGH';
  return 'CRITICAL';
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

  const finalScore = Math.min(1.0, Math.max(0.0, score));
  return {
    score: finalScore,
    risk_level: getRiskLevel(finalScore),
    factors,
  };
}

// --- Token-specific risk scoring ---

export interface TokenRiskInput {
  risk_flags_count: number;
  verified: boolean;
  mint_authority_active: boolean;
  freeze_authority_active: boolean;
  liquidity: number;
  holder_concentration_top1?: number;
  holder_concentration_top5?: number;
  whale_distributing?: boolean;
}

export function scoreTokenRisk(data: TokenRiskInput): RiskResult {
  let score = 0;
  const factors: string[] = [];

  // Risk flags from token analysis
  if (data.risk_flags_count > 0) {
    const penalty = Math.min(0.3, data.risk_flags_count * 0.08);
    score += penalty;
    factors.push(`${data.risk_flags_count} risk flag(s) identified`);
  }

  // Not verified on Jupiter
  if (!data.verified) {
    score += 0.15;
    factors.push('Not verified on Jupiter');
  }

  // Mint authority active (can inflate supply)
  if (data.mint_authority_active) {
    score += 0.20;
    factors.push('Mint authority active — supply can be inflated');
  }

  // Freeze authority active (can freeze accounts)
  if (data.freeze_authority_active) {
    score += 0.10;
    factors.push('Freeze authority active — accounts can be frozen');
  }

  // Low liquidity
  if (data.liquidity < 10_000) {
    score += 0.20;
    factors.push('Very low liquidity (< $10K)');
  } else if (data.liquidity < 50_000) {
    score += 0.10;
    factors.push('Low liquidity (< $50K)');
  }

  // Holder concentration
  if (data.holder_concentration_top1 != null && data.holder_concentration_top1 > 50) {
    score += 0.20;
    factors.push(`Top holder controls ${data.holder_concentration_top1.toFixed(1)}% of supply`);
  } else if (data.holder_concentration_top1 != null && data.holder_concentration_top1 > 25) {
    score += 0.10;
    factors.push(`Top holder controls ${data.holder_concentration_top1.toFixed(1)}% of supply`);
  }

  if (data.holder_concentration_top5 != null && data.holder_concentration_top5 > 80) {
    score += 0.15;
    factors.push(`Top 5 holders control ${data.holder_concentration_top5.toFixed(1)}% of supply`);
  }

  // Whale distribution
  if (data.whale_distributing) {
    score += 0.10;
    factors.push('Whale distribution activity detected');
  }

  const finalScore = Math.min(1.0, Math.max(0.0, score));
  return {
    score: Math.round(finalScore * 100) / 100,
    risk_level: getRiskLevel(finalScore),
    factors,
  };
}
