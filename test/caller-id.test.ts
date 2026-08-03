// Unit tests for caller identity extraction (src/lib/caller-id.ts).
// Covers both live x402 payload shapes (Solana exact-svm, Base exact-evm),
// MPP hashing, IP fallback, and graceful degradation on junk.
import { describe, test, expect } from 'bun:test';
import {
  Keypair,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { extractCaller } from '../src/lib/caller-id';

const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64');

// Mirror the CDP facilitator's tx shape: facilitator fee-pays at signer index 0,
// the payer wallet is the second required signer.
function solanaPaymentHeader(feePayer: Keypair, payer: Keypair): string {
  const message = new TransactionMessage({
    payerKey: feePayer.publicKey,
    recentBlockhash: Keypair.generate().publicKey.toBase58(), // any 32-byte base58
    instructions: [
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: feePayer.publicKey,
        lamports: 1,
      }),
    ],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  return b64({
    x402Version: 1,
    scheme: 'exact',
    network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    payload: { transaction: Buffer.from(tx.serialize()).toString('base64') },
  });
}

describe('extractCaller', () => {
  test('Solana exact-svm: payer is the non-fee-payer signer', () => {
    const feePayer = Keypair.generate();
    const payer = Keypair.generate();
    const caller = extractCaller(solanaPaymentHeader(feePayer, payer), undefined, '1.2.3.4');
    expect(caller).toBe(`x402:${payer.publicKey.toBase58()}`);
  });

  test('Base exact-evm: payer is the EIP-3009 authorization.from', () => {
    const header = b64({
      x402Version: 1,
      scheme: 'exact',
      network: 'eip155:8453',
      payload: {
        signature: '0x' + 'ab'.repeat(65),
        authorization: {
          from: '0xAbCd000000000000000000000000000000001234',
          to: '0x8EdE9eD2E6ACdd9B2BaFa42ff4078d3F3263607c',
          value: '20000',
          validAfter: '0',
          validBefore: '9999999999',
          nonce: '0x' + '00'.repeat(32),
        },
      },
    });
    const caller = extractCaller(header, undefined, '1.2.3.4');
    expect(caller).toBe('x402:0xabcd000000000000000000000000000000001234'); // lowercased
  });

  test('unrecognized x402 payload shape → x402:unknown (never throws)', () => {
    const header = b64({ x402Version: 1, scheme: 'mystery', payload: { blob: 'xyz' } });
    expect(extractCaller(header, undefined, '1.2.3.4')).toBe('x402:unknown');
  });

  test('garbage x402 header → x402:unknown (never throws)', () => {
    expect(extractCaller('!!!not-base64!!!', undefined, '1.2.3.4')).toBe('x402:unknown');
    expect(extractCaller(Buffer.from('not json').toString('base64'), undefined, undefined)).toBe('x402:unknown');
  });

  test('MPP Authorization header → stable hash with mpp: prefix', () => {
    const a = extractCaller(undefined, 'Payment abc123', '1.2.3.4');
    const b = extractCaller(undefined, 'Payment abc123', '5.6.7.8');
    expect(a).toStartWith('mpp:');
    expect(a).toBe(b!); // same credential → same id, regardless of IP
  });

  test('no payment headers → IP fallback (first hop of x-forwarded-for)', () => {
    expect(extractCaller(undefined, undefined, '9.9.9.9, 10.0.0.1')).toBe('ip:9.9.9.9');
  });

  test('nothing at all → null', () => {
    expect(extractCaller(undefined, undefined, undefined)).toBeNull();
  });

  test('non-Payment Authorization (e.g. Bearer) does not count as MPP', () => {
    expect(extractCaller(undefined, 'Bearer tok', '2.2.2.2')).toBe('ip:2.2.2.2');
  });
});
