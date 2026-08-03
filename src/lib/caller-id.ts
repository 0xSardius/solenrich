/**
 * Best-effort caller identity for distinct-caller metrics.
 *
 * Pure function, read-only on headers — payment verification happens elsewhere;
 * a bug here can only degrade attribution, never a response. Extraction order:
 *  1. x402 Solana (exact-svm): payer wallet co-signs the payment transaction.
 *     The CDP facilitator fee-pays at signer index 0, so the payer is the other
 *     required signer.
 *  2. x402 Base/EVM (exact-evm): the EIP-3009 authorization's `from` field IS
 *     the payer address. Added 2026-08-02 — Base accepts went live 2026-07-09
 *     but extraction only knew the Solana shape, so Base payers logged as
 *     `x402:unknown`.
 *  3. MPP: credentials rotate per request, so the hash is an upper-bound proxy.
 *  4. Unpaid (dev / payments disabled): falls back to client IP.
 */

import { VersionedTransaction } from '@solana/web3.js';
import { createHash } from 'node:crypto';

// Log each unrecognized x402 payload shape once (keys only, never values) so
// prod tells us what to parse next instead of silently counting `x402:unknown`.
const seenUnknownShapes = new Set<string>();

function describeShape(decoded: any): string {
  const top = Object.keys(decoded ?? {}).sort().join(',');
  const payload = Object.keys(decoded?.payload ?? {}).sort().join(',');
  return `scheme=${decoded?.scheme ?? '?'} network=${decoded?.network ?? '?'} keys=[${top}] payload=[${payload}]`;
}

export function extractCaller(
  xPayment: string | undefined,
  auth: string | undefined,
  forwardedFor: string | undefined,
): string | null {
  if (xPayment) {
    try {
      const decoded = JSON.parse(Buffer.from(xPayment, 'base64').toString('utf8'));

      // Solana (exact-svm): payload.transaction is a base64 VersionedTransaction
      const txB64 = decoded?.payload?.transaction;
      if (typeof txB64 === 'string') {
        const tx = VersionedTransaction.deserialize(Buffer.from(txB64, 'base64'));
        const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
        const payer = signers.length > 1 ? signers[1] : signers[0];
        if (payer) return `x402:${payer.toBase58()}`;
      }

      // Base/EVM (exact-evm): payload.authorization.from is the EIP-3009 payer
      const evmFrom = decoded?.payload?.authorization?.from;
      if (typeof evmFrom === 'string' && /^0x[0-9a-fA-F]{40}$/.test(evmFrom)) {
        return `x402:${evmFrom.toLowerCase()}`;
      }

      const shape = describeShape(decoded);
      if (!seenUnknownShapes.has(shape)) {
        seenUnknownShapes.add(shape);
        console.warn(`[caller-id] unrecognized x402 payload shape: ${shape}`);
      }
    } catch { /* unparseable payment header — still count the rail */ }
    return 'x402:unknown';
  }
  if (auth?.startsWith('Payment ')) {
    return 'mpp:' + createHash('sha256').update(auth).digest('hex').slice(0, 12);
  }
  const ip = forwardedFor?.split(',')[0]?.trim();
  return ip ? `ip:${ip}` : null;
}
