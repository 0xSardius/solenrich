// Unit tests for the wallet-link verdict (src/enrichers/wallet-link.ts, scoreWalletLink).
// Fixture shapes come from live runs on our own wallets (local/scripts/wallet-link-fixtures.ts, 2026-09-30).
import { describe, test, expect } from 'bun:test';
import { scoreWalletLink, type LinkEvidence } from '../src/enrichers/wallet-link';

function ev(over: {
  direct?: Partial<LinkEvidence['direct_link']>;
  funding?: Partial<LinkEvidence['funding']>;
  b?: Partial<LinkEvidence['b_profile']>;
  x402?: Partial<LinkEvidence['x402']>;
} = {}): LinkEvidence {
  return {
    direct_link: { shared_txs: 0, a_to_b: 0, b_to_a: 0, first_at: null, last_at: null, complete: true, ...over.direct },
    funding: {
      a_funder: null, b_funder: null, b_funded_by_a: false, shared_funder: null,
      b_funder_funder: null, funding_tree_link: null, b_funder_entity: null, ...over.funding,
    },
    b_profile: { first_seen: '2026-01-01T00:00:00.000Z', age_days: 200, tx_count: 500, history_complete: true, entity: null, ...over.b },
    x402: { usdc_inflows_sampled: 0, facilitator_style_inflows: 0, distinct_payers: 0, known_facilitator: false, ...over.x402 },
  };
}

describe('scoreWalletLink', () => {
  test('a direct transfer and B funded by A → LIKELY_SAME_OWNER (agent → Moneta shape)', () => {
    const s = scoreWalletLink(ev({ direct: { shared_txs: 2, a_to_b: 1 }, funding: { b_funded_by_a: true }, b: { age_days: 4 } }));
    expect(s.verdict).toBe('LIKELY_SAME_OWNER');
    expect(s.confidence).toBe(1);
  });

  test('a funding-tree link alone stays UNCERTAIN (SolScout → Moneta shape)', () => {
    const s = scoreWalletLink(ev({ funding: { funding_tree_link: 'xByP6T1R' }, b: { age_days: 4 } }));
    expect(s.verdict).toBe('UNCERTAIN');
    expect(s.confidence).toBe(0.5);
    expect(s.risk_flags).toContain('new_wallet');
    expect(s.risk_flags).not.toContain('no_link_found');
  });

  test('a new wallet with no link → SUSPICIOUS', () => {
    const s = scoreWalletLink(ev({ b: { age_days: 1 } }));
    expect(s.verdict).toBe('SUSPICIOUS');
    expect(s.risk_flags).toEqual(expect.arrayContaining(['new_wallet', 'no_link_found']));
  });

  test('a wallet with no transactions → SUSPICIOUS with no_history', () => {
    const s = scoreWalletLink(ev({ b: { tx_count: 0, age_days: null, first_seen: null } }));
    expect(s.verdict).toBe('SUSPICIOUS');
    expect(s.risk_flags).toEqual(expect.arrayContaining(['no_history', 'new_wallet', 'thin_history']));
  });

  test('an old wallet with no link → UNCERTAIN, never LIKELY', () => {
    const s = scoreWalletLink(ev());
    expect(s.verdict).toBe('UNCERTAIN');
  });

  test('a known exchange address as B is never LIKELY_SAME_OWNER, even when linked', () => {
    const s = scoreWalletLink(ev({ direct: { shared_txs: 3, a_to_b: 3 }, funding: { b_funded_by_a: true }, b: { entity: 'cex' } }));
    expect(s.verdict).toBe('UNCERTAIN');
    expect(s.risk_flags).toContain('b_is_known_entity');
  });

  test('x402 inflows clear thin_history for a payout owner address', () => {
    const s = scoreWalletLink(ev({ b: { tx_count: 8 }, x402: { facilitator_style_inflows: 10, distinct_payers: 2 } }));
    expect(s.risk_flags).not.toContain('thin_history');
  });

  test('an incomplete link check says so in the evidence', () => {
    const s = scoreWalletLink(ev({ direct: { complete: false } }));
    expect(s.evidence.join(' ')).toContain('may be missed');
  });
});
