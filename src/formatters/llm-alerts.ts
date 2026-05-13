import type { Alert, AlertCheckResult, AlertSeverity } from '../enrichers/alert-checker';

const SEVERITY_ICONS: Record<AlertSeverity, string> = {
  critical: '⛔',
  high: '⚠',
  medium: '•',
  low: '·',
};

const SEVERITY_ORDER: AlertSeverity[] = ['critical', 'high', 'medium', 'low'];

export function formatAlertsBriefing(data: AlertCheckResult): string {
  const lines: string[] = [];
  const watchSize = data.watchlist.tokens.length + data.watchlist.wallets.length;

  lines.push(`## Alert Check`);
  lines.push('');
  lines.push(
    `Window: ${data.since} → ${data.checked_at}. ` +
      `Watchlist: ${data.watchlist.tokens.length} token(s), ${data.watchlist.wallets.length} wallet(s).`,
  );

  if (data.alerts.length === 0) {
    lines.push('');
    lines.push('_No alerts fired. Watchlist quiet within the criteria provided._');
    return lines.join('\n');
  }

  // Severity summary line
  const sevLine = SEVERITY_ORDER.filter((s) => (data.counts_by_severity[s] ?? 0) > 0)
    .map((s) => `${SEVERITY_ICONS[s]} ${data.counts_by_severity[s]} ${s}`)
    .join(' · ');
  lines.push('');
  lines.push(`**${data.alerts.length} alert(s) across ${watchSize} watched entities** — ${sevLine}`);

  // Group by severity
  for (const sev of SEVERITY_ORDER) {
    const bucket = data.alerts.filter((a) => a.severity === sev);
    if (bucket.length === 0) continue;
    lines.push('');
    lines.push(`### ${SEVERITY_ICONS[sev]} ${sev.toUpperCase()} (${bucket.length})`);
    for (const alert of bucket) {
      lines.push(`- **[${alert.type}]** ${alert.summary}`);
    }
  }

  return lines.join('\n');
}
