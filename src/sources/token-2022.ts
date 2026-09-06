import { PublicKey } from '@solana/web3.js';
import type { Connection } from '@solana/web3.js';

// Token-2022 mint reader. Uses the RPC's jsonParsed mint decoding, which
// already expands Token-2022 extensions (transferFeeConfig, metadataPointer,
// ...). We only need the transfer-fee state, so no spl-token dependency.

export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

export interface MintTransferFee {
  /** Basis points charged on every transfer (100 = 1%). */
  bps: number;
  /** Absolute cap per transfer, raw units. "1000000000000000" means the cap never binds at 1e15 supply. */
  maximumFeeRaw: string;
  /** Who can withdraw withheld fees — StonkFun's distributor for adopted reward coins. */
  withdrawWithheldAuthority: string | null;
  /** Who can change the fee later. Null = immutable. */
  configAuthority: string | null;
  /** Fees withheld on the mint account, not yet swept. */
  withheldAmountRaw: string;
  /** Epoch the newer fee schedule takes effect. */
  effectiveEpoch: number | null;
}

export interface MintInfo {
  exists: boolean;
  program: 'token-2022' | 'spl-token' | 'other' | null;
  decimals: number | null;
  supplyRaw: string | null;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  /** Null when the mint carries no transfer-fee extension. */
  transferFee: MintTransferFee | null;
  /** Names of every extension present (Token-2022 only). */
  extensions: string[];
}

/** Shape of `getParsedAccountInfo().value` for a mint — what the fixtures record. */
export interface ParsedMintAccount {
  owner: string;
  space?: number;
  parsed: {
    type: string;
    info: {
      decimals?: number;
      supply?: string | number;
      mintAuthority?: string | null;
      freezeAuthority?: string | null;
      extensions?: Array<{ extension: string; state?: Record<string, unknown> }>;
    };
  };
}

function toRawString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return BigInt(Math.round(v)).toString();
  if (typeof v === 'bigint') return v.toString();
  return '0';
}

/** Pure: interpret a jsonParsed mint account. Exported for fixture-driven tests. */
export function parseMintAccount(account: ParsedMintAccount | null): MintInfo {
  if (!account || !account.parsed || account.parsed.type !== 'mint') {
    return { exists: false, program: null, decimals: null, supplyRaw: null, mintAuthority: null, freezeAuthority: null, transferFee: null, extensions: [] };
  }
  const program = account.owner === TOKEN_2022_PROGRAM_ID ? 'token-2022' : account.owner === TOKEN_PROGRAM_ID ? 'spl-token' : 'other';
  const info = account.parsed.info ?? {};
  const extensions = Array.isArray(info.extensions) ? info.extensions : [];

  let transferFee: MintTransferFee | null = null;
  const feeExt = extensions.find((e) => e.extension === 'transferFeeConfig');
  if (feeExt?.state) {
    const s = feeExt.state as Record<string, any>;
    const newer = s.newerTransferFee ?? s.olderTransferFee ?? {};
    transferFee = {
      bps: Number(newer.transferFeeBasisPoints ?? 0),
      maximumFeeRaw: toRawString(newer.maximumFee),
      withdrawWithheldAuthority: s.withdrawWithheldAuthority ?? null,
      configAuthority: s.transferFeeConfigAuthority ?? null,
      withheldAmountRaw: toRawString(s.withheldAmount),
      effectiveEpoch: newer.epoch != null ? Number(newer.epoch) : null,
    };
  }

  return {
    exists: true,
    program,
    decimals: info.decimals != null ? Number(info.decimals) : null,
    supplyRaw: info.supply != null ? toRawString(info.supply) : null,
    mintAuthority: info.mintAuthority ?? null,
    freezeAuthority: info.freezeAuthority ?? null,
    transferFee,
    extensions: extensions.map((e) => e.extension),
  };
}

/** Read a mint from chain and interpret it. */
export async function readMintInfo(connection: Connection, mint: string): Promise<MintInfo> {
  const info = await connection.getParsedAccountInfo(new PublicKey(mint));
  const value = info.value;
  if (!value) return parseMintAccount(null);
  const data = value.data as unknown;
  if (!data || typeof data !== 'object' || !('parsed' in data)) {
    return { exists: true, program: 'other', decimals: null, supplyRaw: null, mintAuthority: null, freezeAuthority: null, transferFee: null, extensions: [] };
  }
  return parseMintAccount({
    owner: value.owner.toBase58(),
    space: (data as { space?: number }).space,
    parsed: (data as { parsed: ParsedMintAccount['parsed'] }).parsed,
  });
}
