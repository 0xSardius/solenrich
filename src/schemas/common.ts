import { z } from 'zod';

// Base58 character set (no 0, O, I, l)
const BASE58_REGEX = /^[1-9A-HJ-NP-Za-km-z]+$/;

export const FormatSchema = z.enum(['json', 'llm', 'both']).default('json');
export type Format = z.infer<typeof FormatSchema>;

export const DepthSchema = z.enum(['light', 'full']).default('light');
export type Depth = z.infer<typeof DepthSchema>;

export const SolanaAddressSchema = z
  .string()
  .min(32)
  .max(44)
  .regex(BASE58_REGEX, 'Invalid Solana address: must be base58');
export type SolanaAddress = z.infer<typeof SolanaAddressSchema>;

export const TxSignatureSchema = z
  .string()
  .min(87)
  .max(88)
  .regex(BASE58_REGEX, 'Invalid transaction signature: must be base58');
export type TxSignature = z.infer<typeof TxSignatureSchema>;

export const TimestampSchema = z.string().datetime();
export type Timestamp = z.infer<typeof TimestampSchema>;
