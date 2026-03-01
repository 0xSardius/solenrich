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

  /** Expose connection for direct use by enrichers if needed */
  getConnection(): Connection {
    return this.connection;
  }
}
