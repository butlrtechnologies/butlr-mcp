#!/usr/bin/env node
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerSearchAssets } from "./tools/butlr-search-assets.js";
import { registerGetAssetDetails } from "./tools/butlr-get-asset-details.js";
import { registerHardwareSnapshot } from "./tools/butlr-hardware-snapshot.js";
import { registerAvailableRooms } from "./tools/butlr-available-rooms.js";
import { registerSpaceBusyness } from "./tools/butlr-space-busyness.js";
import { registerTrafficFlow } from "./tools/butlr-traffic-flow.js";
import { registerListTopology } from "./tools/butlr-list-topology.js";
import { registerFetchEntityDetails } from "./tools/butlr-fetch-entity-details.js";
import { registerGetOccupancyTimeseries } from "./tools/butlr-get-occupancy-timeseries.js";
import { registerGetCurrentOccupancy } from "./tools/butlr-get-current-occupancy.js";
import { registerListTags } from "./tools/butlr-list-tags.js";
import { debug } from "./utils/debug.js";

const require = createRequire(import.meta.url);
const { version: SERVER_VERSION } = require("../package.json") as { version: string };

const SERVER_NAME = "butlr-mcp-server";

const server = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

// Register all tools
registerSearchAssets(server);
registerGetAssetDetails(server);
registerHardwareSnapshot(server);
registerAvailableRooms(server);
registerSpaceBusyness(server);
registerTrafficFlow(server);
registerListTopology(server);
registerFetchEntityDetails(server);
registerGetOccupancyTimeseries(server);
registerGetCurrentOccupancy(server);
registerListTags(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  debug(SERVER_NAME, "Server started on stdio transport");
  debug(SERVER_NAME, `Version: ${SERVER_VERSION}`);
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
