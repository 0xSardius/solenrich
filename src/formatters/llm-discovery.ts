import type { TokenDiscoveryResult } from '../enrichers/token-discovery';
import { formatUsd, shortenAddress } from '../utils/normalize';

export function formatDiscoveryBriefing(data: TokenDiscoveryResult): string {
  let out = `## New Token Discovery\n\n`;
  out += `Scanned ${data.total_scanned} recently listed tokens. ${data.total_passed} passed filters `;
  out += `(min liquidity: ${formatUsd(data.filters.min_liquidity_usd)}, max risk: ${(data.filters.max_risk_score * 100).toFixed(0)}%).\n\n`;

  if (data.tokens.length === 0) {
    out += 'No tokens matched the criteria. Try lowering the min_liquidity_usd or raising max_risk_score.\n';
  } else {
    out += '| # | Token | Price | Market Cap | Liquidity | Risk | Verdict |\n';
    out += '|---|-------|-------|-----------|-----------|------|--------|\n';

    for (let i = 0; i < data.tokens.length; i++) {
      const t = data.tokens[i];
      const name = t.symbol || shortenAddress(t.mint);
      out += `| ${i + 1} | ${name} | ${formatUsd(t.price_usd)} | ${formatUsd(t.market_cap)} | ${formatUsd(t.liquidity)} | ${(t.risk_score * 100).toFixed(0)}% ${t.risk_level} | ${t.recommendation} |\n`;
    }

    out += '\n### Details\n';
    for (const t of data.tokens) {
      const name = t.symbol || shortenAddress(t.mint);
      out += `\n**${name}** (${shortenAddress(t.mint)})\n`;
      out += `- Price: ${formatUsd(t.price_usd)} | Market cap: ${formatUsd(t.market_cap)}\n`;
      out += `- Liquidity: ${formatUsd(t.liquidity)} | 24h volume: ${formatUsd(t.volume_24h)}\n`;
      out += `- Holders: ${t.holder_count}${t.concentration_hhi ? ` | HHI: ${t.concentration_hhi}` : ''}\n`;
      out += `- Risk: ${(t.risk_score * 100).toFixed(0)}% (${t.risk_level})${t.risk_flags.length > 0 ? ` — ${t.risk_flags.join(', ')}` : ''}\n`;
      out += `- Verified: ${t.verified ? 'Yes' : 'No'} | Verdict: **${t.recommendation}**\n`;
    }
  }

  out += `\nData as of: ${data.last_updated}`;
  return out;
}
