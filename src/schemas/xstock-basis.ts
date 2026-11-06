import { z } from 'zod';
import { FormatSchema } from './common';

/** The xStocks (Backed, SPL) that also have a Phoenix perp. Mints from StonkFun's quote list (category xstock), 2026-11-05. */
export const XSTOCK_MINTS = {
  NVDA: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh',
  TSLA: 'XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB',
  SPY: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W',
  QQQ: 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ',
  AMZN: 'Xs3eBt7uRfJX8QUs4suhyU8p2M6DoUDrJyWBa8LLZsg',
  META: 'Xsa62P5mvPszXL1krVUnU5ar38bBSVcWAB6fmPCo5Zu',
  GOOGL: 'XsCPL9dNWBMvFtTmwcCA5v3xWPSMEBCszbQdiLLq6aN',
  MSTR: 'XsP7xzNPvEHS1m6qfanPUGjNmdnmsLKEoNAnHjdxxyZ',
  COIN: 'Xs7ZdzSHLU9ftNJsii5fCeJhoRWSC32SQGzGQtePxNu',
  HOOD: 'XsvNBAYkrDRNhA7wPHQfX3ZUXZyZLdnCQDfHZ56bzpg',
  CRCL: 'XsueG8BtpquVJX9LVLLEGuViXUungE6WmK5YZ3p3bd1',
} as const;
/** Every xStock above has 8 decimals. */
export const XSTOCK_DECIMALS = 8;
export type XstockSymbol = keyof typeof XSTOCK_MINTS;
export const XSTOCK_SYMBOLS = Object.keys(XSTOCK_MINTS) as [XstockSymbol, ...XstockSymbol[]];

// Required symbol → needs a BAZAAR_INPUT_EXAMPLES entry (checklist item 9).
export const XstockBasisInput = z.object({
  /** Underlying ticker. The xStock is <symbol>x (NVDAx); the Phoenix perp is <symbol>. */
  symbol: z.enum(XSTOCK_SYMBOLS),
  /** Notional per leg in USD. */
  size_usd: z.number().min(100).max(100_000).default(1000),
  format: FormatSchema,
});
export type XstockBasisInput = z.infer<typeof XstockBasisInput>;
