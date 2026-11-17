// Pure function — receives wallet/token metrics, returns 0.0-1.0 risk score. No API calls.

export type RiskLevel = 'LOW' | 'MODERATE' | 'ELEVATED' | 'HIGH' | 'CRITICAL';

/** Inputs that were not measured are null/undefined and are NOT scored (2026-11-17): a light profile never reads
 *  enhanced transactions, so "low tx diversity" and "< 2 protocols" were penalties for data never read. */
export interface RiskInput {
  /** null = unknown (history longer than the pages read, or the signature read failed). */
  wallet_age_days: number | null;
  tx_diversity?: number | null;
  protocol_breadth?: number | null;
  concentration: number;
  flagged_associations: number;
  labels: string[];
}

/** Score boundaries for getRiskLevel (lower bound of each level). Also published in /docs. */
export const RISK_LEVELS: Array<[RiskLevel, number]> = [['LOW', 0], ['MODERATE', 0.2], ['ELEVATED', 0.4], ['HIGH', 0.6], ['CRITICAL', 0.8]];

/** Wallet risk weights. scoreWalletRisk uses these; /docs prints them (test/unit keeps the two in sync). */
export const WALLET_RISK_WEIGHTS = {
  age_lt_7d: 0.20,
  age_lt_30d: 0.10,
  concentration_gt_80: 0.20,
  concentration_gt_50: 0.10,
  flagged_association: 0.25,
  bot_suspect: 0.15,
  airdrop_farmer: 0.10,
  low_tx_diversity: 0.10,
  low_protocol_breadth: 0.05,
} as const;

/** Token risk weights. scoreTokenRisk uses these; /docs prints them. */
export const TOKEN_RISK_WEIGHTS = {
  per_risk_flag: 0.08,
  risk_flags_max: 0.3,
  unverified: 0.15,
  mint_authority: 0.20,
  freeze_authority: 0.10,
  liquidity_lt_10k: 0.20,
  liquidity_lt_50k: 0.10,
  top1_gt_50: 0.20,
  top1_gt_25: 0.10,
  top5_gt_80: 0.15,
  hhi_gt_2500: 0.15,
  hhi_gt_1500: 0.05,
  whale_distributing: 0.10,
} as const;

export interface RiskResult {
  score: number;
  risk_level: RiskLevel;
  factors: string[];
}

/** Human-readable level ranges for /docs, built from RISK_LEVELS: { LOW: '< 0.2', MODERATE: '0.2 – 0.4', … }. */
export function riskLevelRanges(): Record<string, string> {
  const out: Record<string, string> = {};
  RISK_LEVELS.forEach(([level, min], i) => {
    const next = RISK_LEVELS[i + 1]?.[1];
    out[level] = i === 0 ? `< ${next}` : next == null ? `≥ ${min}` : `${min} – ${next}`;
  });
  return out;
}

export function getRiskLevel(score: number): RiskLevel {
  let level: RiskLevel = 'LOW';
  for (const [l, min] of RISK_LEVELS) if (score >= min) level = l;
  return level;
}

export function scoreWalletRisk(data: RiskInput): RiskResult {
  const W = WALLET_RISK_WEIGHTS;
  let score = 0;
  const factors: string[] = [];

  // Wallet age — only when known
  if (data.wallet_age_days != null && data.wallet_age_days < 7) {
    score += W.age_lt_7d;
    factors.push('Wallet less than 7 days old');
  } else if (data.wallet_age_days != null && data.wallet_age_days < 30) {
    score += W.age_lt_30d;
    factors.push('Wallet less than 30 days old');
  }

  // Concentration
  if (data.concentration > 80) {
    score += W.concentration_gt_80;
    factors.push('Over 80% of portfolio in single holding');
  } else if (data.concentration > 50) {
    score += W.concentration_gt_50;
    factors.push('Over 50% of portfolio in single holding');
  }

  // Flagged associations
  if (data.flagged_associations > 0) {
    score += W.flagged_association;
    factors.push(`${data.flagged_associations} transaction(s) with flagged addresses`);
  }

  // Bot suspect label
  if (data.labels.includes('bot_suspect')) {
    score += W.bot_suspect;
    factors.push('Bot-like transaction patterns detected');
  }

  // Airdrop farmer label
  if (data.labels.includes('airdrop_farmer')) {
    score += W.airdrop_farmer;
    factors.push('Airdrop farming behavior detected');
  }

  // Low tx diversity — only when measured (full depth with enhanced transactions)
  if (data.tx_diversity != null && data.tx_diversity < 0.1) {
    score += W.low_tx_diversity;
    factors.push('Low transaction diversity');
  }

  // Low protocol breadth — only when measured
  if (data.protocol_breadth != null && data.protocol_breadth < 2) {
    score += W.low_protocol_breadth;
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
  /** null = Jupiter did not answer; no penalty for an unread value. */
  verified: boolean | null;
  mint_authority_active: boolean;
  freeze_authority_active: boolean;
  /** null = no source reported liquidity; no penalty for an unread value. */
  liquidity: number | null;
  holder_concentration_top1?: number;
  holder_concentration_top5?: number;
  herfindahl_index?: number;
  whale_distributing?: boolean;
}

export function scoreTokenRisk(data: TokenRiskInput): RiskResult {
  const W = TOKEN_RISK_WEIGHTS;
  let score = 0;
  const factors: string[] = [];

  // Risk flags from token analysis
  if (data.risk_flags_count > 0) {
    score += Math.min(W.risk_flags_max, data.risk_flags_count * W.per_risk_flag);
    factors.push(`${data.risk_flags_count} risk flag(s) identified`);
  }

  // Not verified on Jupiter (null = Jupiter did not answer: not scored)
  if (data.verified === false) {
    score += W.unverified;
    factors.push('Not verified on Jupiter');
  }

  // Mint authority active (can inflate supply)
  if (data.mint_authority_active) {
    score += W.mint_authority;
    factors.push('Mint authority active — supply can be inflated');
  }

  // Freeze authority active (can freeze accounts)
  if (data.freeze_authority_active) {
    score += W.freeze_authority;
    factors.push('Freeze authority active — accounts can be frozen');
  }

  // Low liquidity (null = not reported: not scored)
  if (data.liquidity != null && data.liquidity < 10_000) {
    score += W.liquidity_lt_10k;
    factors.push('Very low liquidity (< $10K)');
  } else if (data.liquidity != null && data.liquidity < 50_000) {
    score += W.liquidity_lt_50k;
    factors.push('Low liquidity (< $50K)');
  }

  // Holder concentration
  if (data.holder_concentration_top1 != null && data.holder_concentration_top1 > 50) {
    score += W.top1_gt_50;
    factors.push(`Top holder controls ${data.holder_concentration_top1.toFixed(1)}% of supply`);
  } else if (data.holder_concentration_top1 != null && data.holder_concentration_top1 > 25) {
    score += W.top1_gt_25;
    factors.push(`Top holder controls ${data.holder_concentration_top1.toFixed(1)}% of supply`);
  }

  if (data.holder_concentration_top5 != null && data.holder_concentration_top5 > 80) {
    score += W.top5_gt_80;
    factors.push(`Top 5 holders control ${data.holder_concentration_top5.toFixed(1)}% of supply`);
  }

  // Herfindahl index — captures concentration shape better than top-N alone
  if (data.herfindahl_index != null && data.herfindahl_index > 2500) {
    score += W.hhi_gt_2500;
    factors.push(`Highly concentrated ownership (HHI: ${data.herfindahl_index})`);
  } else if (data.herfindahl_index != null && data.herfindahl_index > 1500) {
    score += W.hhi_gt_1500;
    factors.push(`Moderately concentrated ownership (HHI: ${data.herfindahl_index})`);
  }

  // Whale distribution
  if (data.whale_distributing) {
    score += W.whale_distributing;
    factors.push('Whale distribution activity detected');
  }

  const finalScore = Math.min(1.0, Math.max(0.0, score));
  return {
    score: Math.round(finalScore * 100) / 100,
    risk_level: getRiskLevel(finalScore),
    factors,
  };
}
