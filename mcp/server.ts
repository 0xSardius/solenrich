/**
 * MCP Server — stdio transport
 *
 * For local Claude Desktop / Claude Code integration.
 * Run: bun run mcp/server.ts
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createSolEnrichMcpServer } from '../src/mcp-tools';

const server = createSolEnrichMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
