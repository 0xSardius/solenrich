import type { GraphEnrichment } from '../enrichers/graph-mapper';
import { shortenAddress } from '../utils/normalize';

export function formatGraphBriefing(data: GraphEnrichment): string {
  const lines: string[] = [];

  lines.push(`## Wallet Graph: ${shortenAddress(data.address)}`);
  lines.push('');

  lines.push(`${data.node_count} connected address(es), ${data.edge_count} edge(s). Depth: ${data.depth}.`);
  lines.push('');

  // Top connections
  const topNodes = data.nodes.slice(0, 5);
  if (topNodes.length > 0) {
    lines.push('### Strongest Connections');
    for (const node of topNodes) {
      lines.push(
        `- ${shortenAddress(node.address)} [${node.category}]: ${node.interaction_count} interactions (strength ${node.connection_strength})`,
      );
    }
    lines.push('');
  }

  // Category breakdown
  const categories = new Map<string, number>();
  for (const node of data.nodes) {
    categories.set(node.category, (categories.get(node.category) ?? 0) + 1);
  }
  const catSummary = [...categories.entries()].map(([cat, count]) => `${count} ${cat}`).join(', ');
  lines.push(`Categories: ${catSummary}.`);
  lines.push('');

  // Clusters
  if (data.clusters.length > 0) {
    lines.push('### Clusters Detected');
    for (const cluster of data.clusters) {
      const memberStr = cluster.members.slice(0, 4).map(shortenAddress).join(', ');
      lines.push(`- ${cluster.members.length} members (${memberStr}), density: ${cluster.interaction_density}`);
      if (cluster.suspicious_pattern) {
        lines.push(`  Warning: ${cluster.suspicious_pattern}`);
      }
    }
    lines.push('');
  }

  lines.push(`Data as of: ${data.last_updated}`);

  return lines.join('\n');
}
