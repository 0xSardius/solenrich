import { Connection, PublicKey } from '@solana/web3.js';
import type { AccountInfo, ParsedTransactionWithMeta } from '@solana/web3.js';
import { CONFIG } from '../config';

export class SolanaRpcClient {
  private connection: Connection;

  constructor() {
    this.connection = new Connection(CONFIG.helius.rpcUrl, 'confirmed');
  }

  /** Get SOL balance in SOL (not lamports) */
  async getBalance(address: string): Promise<number> {
    const pubkey = new PublicKey(address);
    const lamports = await this.connection.getBalance(pubkey);
    return lamports / 1e9;
  }

  /** Get raw account info */
  async getAccountInfo(address: string): Promise<AccountInfo<Buffer> | null> {
    const pubkey = new PublicKey(address);
    return this.connection.getAccountInfo(pubkey);
  }

  /** Get parsed transaction — fallback if Helius enhanced API is down */
  async getTransaction(signature: string): Promise<ParsedTransactionWithMeta | null> {
    return this.connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
    });
  }

  /** Get recent blockhash */
  async getRecentBlockhash(): Promise<string> {
    const { blockhash } = await this.connection.getLatestBlockhash();
    return blockhash;
  }

  /** Get parsed mint account info (supply, decimals, authorities) */
  async getMintInfo(mint: string): Promise<{
    supply: number;
    decimals: number;
    mintAuthority: string | null;
    freezeAuthority: string | null;
  } | null> {
    const pubkey = new PublicKey(mint);
    const info = await this.connection.getParsedAccountInfo(pubkey);
    const parsed = (info.value?.data as any)?.parsed;
    if (!parsed || parsed.type !== 'mint') return null;

    const data = parsed.info;
    return {
      supply: Number(data.supply ?? 0),
      decimals: data.decimals ?? 0,
      mintAuthority: data.mintAuthority ?? null,
      freezeAuthority: data.freezeAuthority ?? null,
    };
  }

  /** Get the 20 largest token accounts for a mint (top holders) */
  async getTokenLargestAccounts(mint: string): Promise<Array<{
    address: string;
    amount: number;
    decimals: number;
    uiAmount: number;
  }>> {
    const pubkey = new PublicKey(mint);
    // Retry once on transient RPC errors (overloaded index, rate limits)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // Internal timeout — for BONK/JUP/USDC-class tokens this RPC call
        // can hang for ~10s before failing. Cap it at 5s so the Birdeye
        // fallback path in TokenAnalyzer can kick in fast.
        const result = await Promise.race([
          this.connection.getTokenLargestAccounts(pubkey),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('getTokenLargestAccounts timeout')), 5000),
          ),
        ]);
        return result.value
          .filter((a) => Number(a.amount) > 0)
          .map((account) => ({
            address: account.address.toBase58(),
            amount: Number(account.amount),
            decimals: account.decimals,
            uiAmount: account.uiAmount ?? Number(account.amount) / 10 ** account.decimals,
          }));
      } catch (err: any) {
        const msg = err?.message ?? '';
        // Non-retryable: tokens with millions of holders exceed RPC limits
        if (msg.includes('Too many accounts')) return [];
        // Non-retryable: our own internal timeout — return [] so fallback runs
        if (msg.includes('getTokenLargestAccounts timeout')) return [];
        // Retryable: overloaded index service
        if (attempt === 0 && msg.includes('overloaded')) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        throw err;
      }
    }
    return [];
  }

  /** Resolve token account addresses to their owner wallets (batch, single RPC call) */
  async resolveTokenAccountOwners(addresses: string[]): Promise<Array<{ tokenAccount: string; owner: string | null }>> {
    const pubkeys = addresses.map((a) => new PublicKey(a));
    const result = await this.connection.getMultipleParsedAccounts(pubkeys);
    return addresses.map((addr, i) => {
      const info = result.value[i];
      const parsed = (info?.data as any)?.parsed?.info;
      return { tokenAccount: addr, owner: parsed?.owner ?? null };
    });
  }

  /** Expose connection for direct use by enrichers if needed */
  getConnection(): Connection {
    return this.connection;
  }
}
