import type { HeliusClient, EnhancedTransaction } from '../sources/helius';
import type { Cache } from '../cache';
import { CACHE_TTL } from '../config';
import { formatTimestamp } from '../utils/normalize';

// --- Constants ---

const KNOWN_PROTOCOLS: Record<string, string> = {
  MarBmsSgKXdrN1egZf5sqe1TMai9K1rChYNDJgjq7aD: 'Marinade',
  Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb: 'Jito',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8': 'Raydium',
  whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc: 'Orca',
  '6LtLpnUFNByNXLyCoK9wA2MykKAmQNZKBdY8s47dehDc': 'Kamino',
  JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4: 'Jupiter',
  MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA: 'marginfi',
  dRiftyHA39MWEi3m9aunc5MzRF1JYuBsbn6VPcn33UH: 'Drift',
};

// --- Types ---

export interface TransactionEnrichment {
  signature: string;
  type: string;
  description: string;
  protocol: string | null;
  fee_sol: number;
  fee_payer: string;
  timestamp: string;
  success: boolean;
  native_transfers: Array<{
    from: string;
    to: string;
    amount_sol: number;
  }>;
  token_transfers: Array<{
    from: string;
    to: string;
    mint: string;
    symbol?: string;
    amount: number;
  }>;
  accounts_involved: string[];
  last_updated: string;
}

// --- Class ---

export class TxParser {
  constructor(
    private helius: HeliusClient,
    private cache: Cache,
  ) {}

  async enrich(signature: string): Promise<TransactionEnrichment | null> {
    // Step 1: cache check
    const cacheKey = `tx:${signature}`;
    const cached = await this.cache.get<TransactionEnrichment>(cacheKey);
    if (cached) return cached;

    // Step 2: fetch enhanced transaction
    const tx = await this.helius.getEnhancedTransaction(signature);
    if (!tx) return null;

    // Step 3: map to clean structure
    const protocol = this.detectProtocol(tx);

    const enrichment: TransactionEnrichment = {
      signature: tx.signature,
      type: tx.type,
      description: tx.description,
      protocol,
      fee_sol: tx.fee / 1e9,
      fee_payer: tx.feePayer,
      timestamp: new Date(tx.timestamp * 1000).toISOString(),
      success: tx.transactionError === null,
      native_transfers: (tx.nativeTransfers ?? []).map((nt) => ({
        from: nt.fromUserAccount,
        to: nt.toUserAccount,
        amount_sol: nt.amount / 1e9,
      })),
      token_transfers: (tx.tokenTransfers ?? []).map((tt) => ({
        from: tt.fromUserAccount,
        to: tt.toUserAccount,
        mint: tt.mint,
        amount: tt.tokenAmount,
      })),
      accounts_involved: [...new Set(tx.accountData.map((a) => a.account))],
      last_updated: formatTimestamp(),
    };

    // Step 4: cache and return
    await this.cache.set(cacheKey, enrichment, CACHE_TTL.transaction);
    return enrichment;
  }

  private detectProtocol(tx: EnhancedTransaction): string | null {
    // Check source field first (Helius often identifies the protocol)
    if (tx.source && tx.source !== 'SYSTEM_PROGRAM' && tx.source !== 'UNKNOWN') {
      return tx.source;
    }

    // Fall back to matching account addresses against known program IDs
    for (const ad of tx.accountData) {
      const proto = KNOWN_PROTOCOLS[ad.account];
      if (proto) return proto;
    }

    return null;
  }
}
