// One-off: measure live tx_per_h for the two FLAG->promoted seeds (real values
// for trenches-smart-money-seeds.ts, since the frozen JSON omitted them).
import { Cache } from '../src/cache';
import { HeliusClient } from '../src/sources/helius';

const ADDRS = [
  'vsTw91AUb4N91zdACyhuz31ctkQZCfY89iTF5pvCWDr',
  'H8MQegokeJxeWfNiD3MNk8Bykso99s7qWGdtTKu3hmZY',
];

const helius = new HeliusClient(new Cache());
for (const addr of ADDRS) {
  const sigs = await helius.getSignaturesForAddress(addr, 100);
  const ts = sigs.map((s: any) => s.blockTime).filter((t: any): t is number => typeof t === 'number');
  const span = ts.length >= 2 ? Math.max(...ts) - Math.min(...ts) : 0;
  const txPerH = span > 0 ? ts.length / (span / 3600) : Infinity;
  console.log(`${addr.slice(0, 6)}… n=${ts.length} span=${(span / 3600).toFixed(1)}h tx_per_h=${txPerH.toFixed(1)}`);
}
