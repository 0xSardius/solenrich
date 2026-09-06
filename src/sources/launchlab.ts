import { PublicKey, Transaction, TransactionInstruction, VersionedTransaction, SystemProgram } from '@solana/web3.js';
import type { Connection, AddressLookupTableAccount } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from './token-2022';

// Raydium LaunchLab (bonding-curve launchpad) initialize-instruction codec.
// Layouts mirror raydium-sdk-V2 `src/raydium/launchpad/instrument.ts`
// (initializeV2 + initializeWithToken2022). Only the bytes matter here: the
// preflight endpoint reads what an agent is about to broadcast and diffs it
// against StonkFun's published launch shape.

export const LAUNCHLAB_PROGRAM_ID = 'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj';
export const METADATA_PROGRAM_ID = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
export const RENT_SYSVAR_ID = 'SysvarRent111111111111111111111111111111111';

/** Anchor discriminators (sha256("global:<name>")[0..8]) from raydium-sdk-V2. */
export const LAUNCHLAB_DISCRIMINATORS = {
  initialize: [175, 175, 109, 31, 13, 152, 155, 237],
  initialize_v2: [67, 153, 175, 39, 218, 16, 38, 32],
  initialize_with_token_2022: [37, 190, 126, 222, 44, 154, 171, 17],
} as const;

export type LaunchLabVariant = keyof typeof LAUNCHLAB_DISCRIMINATORS;
export type CurveType = 'ConstantCurve' | 'FixedCurve' | 'LinearCurve';

export interface DecodedAccount {
  pubkey: string;
  isSigner: boolean;
  isWritable: boolean;
}

export interface LaunchLabInitializeParams {
  decimals: number;
  name: string;
  symbol: string;
  uri: string;
  curveType: CurveType;
  supply: string;
  /** Only ConstantCurve carries totalSellA. */
  totalSellA: string | null;
  totalFundRaisingB: string;
  migrateType: 'amm' | 'cpmm';
  totalLockedAmount: string;
  cliffPeriod: string;
  unlockPeriod: string;
  cpmmCreatorFeeOn: number;
  /** Only initialize_with_token_2022 carries this block. `present` = the Option tag byte. */
  transferFee: { present: boolean; transferFeeBasePoints: number; maxinumFee: string } | null;
}

export interface LaunchLabNamedAccounts {
  payer: DecodedAccount;
  creator: DecodedAccount;
  configId: DecodedAccount;
  platformId: DecodedAccount;
  auth: DecodedAccount;
  poolId: DecodedAccount;
  mintA: DecodedAccount;
  mintB: DecodedAccount;
  vaultA: DecodedAccount;
  vaultB: DecodedAccount;
  /** initialize / initialize_v2 only (Metaplex metadata account). */
  metadataId: DecodedAccount | null;
  tokenProgramA: DecodedAccount;
  tokenProgramB: DecodedAccount;
  /** Accounts after the fixed set: [platformAllowConfig?, platformCurveRule?]. */
  trailing: DecodedAccount[];
}

export interface DecodedLaunchLabInitialize {
  variant: LaunchLabVariant;
  programId: string;
  instructionIndex: number;
  accounts: DecodedAccount[];
  named: LaunchLabNamedAccounts;
  params: LaunchLabInitializeParams;
}

export interface DecodedLaunchTransaction {
  version: 'legacy' | 0;
  feePayer: string | null;
  instructionCount: number;
  usesLookupTables: boolean;
  /** Program ids of every top-level instruction, in order. */
  programIds: string[];
  initialize: DecodedLaunchLabInitialize | null;
}

export class LaunchLabDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LaunchLabDecodeError';
  }
}

// --- byte helpers ----------------------------------------------------------

class Reader {
  private off = 0;
  constructor(private readonly buf: Buffer) {}
  get offset(): number { return this.off; }
  get remaining(): number { return this.buf.length - this.off; }
  u8(): number { this.need(1); return this.buf[this.off++]; }
  u16(): number { this.need(2); const v = this.buf.readUInt16LE(this.off); this.off += 2; return v; }
  u64(): string { this.need(8); const v = this.buf.readBigUInt64LE(this.off); this.off += 8; return v.toString(); }
  str(): string {
    this.need(4);
    const len = this.buf.readUInt32LE(this.off); this.off += 4;
    this.need(len);
    const s = this.buf.subarray(this.off, this.off + len).toString('utf8'); this.off += len;
    return s;
  }
  private need(n: number) {
    if (this.off + n > this.buf.length) throw new LaunchLabDecodeError(`instruction data truncated at byte ${this.off} (need ${n} more)`);
  }
}

function matchVariant(data: Buffer): LaunchLabVariant | null {
  if (data.length < 8) return null;
  for (const [name, disc] of Object.entries(LAUNCHLAB_DISCRIMINATORS)) {
    if (disc.every((b, i) => data[i] === b)) return name as LaunchLabVariant;
  }
  return null;
}

/** Decode the data payload of one LaunchLab initialize instruction. */
export function decodeInitializeData(data: Buffer): { variant: LaunchLabVariant; params: LaunchLabInitializeParams } {
  const variant = matchVariant(data);
  if (!variant) throw new LaunchLabDecodeError('not a LaunchLab initialize instruction (discriminator mismatch)');
  const r = new Reader(data.subarray(8));

  const decimals = r.u8();
  const name = r.str();
  const symbol = r.str();
  const uri = r.str();

  const index = r.u8();
  const curveType: CurveType = index === 0 ? 'ConstantCurve' : index === 1 ? 'FixedCurve' : 'LinearCurve';
  const supply = r.u64();
  const totalSellA = curveType === 'ConstantCurve' ? r.u64() : null;
  const totalFundRaisingB = r.u64();
  const migrateType = r.u8() === 0 ? 'amm' : 'cpmm';

  const totalLockedAmount = r.u64();
  const cliffPeriod = r.u64();
  const unlockPeriod = r.u64();
  const cpmmCreatorFeeOn = r.u8();

  let transferFee: LaunchLabInitializeParams['transferFee'] = null;
  if (variant === 'initialize_with_token_2022') {
    const present = r.u8() === 1;
    const transferFeeBasePoints = r.u16();
    const maxinumFee = r.u64();
    transferFee = { present, transferFeeBasePoints, maxinumFee };
  }

  return {
    variant,
    params: { decimals, name, symbol, uri, curveType, supply, totalSellA, totalFundRaisingB, migrateType, totalLockedAmount, cliffPeriod, unlockPeriod, cpmmCreatorFeeOn, transferFee },
  };
}

function nameAccounts(variant: LaunchLabVariant, accounts: DecodedAccount[]): LaunchLabNamedAccounts {
  const fixed = variant === 'initialize_with_token_2022' ? 15 : 18;
  if (accounts.length < fixed) {
    throw new LaunchLabDecodeError(`${variant} needs at least ${fixed} accounts, got ${accounts.length}`);
  }
  const a = accounts;
  if (variant === 'initialize_with_token_2022') {
    return {
      payer: a[0], creator: a[1], configId: a[2], platformId: a[3], auth: a[4], poolId: a[5],
      mintA: a[6], mintB: a[7], vaultA: a[8], vaultB: a[9],
      metadataId: null,
      tokenProgramA: a[10], tokenProgramB: a[11],
      // a[12] system, a[13] event authority, a[14] program
      trailing: a.slice(15),
    };
  }
  return {
    payer: a[0], creator: a[1], configId: a[2], platformId: a[3], auth: a[4], poolId: a[5],
    mintA: a[6], mintB: a[7], vaultA: a[8], vaultB: a[9],
    metadataId: a[10],
    tokenProgramA: a[11], tokenProgramB: a[12],
    // a[13] metadata program, a[14] system, a[15] rent, a[16] event authority, a[17] program
    trailing: a.slice(18),
  };
}

// --- transaction decode ----------------------------------------------------

async function resolveLookups(
  tx: VersionedTransaction,
  connection?: Connection,
): Promise<AddressLookupTableAccount[]> {
  const lookups = tx.message.addressTableLookups ?? [];
  if (lookups.length === 0) return [];
  if (!connection) {
    throw new LaunchLabDecodeError('transaction uses address lookup tables and no RPC connection is available to resolve them');
  }
  const tables: AddressLookupTableAccount[] = [];
  for (const l of lookups) {
    const res = await connection.getAddressLookupTable(l.accountKey);
    if (!res.value) throw new LaunchLabDecodeError(`address lookup table ${l.accountKey.toBase58()} not found`);
    tables.push(res.value);
  }
  return tables;
}

/**
 * Decode a base64 unsigned transaction (legacy or v0) and find its LaunchLab
 * initialize instruction. Lookup tables are resolved through `connection`
 * when present.
 */
export async function decodeLaunchTransaction(
  base64: string,
  connection?: Connection,
): Promise<DecodedLaunchTransaction> {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64.trim(), 'base64');
  } catch {
    throw new LaunchLabDecodeError('unsignedTransaction is not valid base64');
  }
  if (bytes.length < 64) throw new LaunchLabDecodeError('unsignedTransaction is too short to be a Solana transaction');

  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(bytes);
  } catch (err) {
    throw new LaunchLabDecodeError(`could not deserialize transaction: ${err instanceof Error ? err.message : String(err)}`);
  }

  const message = tx.message;
  const tables = await resolveLookups(tx, connection);
  const keys = message.getAccountKeys({ addressLookupTableAccounts: tables });
  const staticCount = message.staticAccountKeys.length;
  const writableLookupCount = (message.addressTableLookups ?? []).reduce((n, l) => n + l.writableIndexes.length, 0);

  const accountAt = (idx: number): DecodedAccount => {
    const pk = keys.get(idx);
    if (!pk) throw new LaunchLabDecodeError(`instruction references account index ${idx} outside the key table`);
    const isStatic = idx < staticCount;
    return {
      pubkey: pk.toBase58(),
      isSigner: isStatic ? message.isAccountSigner(idx) : false,
      isWritable: isStatic ? message.isAccountWritable(idx) : idx - staticCount < writableLookupCount,
    };
  };

  const programIds: string[] = [];
  let initialize: DecodedLaunchLabInitialize | null = null;

  message.compiledInstructions.forEach((ix, i) => {
    const programId = keys.get(ix.programIdIndex)?.toBase58() ?? 'unknown';
    programIds.push(programId);
    if (initialize || programId !== LAUNCHLAB_PROGRAM_ID) return;
    const data = Buffer.from(ix.data);
    if (!matchVariant(data)) return;
    const { variant, params } = decodeInitializeData(data);
    const accounts = ix.accountKeyIndexes.map(accountAt);
    initialize = { variant, programId, instructionIndex: i, accounts, named: nameAccounts(variant, accounts), params };
  });

  const feePayer = keys.get(0)?.toBase58() ?? null;
  return {
    version: message.version === 'legacy' ? 'legacy' : 0,
    feePayer,
    instructionCount: message.compiledInstructions.length,
    usesLookupTables: (message.addressTableLookups ?? []).length > 0,
    programIds,
    initialize,
  };
}

// --- encoder (fixtures, examples, round-trip tests) ------------------------

export interface EncodeInitializeInput {
  variant: 'initialize_v2' | 'initialize_with_token_2022';
  accounts: {
    payer: string; creator: string; configId: string; platformId: string; auth: string; poolId: string;
    mintA: string; mintB: string; vaultA: string; vaultB: string;
    metadataId?: string;
    tokenProgramA: string; tokenProgramB: string;
    eventAuthority: string;
    trailing?: string[];
  };
  params: Omit<LaunchLabInitializeParams, 'transferFee'> & {
    transferFee?: { present: boolean; transferFeeBasePoints: number; maxinumFee: string } | null;
  };
}

function u64Buf(v: string): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(v));
  return b;
}
function strBuf(s: string): Buffer {
  const body = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(body.length);
  return Buffer.concat([len, body]);
}

/** Build the raw instruction bytes + account metas for a LaunchLab initialize. */
export function encodeInitializeInstruction(input: EncodeInitializeInput): TransactionInstruction {
  const p = input.params;
  const parts: Buffer[] = [Buffer.from(LAUNCHLAB_DISCRIMINATORS[input.variant])];
  parts.push(Buffer.from([p.decimals]), strBuf(p.name), strBuf(p.symbol), strBuf(p.uri));
  const index = p.curveType === 'ConstantCurve' ? 0 : p.curveType === 'FixedCurve' ? 1 : 2;
  parts.push(Buffer.from([index]), u64Buf(p.supply));
  if (p.curveType === 'ConstantCurve') parts.push(u64Buf(p.totalSellA ?? '0'));
  parts.push(u64Buf(p.totalFundRaisingB), Buffer.from([p.migrateType === 'amm' ? 0 : 1]));
  parts.push(u64Buf(p.totalLockedAmount), u64Buf(p.cliffPeriod), u64Buf(p.unlockPeriod), Buffer.from([p.cpmmCreatorFeeOn]));
  if (input.variant === 'initialize_with_token_2022') {
    const tf = p.transferFee ?? { present: false, transferFeeBasePoints: 0, maxinumFee: '0' };
    const bps = Buffer.alloc(2);
    bps.writeUInt16LE(tf.transferFeeBasePoints);
    parts.push(Buffer.from([tf.present ? 1 : 0]), bps, u64Buf(tf.maxinumFee));
  }

  const a = input.accounts;
  const k = (pubkey: string, isSigner: boolean, isWritable: boolean) => ({ pubkey: new PublicKey(pubkey), isSigner, isWritable });
  const keys = [
    k(a.payer, true, true), k(a.creator, false, false), k(a.configId, false, false), k(a.platformId, false, false),
    k(a.auth, false, false), k(a.poolId, false, true), k(a.mintA, true, true), k(a.mintB, false, false),
    k(a.vaultA, false, true), k(a.vaultB, false, true),
  ];
  if (input.variant === 'initialize_v2') {
    keys.push(k(a.metadataId ?? METADATA_PROGRAM_ID, false, true));
    keys.push(k(a.tokenProgramA, false, false), k(a.tokenProgramB, false, false), k(METADATA_PROGRAM_ID, false, false));
    keys.push(k(SystemProgram.programId.toBase58(), false, false), k(RENT_SYSVAR_ID, false, false));
  } else {
    keys.push(k(a.tokenProgramA, false, false), k(a.tokenProgramB, false, false));
    keys.push(k(SystemProgram.programId.toBase58(), false, false));
  }
  keys.push(k(a.eventAuthority, false, false), k(LAUNCHLAB_PROGRAM_ID, false, false));
  for (const t of a.trailing ?? []) keys.push(k(t, false, false));

  return new TransactionInstruction({ programId: new PublicKey(LAUNCHLAB_PROGRAM_ID), keys, data: Buffer.concat(parts) });
}

/** Wrap instructions into an unsigned legacy transaction, base64-encoded. */
export function encodeUnsignedTransaction(instructions: TransactionInstruction[], feePayer: string, recentBlockhash = '11111111111111111111111111111111'): string {
  const tx = new Transaction({ feePayer: new PublicKey(feePayer), recentBlockhash });
  tx.add(...instructions);
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

/** LaunchLab event-authority PDA (seed "__event_authority"). */
export function launchLabEventAuthority(): string {
  return PublicKey.findProgramAddressSync([Buffer.from('__event_authority')], new PublicKey(LAUNCHLAB_PROGRAM_ID))[0].toBase58();
}

/**
 * Deterministic example: a correctly-shaped reward-mode launch against SPYX,
 * built from the 2026-09-06 /launchlab/pricing snapshot. Used as the CDP
 * bazaar input example, the SolScout stress fixture, and the endpoint test.
 * Constants except the raise are stable; the raise drifts with price and the
 * preflight reports it as a warning, not a mismatch, inside tolerance.
 */
export const EXAMPLE_LAUNCH = {
  quoteMint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W', // SPYX
  mode: 'reward' as const,
  payer: 'vines1vzrYbzLMRdu58ou5XTby4qAqVRLmqo36NKPTg',
  mintA: 'BvgzoCUMgtos1KRsWwLoabt2a35ErqphzAV3xYEJzrRu',
  configId: 'B7ctMMdGvy46Am56myTtzfkNzt9kWZVTNGM2BWrJ9adg',
  platformReward: '6BwHHDg3u1854jC8PDLXvR4spTcLNaoBxLJNGC4nTESt',
  curveRuleReward: '7MNLMFMmFVhN9Z3sj51QZso28oD2Ta3zDPwNAmfrs2vk',
  supply: '1000000000000000',
  totalSellA: '793100000000000',
  totalFundRaisingB: '1164789044',
};

export function buildExampleLaunchTransaction(overrides: Partial<EncodeInitializeInput['params']> = {}, trailing?: string[]): string {
  const e = EXAMPLE_LAUNCH;
  const ix = encodeInitializeInstruction({
    variant: 'initialize_with_token_2022',
    accounts: {
      payer: e.payer, creator: e.payer, configId: e.configId, platformId: e.platformReward,
      auth: 'WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh',
      poolId: 'DFVooc8ekdz4xznApLxEbTNSDMDB9P4czeqH6ZMXn78C',
      mintA: e.mintA, mintB: e.quoteMint,
      vaultA: 'BBYVxswtLq8VTxQvzmVYkJsjMv8Jsw3csBK7jLmBQpjK', vaultB: 'Ad7pbBvVRNofo96WR6eHwmU2o4naZ6Lao1J98hW8a1TQ',
      tokenProgramA: TOKEN_2022_PROGRAM_ID, tokenProgramB: TOKEN_2022_PROGRAM_ID,
      eventAuthority: launchLabEventAuthority(),
      trailing: trailing ?? [e.curveRuleReward],
    },
    params: {
      decimals: 6, name: 'Example Coin', symbol: 'EXMPL', uri: 'https://example.com/meta.json',
      curveType: 'ConstantCurve', supply: e.supply, totalSellA: e.totalSellA, totalFundRaisingB: e.totalFundRaisingB,
      migrateType: 'cpmm', totalLockedAmount: '0', cliffPeriod: '0', unlockPeriod: '0', cpmmCreatorFeeOn: 0,
      transferFee: { present: true, transferFeeBasePoints: 300, maxinumFee: e.supply },
      ...overrides,
    },
  });
  return encodeUnsignedTransaction([ix], e.payer);
}

export { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID };
