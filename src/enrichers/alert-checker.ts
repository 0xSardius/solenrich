import type { TokenAnalyzer, TokenEnrichment } from './token-analyzer';
import type { WalletProfiler, WalletEnrichment } from './wallet-profiler';
import type { WhaleWatcher } from './whale-watch';
import type { SnapshotStore, TokenSnapshot, WalletSnapshot } from './snapshot-store';
import { parallelFetch } from '../utils/parallel';

// --- Types ---

export type AlertSeverity = 'low' | 'medium' | 'high' | 'critical';

export type AlertType =
  | 'price_spike'
  | 'price_drop'
  | 'risk_increase'
  | 'risk_decrease'
  | 'whale_inflow'
  | 'whale_outflow'
  | 'concentration_shift'
  | 'portfolio_value_change'
  | 'new_positions'
  | 'removed_positions'
  | 'first_observation';

export interface Alert {
  type: AlertType;
  severity: AlertSeverity;
  entity: { kind: 'token' | 'wallet'; address: string };
  summary: string;
  data: Record<string, unknown>;
  detected_at: string;
}

export interface AlertCriteria {
  min_price_change_pct?: number;        // default 10
  min_risk_score_delta?: number;        // default 0.15
  min_whale_volume_usd?: number;        // default 50_000
  min_portfolio_change_pct?: number;    // default 20
  min_concentration_shift_pct?: number; // default 5
}

export interface AlertCheckResult {
  since: string;
  checked_at: string;
  alerts: Alert[];
  watchlist: { tokens: string[]; wallets: string[] };
  counts_by_severity: Record<AlertSeverity, number>;
  counts_by_type: Partial<Record<AlertType, number>>;
}

const DEFAULT_CRITERIA: Required<AlertCriteria> = {
  min_price_change_pct: 10,
  min_risk_score_delta: 0.15,
  min_whale_volume_usd: 50_000,
  min_portfolio_change_pct: 20,
  min_concentration_shift_pct: 5,
};

const MAX_WATCHLIST = 10; // per entity type

// --- Enricher ---

export class AlertChecker {
  constructor(
    private tokenAnalyzer: TokenAnalyzer,
    private walletProfiler: WalletProfiler,
    private whaleWatcher: WhaleWatcher,
    private snapshotStore: SnapshotStore,
  ) {}

  async check(
    tokens: string[],
    wallets: string[],
    since: string,
    criteria: AlertCriteria,
  ): Promise<AlertCheckResult> {
    const cap = { tokens: tokens.slice(0, MAX_WATCHLIST), wallets: wallets.slice(0, MAX_WATCHLIST) };
    const c = { ...DEFAULT_CRITERIA, ...criteria };
    const sinceMs = new Date(since).getTime();
    const lookbackHours = Math.max(1, Math.ceil((Date.now() - sinceMs) / 3_600_000));

    // Fetch current state + snapshots for every entity in parallel
    const tokenTasks = cap.tokens.flatMap((mint) => [
      { name: `tok:${mint}`, fn: () => this.tokenAnalyzer.enrich(mint, false) },
      { name: `tokSnap:${mint}`, fn: () => this.snapshotStore.getTokenSnapshots(mint, 7) },
      {
        name: `whale:${mint}`,
        fn: () => this.whaleWatcher.enrich(mint, c.min_whale_volume_usd, lookbackHours),
      },
    ]);
    const walletTasks = cap.wallets.flatMap((addr) => [
      { name: `wal:${addr}`, fn: () => this.walletProfiler.enrich(addr, 'light') },
      { name: `walSnap:${addr}`, fn: () => this.snapshotStore.getWalletSnapshots(addr, 7) },
    ]);

    const results = await parallelFetch<any>([...tokenTasks, ...walletTasks], 15_000);

    const alerts: Alert[] = [];

    // Token alerts
    for (const mint of cap.tokens) {
      const cur = results[`tok:${mint}`] as TokenEnrichment | null;
      const snaps = (results[`tokSnap:${mint}`] as TokenSnapshot[] | null) ?? [];
      const whale = results[`whale:${mint}`] as any;
      alerts.push(...detectTokenAlerts(mint, cur, snaps, whale, c, sinceMs));
    }

    // Wallet alerts
    for (const addr of cap.wallets) {
      const cur = results[`wal:${addr}`] as WalletEnrichment | null;
      const snaps = (results[`walSnap:${addr}`] as WalletSnapshot[] | null) ?? [];
      alerts.push(...detectWalletAlerts(addr, cur, snaps, c));
    }

    // Sort by severity (critical first), then by entity address for stable output
    const severityOrder: Record<AlertSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    alerts.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]);

    return {
      since,
      checked_at: new Date().toISOString(),
      alerts,
      watchlist: cap,
      counts_by_severity: countBy(alerts, (a) => a.severity) as Record<AlertSeverity, number>,
      counts_by_type: countBy(alerts, (a) => a.type) as Partial<Record<AlertType, number>>,
    };
  }
}

// --- Pure detectors (exported for testing) ---

export function detectTokenAlerts(
  mint: string,
  current: TokenEnrichment | null,
  snapshots: TokenSnapshot[],
  whale: any | null,
  c: Required<AlertCriteria>,
  sinceMs: number,
): Alert[] {
  const alerts: Alert[] = [];
  if (!current) return alerts;

  const ent = { kind: 'token' as const, address: mint };
  const now = new Date().toISOString();

  // First-observation fires when no snapshots existed before the `since` window
  const priorSnap = snapshots.find((s) => new Date(s.date).getTime() <= sinceMs);
  if (!priorSnap && snapshots.length === 0) {
    alerts.push({
      type: 'first_observation',
      severity: 'low',
      entity: ent,
      summary: `First observation of ${shorten(mint)} — no prior snapshots in window.`,
      data: { current_price_usd: current.price_usd, current_risk_flag_count: current.risk_flags.length },
      detected_at: now,
    });
  }

  if (priorSnap) {
    // Price change
    const priceChangePct =
      priorSnap.price_usd > 0
        ? ((current.price_usd - priorSnap.price_usd) / priorSnap.price_usd) * 100
        : 0;
    if (Math.abs(priceChangePct) >= c.min_price_change_pct) {
      const type: AlertType = priceChangePct > 0 ? 'price_spike' : 'price_drop';
      alerts.push({
        type,
        severity: severityFromPct(Math.abs(priceChangePct), [20, 50, 100]),
        entity: ent,
        summary: `${shorten(mint)} ${type === 'price_spike' ? 'up' : 'down'} ${priceChangePct.toFixed(1)}% since ${priorSnap.date} (${formatUsdSmall(priorSnap.price_usd)} → ${formatUsdSmall(current.price_usd)})`,
        data: { prior_price_usd: priorSnap.price_usd, current_price_usd: current.price_usd, pct_change: priceChangePct, since_date: priorSnap.date },
        detected_at: now,
      });
    }

    // Concentration shift
    if (priorSnap.top1_pct !== null && current.concentration?.top1_pct !== undefined && current.concentration.top1_pct !== null) {
      const shift = current.concentration.top1_pct - priorSnap.top1_pct;
      if (Math.abs(shift) >= c.min_concentration_shift_pct) {
        alerts.push({
          type: 'concentration_shift',
          severity: severityFromPct(Math.abs(shift), [5, 10, 20]),
          entity: ent,
          summary: `${shorten(mint)} top-holder concentration ${shift > 0 ? 'rose' : 'fell'} ${Math.abs(shift).toFixed(1)} pts (${priorSnap.top1_pct.toFixed(1)}% → ${current.concentration.top1_pct.toFixed(1)}%)`,
          data: { prior_top1_pct: priorSnap.top1_pct, current_top1_pct: current.concentration.top1_pct, since_date: priorSnap.date },
          detected_at: now,
        });
      }
    }
  }

  // Whale flow — derived live from whale-watch over the lookback window
  if (whale && typeof whale.total_volume_usd === 'number' && whale.total_volume_usd >= c.min_whale_volume_usd) {
    const inflow = whale.net_flow === 'accumulating';
    const outflow = whale.net_flow === 'distributing';
    if (inflow || outflow) {
      alerts.push({
        type: inflow ? 'whale_inflow' : 'whale_outflow',
        severity: severityFromUsd(whale.total_volume_usd, [c.min_whale_volume_usd, c.min_whale_volume_usd * 5, c.min_whale_volume_usd * 20]),
        entity: ent,
        summary: `${shorten(mint)} whales ${inflow ? 'accumulating' : 'distributing'} — $${formatNum(whale.total_volume_usd)} net volume across ${whale.whale_count ?? 0} wallets`,
        data: { net_flow: whale.net_flow, total_volume_usd: whale.total_volume_usd, whale_count: whale.whale_count },
        detected_at: now,
      });
    }
  }

  return alerts;
}

export function detectWalletAlerts(
  address: string,
  current: WalletEnrichment | null,
  snapshots: WalletSnapshot[],
  c: Required<AlertCriteria>,
): Alert[] {
  const alerts: Alert[] = [];
  if (!current) return alerts;

  const ent = { kind: 'wallet' as const, address };
  const now = new Date().toISOString();
  const priorSnap = snapshots[0]; // oldest in window

  if (!priorSnap) {
    alerts.push({
      type: 'first_observation',
      severity: 'low',
      entity: ent,
      summary: `First observation of ${shorten(address)} — no prior snapshots.`,
      data: { current_value_usd: current.portfolio_value_usd, current_risk_score: current.risk_score },
      detected_at: now,
    });
    return alerts;
  }

  // Portfolio value change
  const valChangePct =
    priorSnap.portfolio_value_usd > 0
      ? ((current.portfolio_value_usd - priorSnap.portfolio_value_usd) / priorSnap.portfolio_value_usd) * 100
      : 0;
  if (Math.abs(valChangePct) >= c.min_portfolio_change_pct) {
    alerts.push({
      type: 'portfolio_value_change',
      severity: severityFromPct(Math.abs(valChangePct), [20, 50, 100]),
      entity: ent,
      summary: `${shorten(address)} portfolio ${valChangePct > 0 ? 'up' : 'down'} ${valChangePct.toFixed(1)}% (${formatUsdSmall(priorSnap.portfolio_value_usd)} → ${formatUsdSmall(current.portfolio_value_usd)})`,
      data: { prior_value_usd: priorSnap.portfolio_value_usd, current_value_usd: current.portfolio_value_usd, pct_change: valChangePct, since_date: priorSnap.date },
      detected_at: now,
    });
  }

  // Risk score change
  const riskDelta = current.risk_score - priorSnap.risk_score;
  if (Math.abs(riskDelta) >= c.min_risk_score_delta) {
    alerts.push({
      type: riskDelta > 0 ? 'risk_increase' : 'risk_decrease',
      severity: riskDelta > 0 ? severityFromPct(Math.abs(riskDelta) * 100, [15, 30, 50]) : 'low',
      entity: ent,
      summary: `${shorten(address)} risk ${riskDelta > 0 ? 'rose' : 'fell'} ${Math.abs(riskDelta).toFixed(2)} (${priorSnap.risk_score.toFixed(2)} → ${current.risk_score.toFixed(2)})`,
      data: { prior_risk_score: priorSnap.risk_score, current_risk_score: current.risk_score, delta: riskDelta, since_date: priorSnap.date },
      detected_at: now,
    });
  }

  // Position changes
  const currentMints = new Set(current.top_holdings.slice(0, 5).map((h) => h.mint));
  const priorMints = new Set(priorSnap.top_holding_mints);
  const added = [...currentMints].filter((m) => !priorMints.has(m));
  const removed = [...priorMints].filter((m) => !currentMints.has(m));

  if (added.length > 0) {
    alerts.push({
      type: 'new_positions',
      severity: 'medium',
      entity: ent,
      summary: `${shorten(address)} added ${added.length} new top-5 holding(s) since ${priorSnap.date}`,
      data: { added, since_date: priorSnap.date },
      detected_at: now,
    });
  }
  if (removed.length > 0) {
    alerts.push({
      type: 'removed_positions',
      severity: 'medium',
      entity: ent,
      summary: `${shorten(address)} removed ${removed.length} top-5 holding(s) since ${priorSnap.date}`,
      data: { removed, since_date: priorSnap.date },
      detected_at: now,
    });
  }

  return alerts;
}

// --- Helpers ---

function severityFromPct(absPct: number, thresholds: [number, number, number]): AlertSeverity {
  if (absPct >= thresholds[2]) return 'critical';
  if (absPct >= thresholds[1]) return 'high';
  if (absPct >= thresholds[0]) return 'medium';
  return 'low';
}

function severityFromUsd(absUsd: number, thresholds: [number, number, number]): AlertSeverity {
  if (absUsd >= thresholds[2]) return 'critical';
  if (absUsd >= thresholds[1]) return 'high';
  if (absUsd >= thresholds[0]) return 'medium';
  return 'low';
}

function shorten(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 4)}...${addr.slice(-3)}` : addr;
}

function formatUsdSmall(v: number): string {
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.001) return `$${v.toFixed(4)}`;
  return `$${v.toExponential(2)}`;
}

function formatNum(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return v.toFixed(0);
}

function countBy<T, K extends string>(items: T[], key: (t: T) => K): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}
