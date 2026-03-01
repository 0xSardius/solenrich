/** "7xK9...nFp" */
export function shortenAddress(addr: string): string {
  if (addr.length <= 8) return addr;
  return `${addr.slice(0, 4)}...${addr.slice(-3)}`;
}

/** Locale-formatted USD with $ prefix */
export function formatUsd(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Humanize with K/M/B suffixes */
export function formatNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return value.toFixed(2);
}

/** Format as percentage string */
export function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

/** Current ISO 8601 UTC timestamp */
export function formatTimestamp(): string {
  return new Date().toISOString();
}

/** Convert lamports to SOL */
export function lamportsToSol(lamports: number): number {
  return lamports / 1e9;
}

/** Convert raw token amount to decimal using token's decimals */
export function tokenAmountToDecimal(raw: number | bigint, decimals: number): number {
  return Number(raw) / 10 ** decimals;
}
