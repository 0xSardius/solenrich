/**
 * WalletLinkChecker — are two Solana wallets controlled by the same owner?
 *
 * Built for x402 trust monitors (Lumière PayCheck, 2026-09-30): a seller's payout wallet changes from A to B,
 * and the monitor must decide between a normal rotation and a hijack. The question is general, so the verdict
 * also serves sybil checks and copy-trade vetting.
 *
 * Data plan (standard RPC only; the Helius Wallet API is 100 credits a call and funded-by is plan-gated):
 *  - B's signature list, paged to its first transaction (capped). B is usually new, so this is short.
 *  - A's signature list, paged the same way. A transaction in BOTH lists touched both wallets — that is the
 *    direct-link test, without reading every transaction. The test is complete once A's list reaches back to
 *    B's first transaction (a transfer between them cannot be older than B).
 *  - The first few transactions of a wallet → its first funder (the account that sent it its first SOL).
 *  - B's USDC account: recent inflows where another wallet paid the fee = x402-style payments.
 * Scoring is a pure function (scoreWalletLink) so the thresholds are unit-tested.
 */
import { PublicKey } from '@solana/web3.js';
import type { ParsedTransactionWithMeta } from '@solana/web3.js';
import type { SolanaRpcClient } from '../sources/solana-rpc';
import type { HeliusClient } from '../sources/helius';
import type { Cache } from '../cache';
import { lookupEntity } from '../utils/entities';

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
/** Known x402 facilitator fee payers on Solana (CDP, measured 2026-09-30 on our own inflows). */
export const KNOWN_FACILITATOR_FEE_PAYERS = new Set(['BFK9TLC3edb13K6v4YyH3DwPb5DSUpkWvb7XnqCL9b4F']);

const PAGE = 1000;
const B_MAX_PAGES = 5;
const A_MAX_PAGES = 5;
const FUNDER_TX_SCAN = 5;
const FUNDER_OF_FUNDER_PAGES = 3;
const X402_SAMPLE = 10;
const NEW_WALLET_DAYS = 7;
const THIN_HISTORY_TXS = 20;
const CACHE_TTL = 3600;

export type LinkVerdict = 'LIKELY_SAME_OWNER' | 'UNCERTAIN' | 'SUSPICIOUS';

export interface LinkEvidence {
  direct_link: { shared_txs: number; a_to_b: number; b_to_a: number; first_at: string | null; last_at: string | null; complete: boolean };
  funding: {
    a_funder: string | null;
    b_funder: string | null;
    b_funded_by_a: boolean;
    /** Same first funder, and that funder is not an exchange, bridge or protocol. */
    shared_funder: string | null;
    /** Who funded B's funder (only looked up when B's funder is not A, not shared, and not an exchange). */
    b_funder_funder: string | null;
    /** Set when B's funder was itself funded by A or by A's funder — the same funding tree, one step back. */
    funding_tree_link: string | null;
    b_funder_entity: string | null;
  };
  b_profile: {
    first_seen: string | null;
    age_days: number | null;
    tx_count: number;
    history_complete: boolean;
    entity: string | null;
  };
  x402: { usdc_inflows_sampled: number; facilitator_style_inflows: number; distinct_payers: number; known_facilitator: boolean };
}

export interface WalletLinkResult extends LinkEvidence {
  wallet_a: string;
  wallet_b: string;
  context: 'payout_rotation' | 'general';
  verdict: LinkVerdict | 'LIKELY_ROTATION';
  same_owner_confidence: number;
  risk_flags: string[];
  evidence: string[];
  coverage: { a_pages: number; b_pages: number; a_reached_b_start: boolean };
  checked_at: string;
}

/**
 * Pure: the verdict. Strong links (a transfer between the wallets, B funded by A) raise confidence; a new,
 * unlinked B lowers it. Thin evidence stays UNCERTAIN — a false "same owner" on a hijack is the costly error.
 */
export function scoreWalletLink(e: LinkEvidence): { verdict: LinkVerdict; confidence: number; risk_flags: string[]; evidence: string[] } {
  const flags: string[] = [];
  const why: string[] = [];
  let score = 0.3;

  if (e.direct_link.shared_txs > 0) {
    score += 0.4;
    why.push(`A and B appear together in ${e.direct_link.shared_txs} transaction(s) (A→B ${e.direct_link.a_to_b}, B→A ${e.direct_link.b_to_a})`);
  }
  if (e.funding.b_funded_by_a) {
    score += 0.35;
    why.push('B received its first SOL from A');
  } else if (e.funding.shared_funder) {
    score += 0.2;
    why.push(`A and B were first funded by the same wallet (${e.funding.shared_funder.slice(0, 6)}…)`);
  } else if (e.funding.funding_tree_link) {
    score += 0.2;
    why.push(`B's funder was itself funded by ${e.funding.funding_tree_link === e.funding.a_funder ? "A's funder" : 'A'} (${e.funding.funding_tree_link.slice(0, 6)}…)`);
  }
  if (e.x402.distinct_payers >= 3) {
    score += 0.05;
    why.push(`B has received x402-style payments from ${e.x402.distinct_payers} payers`);
  }

  const linked = e.direct_link.shared_txs > 0 || e.funding.b_funded_by_a || e.funding.shared_funder != null || e.funding.funding_tree_link != null;
  const noHistory = e.b_profile.tx_count === 0;
  const isNew = noHistory || (e.b_profile.age_days != null && e.b_profile.age_days < NEW_WALLET_DAYS);
  if (noHistory) {
    flags.push('no_history');
    why.push('B has no transactions on-chain');
  }
  if (isNew) flags.push('new_wallet');
  // A payout wallet's owner address can have few transactions: its payments land in its USDC account.
  if (e.b_profile.tx_count < THIN_HISTORY_TXS && e.x402.facilitator_style_inflows === 0) flags.push('thin_history');
  if (!linked) flags.push('no_link_found');
  if (e.b_profile.entity) {
    flags.push('b_is_known_entity');
    why.push(`B is a known ${e.b_profile.entity} address; ownership cannot be proven from the chain`);
  }
  if (e.funding.b_funder_entity) why.push(`B was first funded from ${e.funding.b_funder_entity}`);
  if (!e.direct_link.complete) why.push("A's history was not read back to B's first transaction; a direct link may be missed");

  if (!linked && isNew) score -= 0.25;
  if (!linked) why.push('No transfer between A and B and no shared funder found');
  if (e.b_profile.first_seen) why.push(`B first seen ${e.b_profile.first_seen.slice(0, 10)} (${e.b_profile.tx_count}${e.b_profile.history_complete ? '' : '+'} transactions)`);

  const confidence = Math.round(Math.max(0, Math.min(1, score)) * 100) / 100;
  let verdict: LinkVerdict = 'UNCERTAIN';
  if (confidence >= 0.7 && linked && !e.b_profile.entity) verdict = 'LIKELY_SAME_OWNER';
  else if (!linked && isNew) verdict = 'SUSPICIOUS';
  return { verdict, confidence, risk_flags: flags, evidence: why };
}

type Sig = { signature: string; blockTime: number | null };

export class WalletLinkChecker {
  constructor(
    private helius: HeliusClient,
    private rpc: SolanaRpcClient,
    private cache: Cache,
  ) {}

  async check(walletA: string, walletB: string, context: 'payout_rotation' | 'general' = 'general'): Promise<WalletLinkResult> {
    const [a, b] = await this.resolveOwners([walletA, walletB]);
    const cacheKey = `walletlink:${a}:${b}:${context}`;
    const cached = await this.cache.get<WalletLinkResult>(cacheKey);
    if (cached) return cached;

    // Both lists are paged to the wallet's start (capped). A seller's payout OWNER address has a short history:
    // x402 payments land in its USDC account, not on the owner address.
    const bSigs = await this.pageSignatures(b, B_MAX_PAGES);
    const bFirst = bSigs.sigs.at(-1)?.blockTime ?? null;
    const aSigs = await this.pageSignatures(a, A_MAX_PAGES);
    const aOldest = aSigs.sigs.at(-1)?.blockTime ?? null;
    const aCoversB = aSigs.complete || bFirst == null || (aOldest != null && aOldest <= bFirst);

    const bSet = new Set(bSigs.sigs.map((s) => s.signature));
    const shared = aSigs.sigs.filter((s) => bSet.has(s.signature));
    const direction = await this.linkDirection(shared.slice(0, 10), a, b);

    const bFunder = bSigs.complete ? await this.firstFunder(b, bSigs.sigs) : null;
    const aFunder = aSigs.complete ? await this.firstFunder(a, aSigs.sigs) : null;
    const neutral = (addr: string | null) => addr != null && !lookupEntity(addr);
    const sharedFunder = aFunder && bFunder && aFunder === bFunder && neutral(aFunder) ? aFunder : null;
    // One step further back: owners often fund a new wallet from an intermediate wallet of their own.
    let bFunderFunder: string | null = null;
    if (bFunder && bFunder !== a && !sharedFunder && neutral(bFunder)) {
      const fSigs = await this.pageSignatures(bFunder, FUNDER_OF_FUNDER_PAGES);
      bFunderFunder = fSigs.complete ? await this.firstFunder(bFunder, fSigs.sigs) : null;
    }
    const fundingTree = bFunderFunder != null && neutral(bFunderFunder) && (bFunderFunder === a || bFunderFunder === aFunder)
      ? bFunderFunder
      : null;
    const x402 = await this.x402Inflows(b);

    const now = Date.now() / 1000;
    const evidence: LinkEvidence = {
      direct_link: {
        shared_txs: shared.length,
        a_to_b: direction.aToB,
        b_to_a: direction.bToA,
        first_at: shared.length ? iso(shared.at(-1)!.blockTime) : null,
        last_at: shared.length ? iso(shared[0].blockTime) : null,
        complete: aCoversB,
      },
      funding: {
        a_funder: aFunder,
        b_funder: bFunder,
        b_funded_by_a: bFunder === a,
        shared_funder: sharedFunder,
        b_funder_funder: bFunderFunder,
        funding_tree_link: fundingTree,
        b_funder_entity: bFunder ? lookupEntity(bFunder)?.label ?? null : null,
      },
      b_profile: {
        first_seen: iso(bFirst),
        age_days: bFirst ? Math.round(((now - bFirst) / 86400) * 10) / 10 : null,
        tx_count: bSigs.sigs.length,
        history_complete: bSigs.complete,
        entity: lookupEntity(b)?.type ?? null,
      },
      x402,
    };
    const s = scoreWalletLink(evidence);
    const result: WalletLinkResult = {
      wallet_a: a,
      wallet_b: b,
      context,
      ...evidence,
      verdict: context === 'payout_rotation' && s.verdict === 'LIKELY_SAME_OWNER' ? 'LIKELY_ROTATION' : s.verdict,
      same_owner_confidence: s.confidence,
      risk_flags: s.risk_flags,
      evidence: s.evidence,
      coverage: { a_pages: aSigs.pages, b_pages: bSigs.pages, a_reached_b_start: aCoversB },
      checked_at: new Date().toISOString(),
    };
    await this.cache.set(cacheKey, result, CACHE_TTL);
    return result;
  }

  /** A token account (e.g. a USDC ATA) is replaced by its owner wallet; anything else passes through. */
  private async resolveOwners(addresses: string[]): Promise<string[]> {
    const owners = await this.rpc.resolveTokenAccountOwners(addresses).catch(() => []);
    return addresses.map((addr) => owners.find((o) => o.tokenAccount === addr)?.owner ?? addr);
  }

  /** Newest first. Stops at the cap or at the wallet's first transaction (`complete`). */
  private async pageSignatures(address: string, maxPages: number) {
    const sigs: Sig[] = [];
    let before: string | undefined;
    let pages = 0;
    let complete = false;
    while (pages < maxPages) {
      const page = await this.helius.getSignaturesForAddress(address, PAGE, before);
      pages++;
      for (const s of page) sigs.push({ signature: s.signature, blockTime: s.blockTime });
      if (page.length < PAGE) { complete = true; break; }
      before = page[page.length - 1].signature;
    }
    return { sigs, pages, complete };
  }

  /**
   * The first wallet that sent this one SOL or USDC: in the oldest transactions, the account whose SOL fell most
   * when this wallet's SOL rose, or the USDC sender when its USDC rose first.
   */
  private async firstFunder(address: string, newestFirst: Sig[]): Promise<string | null> {
    const oldest = newestFirst.slice(-FUNDER_TX_SCAN).reverse();
    for (const s of oldest) {
      const tx = await this.rpc.getTransaction(s.signature).catch(() => null);
      const funder = tx ? solSource(tx, address) ?? usdcInflow(tx, address)?.sender ?? null : null;
      if (funder) return funder;
    }
    return null;
  }

  private async linkDirection(shared: Sig[], a: string, b: string) {
    let aToB = 0;
    let bToA = 0;
    for (const s of shared) {
      const tx = await this.rpc.getTransaction(s.signature).catch(() => null);
      if (!tx?.meta) continue;
      const d = solDelta(tx, a);
      const e = solDelta(tx, b);
      if (d < 0 && e > 0) aToB++;
      else if (e < 0 && d > 0) bToA++;
    }
    return { aToB, bToA };
  }

  /**
   * Recent USDC inflows to B's USDC accounts where another wallet paid the fee (the x402 shape).
   * The accounts are listed, not derived: a seller's pay-to account need not be the standard derived address
   * (ours is not — measured 2026-09-30).
   */
  private async x402Inflows(owner: string): Promise<LinkEvidence['x402']> {
    const empty = { usdc_inflows_sampled: 0, facilitator_style_inflows: 0, distinct_payers: 0, known_facilitator: false };
    let accounts: string[];
    try {
      const res = await this.rpc.getConnection().getTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(USDC_MINT) });
      accounts = res.value.map((v) => v.pubkey.toBase58()).slice(0, 2);
    } catch { return empty; }
    if (!accounts.length) return empty;
    const sigs = (await Promise.all(accounts.map((a) => this.helius.getSignaturesForAddress(a, X402_SAMPLE).catch(() => []))))
      .flat()
      .sort((x, y) => (y.blockTime ?? 0) - (x.blockTime ?? 0))
      .slice(0, X402_SAMPLE);
    const payers = new Set<string>();
    let inflows = 0;
    let facilitatorStyle = 0;
    let known = false;
    for (const s of sigs) {
      const tx = await this.rpc.getTransaction(s.signature).catch(() => null);
      const pay = tx ? usdcInflow(tx, owner) : null;
      if (!pay) continue;
      inflows++;
      if (pay.feePayer !== pay.sender && pay.feePayer !== owner) {
        facilitatorStyle++;
        payers.add(pay.sender);
        if (KNOWN_FACILITATOR_FEE_PAYERS.has(pay.feePayer)) known = true;
      }
    }
    return { usdc_inflows_sampled: inflows, facilitator_style_inflows: facilitatorStyle, distinct_payers: payers.size, known_facilitator: known };
  }
}

function iso(t: number | null | undefined): string | null {
  return t ? new Date(t * 1000).toISOString() : null;
}

function keys(tx: ParsedTransactionWithMeta): string[] {
  return tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58());
}

/** Lamport change for one account in a transaction (0 if absent). */
export function solDelta(tx: ParsedTransactionWithMeta, address: string): number {
  const i = keys(tx).indexOf(address);
  if (i < 0 || !tx.meta) return 0;
  return (tx.meta.postBalances[i] ?? 0) - (tx.meta.preBalances[i] ?? 0);
}

/** If `address` gained SOL here, the account that lost the most (excluding `address`); else null. */
export function solSource(tx: ParsedTransactionWithMeta, address: string): string | null {
  if (!tx.meta || solDelta(tx, address) <= 0) return null;
  const k = keys(tx);
  let best: string | null = null;
  let bestLoss = 0;
  k.forEach((acct, i) => {
    if (acct === address) return;
    const loss = (tx.meta!.preBalances[i] ?? 0) - (tx.meta!.postBalances[i] ?? 0);
    if (loss > bestLoss) { bestLoss = loss; best = acct; }
  });
  return best;
}

/** A USDC gain for `owner` in this transaction: who sent it and who paid the fee. */
export function usdcInflow(tx: ParsedTransactionWithMeta, owner: string): { sender: string; feePayer: string } | null {
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];
  const amt = (list: typeof pre, who: string) =>
    list.filter((b) => b.mint === USDC_MINT && b.owner === who).reduce((s, b) => s + Number(b.uiTokenAmount.amount), 0);
  if (amt(post, owner) <= amt(pre, owner)) return null;
  const owners = new Set([...pre, ...post].filter((b) => b.mint === USDC_MINT && b.owner && b.owner !== owner).map((b) => b.owner!));
  const sender = [...owners].find((o) => amt(post, o) < amt(pre, o));
  if (!sender) return null;
  return { sender, feePayer: keys(tx)[0] };
}
