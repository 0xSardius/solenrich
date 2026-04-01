/**
 * Demo consumer — takes a natural language question, calls SolEnrich, interprets results
 */

const KNOWN_TOKENS: Record<string, string> = {
  jup: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  jupiter: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
  bonk: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  sol: 'So11111111111111111111111111111111111111112',
  usdc: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  wif: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
  ray: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
  orca: 'orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE',
};

interface RouteResult {
  endpoint: string;
  input: any;
}

export class DemoConsumer {
  private baseUrl: string;
  private fetchFn: typeof fetch;

  constructor(baseUrl: string, fetchFn?: typeof fetch) {
    this.baseUrl = baseUrl;
    this.fetchFn = fetchFn ?? globalThis.fetch;
  }

  async ask(question: string): Promise<void> {
    console.log(`  Question: "${question}"\n`);

    const route = this.routeQuestion(question);
    if (!route) {
      console.log('  Could not understand the question. Try:');
      console.log('    "Is JUP safe?"');
      console.log('    "Compare JUP vs BONK"');
      console.log('    "Whale activity on BONK"');
      console.log('    "Profile wallet vines1vz..."');
      return;
    }

    console.log(`  Routing to: ${route.endpoint}`);
    console.log(`  Input: ${JSON.stringify(route.input)}\n`);

    try {
      const start = Date.now();
      const res = await this.fetchFn(`${this.baseUrl}/entrypoints/${route.endpoint}/invoke`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ input: route.input }),
      });

      const latency = Date.now() - start;

      if (res.status === 402) {
        const body = await res.json() as any;
        console.log(`  Payment required: $${body.pricing?.amount} USDC`);
        console.log(`  Protocol: ${body.how_to_pay?.protocol}`);
        console.log(`  To use SolEnrich endpoints, send x402 payment headers.\n`);

        // Fall back to demo endpoint
        console.log('  Falling back to free demo endpoint...\n');
        await this.useDemoEndpoint(route, question);
        return;
      }

      if (res.status !== 200) {
        console.log(`  Error: HTTP ${res.status}`);
        return;
      }

      const data = await res.json() as any;
      const output = data.output ?? data;
      const summary = output.llm_summary ?? output.briefing;

      console.log(`  Response (${latency}ms):\n`);
      if (summary) {
        console.log(summary);
      } else {
        console.log(JSON.stringify(output, null, 2).slice(0, 1500));
      }
      console.log('');
    } catch (e: any) {
      console.log(`  Error: ${e.message}\n`);
    }
  }

  private async useDemoEndpoint(route: RouteResult, question: string): Promise<void> {
    // Demo endpoint only supports single address enrichment
    const address = route.input.mint ?? route.input.address ?? route.input.mints?.[0] ?? route.input.addresses?.[0];
    if (!address) {
      console.log('  Demo endpoint requires an address or mint. Cannot fall back.\n');
      return;
    }

    try {
      const start = Date.now();
      const res = await this.fetchFn(`${this.baseUrl}/demo/enrich`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address }),
      });
      const latency = Date.now() - start;
      const data = await res.json() as any;

      if (data.error) {
        console.log(`  Demo error: ${data.error}\n`);
        return;
      }

      console.log(`  Demo response (${latency}ms) — ${data._demo?.type}:`);
      console.log(`  Queries remaining: ${data._demo?.queries_remaining}\n`);

      if (data.llm_summary) {
        console.log(data.llm_summary);
      } else {
        console.log(JSON.stringify(data, null, 2).slice(0, 1000));
      }
      console.log('');
    } catch (e: any) {
      console.log(`  Demo fallback failed: ${e.message}\n`);
    }
  }

  private routeQuestion(question: string): RouteResult | null {
    const q = question.toLowerCase();

    // Extract addresses from the question
    const addressMatch = question.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g);
    const tokenNames = Object.keys(KNOWN_TOKENS).filter(name => q.includes(name));

    // Compare: "compare X vs Y", "X vs Y"
    if (q.includes('compare') || q.includes(' vs ')) {
      const mints: string[] = [];
      for (const name of tokenNames) mints.push(KNOWN_TOKENS[name]);
      if (addressMatch) mints.push(...addressMatch);
      const unique = [...new Set(mints)];

      if (unique.length >= 2) {
        // Detect if these are wallets (longer random-looking) or tokens (known names)
        if (tokenNames.length >= 2) {
          return { endpoint: 'compare-tokens', input: { mints: unique.slice(0, 3), format: 'both' } };
        }
        return { endpoint: 'compare-wallets', input: { addresses: unique.slice(0, 3), depth: 'light', format: 'both' } };
      }
    }

    // Due diligence: "safe", "risky", "due diligence", "should I buy"
    if (q.includes('safe') || q.includes('risky') || q.includes('due diligence') || q.includes('should i buy') || q.includes('rug')) {
      const mint = tokenNames.length > 0 ? KNOWN_TOKENS[tokenNames[0]] : addressMatch?.[0];
      if (mint) return { endpoint: 'due-diligence', input: { mint, format: 'both' } };
    }

    // Whale watch: "whale", "holders", "accumulation"
    if (q.includes('whale') || q.includes('holder') || q.includes('accumulation') || q.includes('distribution')) {
      const mint = tokenNames.length > 0 ? KNOWN_TOKENS[tokenNames[0]] : addressMatch?.[0];
      if (mint) return { endpoint: 'whale-watch', input: { mint, format: 'both' } };
    }

    // Copy trade: "copy", "trade", "pnl", "sharpe"
    if (q.includes('copy') || q.includes('trade performance') || q.includes('pnl') || q.includes('sharpe')) {
      const address = addressMatch?.[0];
      if (address) return { endpoint: 'copy-trade-signals', input: { address, format: 'both' } };
    }

    // Graph: "connections", "graph", "cluster"
    if (q.includes('connection') || q.includes('graph') || q.includes('cluster')) {
      const address = addressMatch?.[0];
      if (address) return { endpoint: 'wallet-graph', input: { address, depth: 1, format: 'both' } };
    }

    // Token analysis: "token", "price", "analysis"
    if (q.includes('token') || q.includes('price') || q.includes('analysis') || q.includes('analyze')) {
      const mint = tokenNames.length > 0 ? KNOWN_TOKENS[tokenNames[0]] : addressMatch?.[0];
      if (mint) return { endpoint: 'enrich-token-full', input: { mint, format: 'both' } };
    }

    // Wallet: "wallet", "profile", "portfolio"
    if (q.includes('wallet') || q.includes('profile') || q.includes('portfolio') || q.includes('holdings')) {
      const address = addressMatch?.[0];
      if (address) return { endpoint: 'enrich-wallet-full', input: { address, format: 'both' } };
    }

    // Fallback: if we found a known token name, do due-diligence
    if (tokenNames.length > 0) {
      return { endpoint: 'due-diligence', input: { mint: KNOWN_TOKENS[tokenNames[0]], format: 'both' } };
    }

    // Fallback: if we found an address, do wallet light
    if (addressMatch) {
      return { endpoint: 'enrich-wallet-light', input: { address: addressMatch[0], format: 'both' } };
    }

    return null;
  }
}
