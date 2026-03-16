#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const SERVER_NAME = "butlr-mcp-server";
const SERVER_VERSION = "0.1.0";

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: [] };
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (process.env.DEBUG === "butlr-mcp" || process.env.DEBUG === "*") {
    console.error(`[${SERVER_NAME}] Server started on stdio transport`);
    console.error(`[${SERVER_NAME}] Version: ${SERVER_VERSION}`);
    console.error(`[${SERVER_NAME}] No tools registered yet`);
  }
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
