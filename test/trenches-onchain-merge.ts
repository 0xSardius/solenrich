// Write the vetted on-chain seed set (test/trenches-onchain-result.json) into the live seed file.
// Replaces ONLY the TRENCHES_SMART_MONEY_SEEDS array and TRENCHES_SEEDS_DERIVED_AT; conviction holders and the
// cadence thresholds stay. Live set = passing wallets, top LIVE_CAP by measured 14-day PnL.
// Run: bun run test/trenches-onchain-merge.ts

import { readFileSync, writeFileSync } from 'fs';
import { TRENCHES_SEED_EXCLUDED } from '../src/enrichers/trenches-smart-money-seeds';

const LIVE_CAP = 100;
const FILE = 'src/enrichers/trenches-smart-money-seeds.ts';
const { summary, rows } = JSON.parse(readFileSync('test/trenches-onchain-result.json', 'utf8'));
const excluded = rows.filter((r: any) => r.pass && TRENCHES_SEED_EXCLUDED[r.address]);
for (const r of excluded) console.log(`skipped ${r.address}: ${TRENCHES_SEED_EXCLUDED[r.address]}`);
const pass = rows.filter((r: any) => r.pass && !TRENCHES_SEED_EXCLUDED[r.address]).sort((a: any, b: any) => b.pnl_usd - a.pnl_usd).slice(0, LIVE_CAP);
if (pass.length === 0) { console.error('no passing wallets — seed file left unchanged'); process.exit(1); }

const date = String(summary.derived_at).slice(0, 10);
const line = (r: any) => `  { address: '${r.address}', realized_1w_usd: null, win_rate: ${r.win_rate}, tx_per_h: ${r.tx_per_h}, ` +
  `pnl_14d_usd: ${Math.round(r.pnl_usd * 100) / 100}, closed_trades_14d: ${r.closed}, vetted_at: '${date}'` +
  `${r.source === 'current_seed' ? ", note: 're-vetted current seed'" : ''} },`;
const block = `export const TRENCHES_SMART_MONEY_SEEDS: readonly TrenchesSeed[] = [\n` +
  `  // --- ${date} on-chain rebuild (test/trenches-onchain-seeds.ts): ${pass.length} wallets passed ` +
  `${summary.gates.minClosed}+ closed trades, ≥ ${summary.gates.minWinRate * 100}% win, PnL > 0 over ${summary.gates.lookbackDays} d (quote-leg PnL),\n` +
  `  //     human cadence (< ${summary.gates.maxTxPerH} tx/h, no bot flags), active in the last ${summary.gates.activeDays} d. Sorted by 14-day PnL.\n` +
  pass.map(line).join('\n') + '\n];';

const src = readFileSync(FILE, 'utf8');
const start = src.indexOf('export const TRENCHES_SMART_MONEY_SEEDS');
const end = src.indexOf('\n];', start) + 3;
if (start < 0 || end < 3) throw new Error('seed array not found');
let out = src.slice(0, start) + block + src.slice(end);
out = out.replace(/export const TRENCHES_SEEDS_DERIVED_AT = '[^']*';/, `export const TRENCHES_SEEDS_DERIVED_AT = '${date}';`);
writeFileSync(FILE, out);
console.log(`wrote ${pass.length} seeds (${pass.filter((r: any) => r.source === 'current_seed').length} re-vetted current, ` +
  `${pass.filter((r: any) => r.source === 'onchain').length} new) to ${FILE}`);
