import type { HeliusClient, EnhancedTransaction } from '../sources/helius';
import type { Cache } from '../cache';
import { CACHE_TTL } from '../config';
import { formatTimestamp, shortenAddress } from '../utils/normalize';
import { lookupEntity } from '../utils/entities';

export interface GraphNode {
  address: string;
  entity_label?: string;
  entity_type?: string;
  interaction_count: number;
  connection_strength: number;
  category: 'dex' | 'whale' | 'bot' | 'unknown';
}

export interface GraphEdge {
  source: string;
  target: string;
  interaction_count: number;
  total_volume_sol: number;
  direction: 'both' | 'source->target' | 'target->source';
}

export interface GraphCluster {
  members: string[];
  interaction_density: number;
  suspicious_pattern: string | null;
}

export interface GraphEnrichment {
  address: string;
  depth: number;
  node_count: number;
  edge_count: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  clusters: GraphCluster[];
  last_updated: string;
}

// Known DEX/protocol program addresses
const DEX_PROGRAMS = new Set([
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
]);

export class GraphMapper {
  constructor(
    private helius: HeliusClient,
    private cache: Cache,
  ) {}

  async enrich(
    address: string,
    depth: number,
    minInteractions: number,
  ): Promise<GraphEnrichment> {
    const cacheKey = `graph:${address}:${depth}:${minInteractions}`;
    const cached = await this.cache.get<GraphEnrichment>(cacheKey);
    if (cached) return cached;

    // Fetch recent transactions
    const sigs = await this.helius.getSignaturesForAddress(address, 100);
    const sigStrings = sigs.map((s) => s.signature);

    let txs: EnhancedTransaction[] = [];
    if (sigStrings.length > 0) {
      try {
        txs = await this.helius.getEnhancedTransactions(sigStrings);
      } catch {
        // Graceful degradation
      }
    }

    // Build adjacency map from transfers
    const edgeMap = new Map<string, { outCount: number; inCount: number; outSol: number; inSol: number }>();

    for (const tx of txs) {
      // Native SOL transfers
      if (tx.nativeTransfers) {
        for (const t of tx.nativeTransfers) {
          const amountSol = t.amount / 1e9;
          if (t.fromUserAccount === address && t.toUserAccount !== address) {
            const key = t.toUserAccount;
            const entry = edgeMap.get(key) ?? { outCount: 0, inCount: 0, outSol: 0, inSol: 0 };
            entry.outCount++;
            entry.outSol += amountSol;
            edgeMap.set(key, entry);
          }
          if (t.toUserAccount === address && t.fromUserAccount !== address) {
            const key = t.fromUserAccount;
            const entry = edgeMap.get(key) ?? { outCount: 0, inCount: 0, outSol: 0, inSol: 0 };
            entry.inCount++;
            entry.inSol += amountSol;
            edgeMap.set(key, entry);
          }
        }
      }

      // Token transfers
      if (tx.tokenTransfers) {
        for (const t of tx.tokenTransfers) {
          if (t.fromUserAccount === address && t.toUserAccount !== address) {
            const key = t.toUserAccount;
            const entry = edgeMap.get(key) ?? { outCount: 0, inCount: 0, outSol: 0, inSol: 0 };
            entry.outCount++;
            edgeMap.set(key, entry);
          }
          if (t.toUserAccount === address && t.fromUserAccount !== address) {
            const key = t.fromUserAccount;
            const entry = edgeMap.get(key) ?? { outCount: 0, inCount: 0, outSol: 0, inSol: 0 };
            entry.inCount++;
            edgeMap.set(key, entry);
          }
        }
      }
    }

    // Filter by minimum interactions and build nodes/edges
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];

    for (const [counterparty, data] of edgeMap) {
      const totalInteractions = data.outCount + data.inCount;
      if (totalInteractions < minInteractions) continue;

      const isBidirectional = data.outCount > 0 && data.inCount > 0;
      const category: GraphNode['category'] = DEX_PROGRAMS.has(counterparty)
        ? 'dex'
        : data.outCount + data.inCount > 50
        ? 'bot'
        : data.outSol + data.inSol > 100
        ? 'whale'
        : 'unknown';

      // Connection strength: normalized by max interactions (capped at 1.0)
      const maxInteractions = Math.max(...[...edgeMap.values()].map((d) => d.outCount + d.inCount), 1);
      const strength = Math.min(totalInteractions / maxInteractions, 1.0);

      const entity = lookupEntity(counterparty);
      nodes.push({
        address: counterparty,
        ...(entity ? { entity_label: entity.label, entity_type: entity.type } : {}),
        interaction_count: totalInteractions,
        connection_strength: Math.round(strength * 100) / 100,
        category: entity?.type === 'protocol' ? 'dex' : category,
      });

      edges.push({
        source: address,
        target: counterparty,
        interaction_count: totalInteractions,
        total_volume_sol: Math.round((data.outSol + data.inSol) * 1000) / 1000,
        direction: isBidirectional ? 'both' : data.outCount > 0 ? 'source->target' : 'target->source',
      });
    }

    // Sort by interaction count
    nodes.sort((a, b) => b.interaction_count - a.interaction_count);
    edges.sort((a, b) => b.interaction_count - a.interaction_count);

    // Detect clusters: groups of addresses with bidirectional frequent transfers
    const clusters = this.detectClusters(edges, address, minInteractions);

    // Depth 2: fetch second-hop connections for top 5 nodes
    if (depth >= 2) {
      const hop2Addresses = nodes.slice(0, 5).map((n) => n.address);
      for (const hop2Addr of hop2Addresses) {
        try {
          const hop2Sigs = await this.helius.getSignaturesForAddress(hop2Addr, 50);
          const hop2SigStrings = hop2Sigs.map((s) => s.signature);
          if (hop2SigStrings.length > 0) {
            const hop2Txs = await this.helius.getEnhancedTransactions(hop2SigStrings);
            for (const tx of hop2Txs) {
              if (!tx.nativeTransfers) continue;
              for (const t of tx.nativeTransfers) {
                const peer = t.fromUserAccount === hop2Addr ? t.toUserAccount : t.fromUserAccount;
                if (peer === address || peer === hop2Addr) continue;
                // Only add if not already present
                if (!nodes.some((n) => n.address === peer)) {
                  nodes.push({
                    address: peer,
                    interaction_count: 1,
                    connection_strength: 0.1,
                    category: 'unknown',
                  });
                }
              }
            }
          }
        } catch {
          // Skip failed hop-2 lookups
        }
      }
    }

    const enrichment: GraphEnrichment = {
      address,
      depth,
      node_count: nodes.length,
      edge_count: edges.length,
      nodes: nodes.slice(0, 50),
      edges: edges.slice(0, 50),
      clusters,
      last_updated: formatTimestamp(),
    };

    await this.cache.set(cacheKey, enrichment, CACHE_TTL.graph);
    return enrichment;
  }

  private detectClusters(edges: GraphEdge[], center: string, minInteractions: number): GraphCluster[] {
    const bidirectionalPeers = edges
      .filter((e) => e.direction === 'both' && e.interaction_count >= minInteractions * 2)
      .map((e) => e.target);

    if (bidirectionalPeers.length < 2) return [];

    // Simple clustering: all bidirectional peers form one cluster with center
    const members = [center, ...bidirectionalPeers.slice(0, 10)];
    const density = bidirectionalPeers.length / Math.max(edges.length, 1);

    const suspicious = density > 0.5 && bidirectionalPeers.length >= 3
      ? 'High bidirectional transfer density — possible coordinated activity'
      : null;

    return [{
      members,
      interaction_density: Math.round(density * 100) / 100,
      suspicious_pattern: suspicious,
    }];
  }
}
