import type { WalletLinkResult } from '../enrichers/wallet-link';
import { shortenAddress } from '../utils/normalize';

export function formatWalletLinkBriefing(data: WalletLinkResult): string {
  const lines: string[] = [];
  const a = shortenAddress(data.wallet_a);
  const b = shortenAddress(data.wallet_b);

  lines.push(`## Wallet Link: ${a} → ${b}`);
  lines.push('');
  lines.push(`**Verdict: ${data.verdict}** (same-owner confidence ${data.same_owner_confidence}).`);
  if (data.risk_flags.length) lines.push(`Risk flags: ${data.risk_flags.join(', ')}.`);
  lines.push('');

  lines.push('### Evidence');
  for (const e of data.evidence) lines.push(`- ${e}`);
  lines.push('');

  lines.push('### Details');
  const d = data.direct_link;
  lines.push(`- Shared transactions: ${d.shared_txs} (A→B ${d.a_to_b}, B→A ${d.b_to_a})${d.complete ? '' : ' — check incomplete'}.`);
  const f = data.funding;
  lines.push(`- First funders: A ${f.a_funder ? shortenAddress(f.a_funder) : 'unknown'}, B ${f.b_funder ? shortenAddress(f.b_funder) : 'unknown'}${f.b_funder_entity ? ` (${f.b_funder_entity})` : ''}.`);
  const p = data.b_profile;
  lines.push(`- B: first seen ${p.first_seen ? p.first_seen.slice(0, 10) : 'never'}, ${p.tx_count}${p.history_complete ? '' : '+'} transactions${p.entity ? `, known ${p.entity}` : ''}.`);
  const x = data.x402;
  lines.push(`- B x402-style payments: ${x.facilitator_style_inflows} of ${x.usdc_inflows_sampled} recent USDC inflows, ${x.distinct_payers} payer(s)${x.known_facilitator ? ', via a known facilitator' : ''}.`);
  lines.push('');
  lines.push('_Behaviour signals only; there is no scam database behind this. UNCERTAIN means the chain does not prove a link._');
  return lines.join('\n');
}
