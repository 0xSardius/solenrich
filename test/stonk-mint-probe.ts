/**
 * Probe: read Token-2022 transfer-fee config for StonkFun reward mints on-chain.
 * Run: bun run test/stonk-mint-probe.ts [mint...]
 */
import { Connection, PublicKey } from '@solana/web3.js';
import { CONFIG } from '../src/config';

const conn = new Connection(CONFIG.helius.rpcUrl, 'confirmed');
const mints = process.argv.slice(2).length ? process.argv.slice(2) : [
  'HcRLc9VDgjLeK154xDawfb1dmVJ98DoSqcwTHGqiDeJR', // ZCAT (raydium, reward 300)
  '6HwELngnXrtmSEvA8bpMFPfdFmF7f84TGYSt28f73Dxw', // NCAT (launchlab self-built, reward 100)
  'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263', // BONK (classic SPL, control)
];
for (const m of mints) {
  const info = await conn.getParsedAccountInfo(new PublicKey(m));
  const v = info.value;
  const d = v?.data as any;
  console.log('===', m, 'owner', v?.owner.toBase58(), 'space', d?.space);
  if (d && 'parsed' in d) {
    console.log('type', d.parsed.type, 'decimals', d.parsed.info.decimals, 'supply', d.parsed.info.supply, 'mintAuthority', d.parsed.info.mintAuthority, 'freezeAuthority', d.parsed.info.freezeAuthority);
    for (const ext of d.parsed.info.extensions ?? []) console.log('ext', ext.extension, JSON.stringify(ext.state).slice(0, 600));
  }
}
