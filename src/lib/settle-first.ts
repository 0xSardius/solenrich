/**
 * Settle-first x402 middleware for slow endpoints.
 *
 * The stock @x402/hono middleware runs verify → handler → settle. A Solana
 * payment transaction carries a recent blockhash that expires after ~60s, so
 * an endpoint whose handler runs longer than that has its settlement refused
 * with `transaction_simulation_failed` — the buyer's signature is valid, the
 * data was computed, and no money moves (seen live on smart-money-flow,
 * 2026-09-17; smart-money-trenches / trenches-scan / trenches-check measured
 * 26–34s, inside the window only when upstreams are fast).
 *
 * This middleware runs verify → input check → settle → handler for a named set
 * of routes. The input check (opts.validate) refuses a malformed request with
 * a 400 before any money moves (added 2026-11-04 after six paid 400s).
 * Trade-off: the buyer is charged before delivery. If the handler then fails,
 * the buyer paid for an error. That case is logged as `[settle-first-loss]`
 * and counted in /metrics so it is never silent. The four endpoints in the
 * set degrade instead of throwing (Promise.allSettled legs), so this is rare.
 *
 * Uses only public methods of @x402/core's x402HTTPResourceServer, shared with
 * the stock middleware so route config, facilitator, and bazaar extension are
 * identical.
 */
import type { Context, MiddlewareHandler, Next } from 'hono';
import { HonoAdapter } from '@x402/hono';
import {
  checkIfBazaarNeeded,
  FacilitatorResponseError,
  SETTLEMENT_OVERRIDES_HEADER,
  type x402HTTPResourceServer,
} from '@x402/core/server';

export interface SettleFirstLoss {
  key: string;
  status: number;
  error?: string;
}

export interface SettleFirstOptions {
  /** Called when the handler fails AFTER the payment settled. */
  onLoss?: (loss: SettleFirstLoss) => void;
  /** Maps a request path to an endpoint key for logs. Default: 3rd path segment. */
  endpointKey?: (path: string) => string;
  /**
   * Checks the request input BEFORE settlement. Returns the validation issues,
   * or null when the input is valid. Without it, a malformed request settles
   * and then fails the handler's own schema check: a paid 400.
   */
  validate?: (key: string, input: unknown) => ValidationIssue[] | null;
}

export interface ValidationIssue {
  path?: PropertyKey[];
  code?: string;
  message?: string;
}

/** Paid-then-failed counter, surfaced in /metrics. Resets daily. */
export const settleFirstStats = {
  today: 0,
  day: new Date().toISOString().slice(0, 10),
  lastKey: null as string | null,
  lastStatus: null as number | null,
  /** ms timestamp of the last loss; /status marks the service degraded for 15 min after one. */
  lastAt: null as number | null,
  /** Settlements completed before the handler ran (today). */
  settledToday: 0,
  /** Requests refused for invalid input before settlement (today). The buyer was not charged. */
  rejectedToday: 0,
  /** Endpoint key and failing field paths of the last refusal. Paths only, never values. */
  lastRejected: null as { key: string; paths: string[] } | null,
};

/** Resets the daily counters at the UTC day change. /metrics calls it too, so a quiet day reads 0, not yesterday. */
export function rollDay(): void {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== settleFirstStats.day) {
    settleFirstStats.day = day;
    settleFirstStats.today = 0;
    settleFirstStats.settledToday = 0;
    settleFirstStats.rejectedToday = 0;
  }
}

/** Same unwrapping as Lucid's http extension: `{ input: {...} }` or a flat body. */
function extractInput(payload: unknown): unknown {
  if (payload && typeof payload === 'object' && 'input' in payload) {
    return (payload as { input?: unknown }).input ?? {};
  }
  return payload ?? {};
}

/**
 * Reads the request body from a clone, as Lucid does. The clone is read to
 * the end: on Bun an abandoned clone branch is never released (see the
 * 2026-08-09 OOM fix). Unparseable JSON becomes undefined, as in Lucid.
 */
async function readInput(req: Request): Promise<unknown> {
  let payload: unknown;
  try {
    const text = await req.clone().text();
    payload = text ? JSON.parse(text) : undefined;
  } catch {
    payload = undefined;
  }
  return extractInput(payload);
}

const issuePath = (i: ValidationIssue): string => (i.path?.length ? i.path.map(String).join('.') : '(root)');

function recordLoss(key: string, status: number): void {
  rollDay();
  settleFirstStats.today++;
  settleFirstStats.lastKey = key;
  settleFirstStats.lastStatus = status;
  settleFirstStats.lastAt = Date.now();
}

const defaultEndpointKey = (path: string): string => path.split('/')[2] ?? path;

/**
 * The minimal surface of x402HTTPResourceServer this middleware uses. Typed
 * structurally so tests can pass a fake.
 */
export type SettleFirstServer = Pick<
  x402HTTPResourceServer,
  'requiresPayment' | 'processHTTPRequest' | 'processSettlement'
> & {
  routes?: x402HTTPResourceServer['routes'];
  server?: { hasExtension(key: string): boolean; registerExtension(ext: unknown): void };
};

/**
 * Mirrors the stock middleware's lazy bazaar registration so a settle-first
 * route can be the first request after boot without losing discovery
 * metadata on its settlement. Idempotent (hasExtension guard).
 */
function bazaarLoader(httpServer: SettleFirstServer): () => Promise<void> {
  let p: Promise<void> | null = null;
  return () => {
    if (p) return p;
    p = (async () => {
      if (!httpServer.routes || !httpServer.server) return;
      if (!checkIfBazaarNeeded(httpServer.routes)) return;
      try {
        const bazaar = await import('@x402/extensions/bazaar');
        if (!httpServer.server.hasExtension('bazaar')) {
          httpServer.server.registerExtension(bazaar.bazaarResourceServerExtension);
        }
        bazaar.validateBazaarRouteExtensions(httpServer.routes);
      } catch (err) {
        console.error('[settle-first] bazaar extension load failed:', err);
      }
    })();
    return p;
  };
}

export function settleFirstMiddleware(
  httpServer: SettleFirstServer,
  opts: SettleFirstOptions = {},
): MiddlewareHandler {
  const keyOf = opts.endpointKey ?? defaultEndpointKey;
  const ensureBazaar = bazaarLoader(httpServer);

  return async (c: Context, next: Next) => {
    const adapter = new HonoAdapter(c);
    const context = {
      adapter,
      path: c.req.path,
      method: c.req.method,
      paymentHeader: adapter.getHeader('payment-signature') || adapter.getHeader('x-payment'),
    };
    if (!httpServer.requiresPayment(context)) return next();
    await ensureBazaar();

    let result: Awaited<ReturnType<x402HTTPResourceServer['processHTTPRequest']>>;
    try {
      result = await httpServer.processHTTPRequest(context);
    } catch (error) {
      if (error instanceof FacilitatorResponseError) return c.json({ error: error.message }, 502);
      throw error;
    }

    if (result.type === 'no-payment-required') return next();

    if (result.type === 'payment-error') {
      const { response } = result;
      for (const [k, v] of Object.entries(response.headers)) c.header(k, v);
      return response.isHtml
        ? c.html(String(response.body ?? ''), response.status as 402)
        : c.json((response.body as Record<string, unknown>) ?? {}, response.status as 402);
    }

    // payment-verified → check the input first. An invalid input never
    // settles: the buyer gets the same 400 the handler would send, unpaid.
    if (opts.validate) {
      const key = keyOf(c.req.path);
      const issues = opts.validate(key, await readInput(c.req.raw));
      if (issues && issues.length > 0) {
        await c.req.raw.text().catch(() => {});
        rollDay();
        settleFirstStats.rejectedToday++;
        const paths = issues.slice(0, 10).map(issuePath);
        settleFirstStats.lastRejected = { key, paths };
        console.warn(`[settle-first-invalid] key=${key} paths=${paths.join(',')} — refused before settlement, buyer not charged`);
        return c.json({ error: { code: 'invalid_input', issues } }, 400);
      }
    }

    // Input valid → settle NOW, before the handler can outlive the blockhash.
    const { paymentPayload, paymentRequirements, declaredExtensions } = result;
    let settle: Awaited<ReturnType<x402HTTPResourceServer['processSettlement']>>;
    try {
      settle = await httpServer.processSettlement(paymentPayload, paymentRequirements, declaredExtensions, {
        request: context,
        responseHeaders: {},
      });
    } catch (error) {
      if (error instanceof FacilitatorResponseError) return c.json({ error: error.message }, 502);
      console.error('[settle-first] settlement threw:', error);
      return c.json({}, 402);
    }

    if (!settle.success) {
      const { response } = settle;
      const body = response.isHtml ? String(response.body ?? '') : JSON.stringify(response.body ?? {});
      c.res = new Response(body, { status: response.status, headers: response.headers });
      return;
    }
    rollDay();
    settleFirstStats.settledToday++;

    const key = keyOf(c.req.path);
    try {
      await next();
    } catch (error) {
      recordLoss(key, 500);
      opts.onLoss?.({ key, status: 500, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    if (c.res.status >= 400) {
      recordLoss(key, c.res.status);
      opts.onLoss?.({ key, status: c.res.status });
    }
    // The buyer gets the settlement receipt header on every outcome — it is
    // their proof of payment whether the body is data or an error.
    for (const [k, v] of Object.entries(settle.headers)) c.res.headers.set(k, v);
    c.res.headers.delete(SETTLEMENT_OVERRIDES_HEADER);
  };
}
