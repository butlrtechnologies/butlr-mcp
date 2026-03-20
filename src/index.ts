#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerSearchAssets } from "./tools/butlr-search-assets.js";
import { registerGetAssetDetails } from "./tools/butlr-get-asset-details.js";
import { registerHardwareSnapshot } from "./tools/butlr-hardware-snapshot.js";

const SERVER_NAME = "butlr-mcp-server";
const SERVER_VERSION = "0.1.0";

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

// Register all tools
registerSearchAssets(server);
registerGetAssetDetails(server);
registerHardwareSnapshot(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (process.env.DEBUG === "butlr-mcp" || process.env.DEBUG === "*") {
    console.error(`[${SERVER_NAME}] Server started on stdio transport`);
    console.error(`[${SERVER_NAME}] Version: ${SERVER_VERSION}`);
  }
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
