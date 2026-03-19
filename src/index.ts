#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { validateToolArgs } from "./utils/validation.js";
import {
  searchAssetsTool,
  executeSearchAssets,
  SearchAssetsArgsSchema,
} from "./tools/butlr-search-assets.js";
import {
  getAssetDetailsTool,
  executeGetAssetDetails,
  GetAssetDetailsArgsSchema,
} from "./tools/butlr-get-asset-details.js";
import {
  hardwareSnapshotTool,
  executeHardwareSnapshot,
  HardwareSnapshotArgsSchema,
} from "./tools/butlr-hardware-snapshot.js";

const SERVER_NAME = "butlr-mcp-server";
const SERVER_VERSION = "0.1.0";

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } }
);

const allTools = [searchAssetsTool, getAssetDetailsTool, hardwareSnapshotTool];

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: allTools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: unknown;

    switch (name) {
      case "butlr_search_assets": {
        const validated = validateToolArgs(SearchAssetsArgsSchema, args);
        result = await executeSearchAssets(validated);
        break;
      }
      case "butlr_get_asset_details": {
        const validated = validateToolArgs(GetAssetDetailsArgsSchema, args);
        result = await executeGetAssetDetails(validated);
        break;
      }
      case "butlr_hardware_snapshot": {
        const validated = validateToolArgs(HardwareSnapshotArgsSchema, args);
        result = await executeHardwareSnapshot(validated);
        break;
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (error) {
    if (process.env.DEBUG) {
      console.error(`[${SERVER_NAME}] Error executing ${name}:`, error);
    }

    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (process.env.DEBUG === "butlr-mcp" || process.env.DEBUG === "*") {
    console.error(`[${SERVER_NAME}] Server started on stdio transport`);
    console.error(`[${SERVER_NAME}] Version: ${SERVER_VERSION}`);
    console.error(`[${SERVER_NAME}] Available tools: ${allTools.length}`);
  }
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
