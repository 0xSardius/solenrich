// Fail-closed paywall (2026-10-31). Since 2026-04-19 the x402 middleware is the
// only thing that returns a 402 to an unpaid request (1e05bbc made facilitator
// init non-fatal; a87d543 gated MPP behind its credential). If the x402
// middleware is not installed (PAYMENTS_ENABLED missing, empty pay-to wallet,
// CDP init failure), Lucid's invoke handlers serve paid data free. In
// production that state now returns 503 on every non-free entrypoint instead.
import type { MiddlewareHandler } from 'hono';

/** True on Railway, or when REQUIRE_PAYMENTS=true. Local dev keeps the free fallback. */
export function paymentsRequired(env: Record<string, string | undefined>): boolean {
  if (env.REQUIRE_PAYMENTS?.toLowerCase() === 'true') return true;
  if (env.REQUIRE_PAYMENTS?.toLowerCase() === 'false') return false;
  return !!(env.RAILWAY_ENVIRONMENT_ID || env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT);
}

/**
 * x402 steps aside for an MPP credential only when MPP is installed. Without
 * this, any `Authorization: Payment …` header skipped x402 and, with MPP off,
 * nothing charged.
 */
export function skipX402ForMpp(authorization: string | undefined, mppActive: boolean): boolean {
  return mppActive && !!authorization?.startsWith('Payment ');
}

/**
 * 503 on every `/entrypoints/{key}/invoke` and `/stream` route except the free
 * keys. Blocks by default: a key that is not on the free list never runs. The
 * `/entrypoints` list stays open. Register before the entrypoints are added so
 * it runs ahead of Lucid's handlers.
 */
export function paywallClosedMiddleware(freeKeys: readonly string[]): MiddlewareHandler {
  const free = new Set(freeKeys);
  return async (c, next) => {
    const [, , key = '', action = ''] = c.req.path.split('/');
    if (!key || free.has(key) || (action !== 'invoke' && action !== 'stream')) return next();
    return c.json(
      {
        error: 'payments_unavailable',
        message: 'Payments cannot be verified right now, so paid endpoints are closed. Retry shortly; see /status.',
        status: '/status',
      },
      503,
      { 'Retry-After': '60' },
    );
  };
}
