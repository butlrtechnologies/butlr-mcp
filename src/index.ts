#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
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
import {
  availableRoomsTool,
  executeAvailableRooms,
  AvailableRoomsArgsSchema,
} from "./tools/butlr-available-rooms.js";
import {
  spaceBusynessTool,
  executeSpaceBusyness,
  SpaceBusynessArgsSchema,
} from "./tools/butlr-space-busyness.js";
import {
  trafficFlowTool,
  executeTrafficFlow,
  TrafficFlowArgsSchema,
} from "./tools/butlr-traffic-flow.js";
import { listTopologyTool, executeListTopology } from "./tools/butlr-list-topology.js";
import {
  fetchEntityDetailsTool,
  executeFetchEntityDetails,
} from "./tools/butlr-fetch-entity-details.js";
import {
  getOccupancyTimeseriesTool,
  executeGetOccupancyTimeseries,
} from "./tools/butlr-get-occupancy-timeseries.js";
import {
  getCurrentOccupancyTool,
  executeGetCurrentOccupancy,
} from "./tools/butlr-get-current-occupancy.js";

/**
 * Zod schemas for Tier 3 foundation tools
 */
const ListTopologyArgsSchema = z
  .object({
    asset_ids: z
      .array(z.string())
      .optional()
      .describe("Optional: Parent asset IDs to show tree for. If empty, shows all sites."),
    starting_depth: z
      .number()
      .int()
      .min(0)
      .max(5)
      .default(0)
      .describe(
        "Depth level to start showing assets. 0=sites, 1=buildings, 2=floors, 3=rooms/zones, 4=hives, 5=sensors."
      ),
    traversal_depth: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("How many levels below starting_depth to traverse. 0=starting level only."),
  })
  .strict();

const FetchEntityDetailsArgsSchema = z
  .object({
    ids: z
      .array(z.string().min(1))
      .min(1, "ids must contain at least 1 entity ID")
      .describe("Entity IDs (mixed types supported)"),
    site_fields: z.array(z.string()).optional().describe("Fields to fetch for sites"),
    building_fields: z.array(z.string()).optional().describe("Fields to fetch for buildings"),
    floor_fields: z.array(z.string()).optional().describe("Fields to fetch for floors"),
    room_fields: z.array(z.string()).optional().describe("Fields to fetch for rooms"),
    zone_fields: z.array(z.string()).optional().describe("Fields to fetch for zones"),
    sensor_fields: z.array(z.string()).optional().describe("Fields to fetch for sensors"),
    hive_fields: z.array(z.string()).optional().describe("Fields to fetch for hives"),
  })
  .strict();

const GetOccupancyTimeseriesArgsSchema = z
  .object({
    asset_ids: z
      .array(z.string().min(1))
      .min(1, "asset_ids must contain at least 1 ID")
      .describe("Floor, room, or zone IDs"),
    interval: z
      .enum(["1m", "1h", "1d"])
      .describe("Aggregation interval (1m=max 1hr range, 1h=max 48hrs, 1d=max 60 days)"),
    start: z.string().min(1).describe("ISO-8601 timestamp or relative time (e.g., '-24h')"),
    stop: z.string().min(1).describe("ISO-8601 timestamp or relative time (e.g., 'now')"),
  })
  .strict();

const GetCurrentOccupancyArgsSchema = z
  .object({
    asset_ids: z
      .array(z.string().min(1))
      .min(1, "asset_ids must contain at least 1 ID")
      .describe("Floor, room, or zone IDs"),
  })
  .strict();

const SERVER_NAME = "butlr-mcp-server";
const SERVER_VERSION = "0.1.0";

/**
 * Main MCP server instance
 */
const server = new Server(
  {
    name: SERVER_NAME,
    version: SERVER_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

/**
 * All registered tools
 */
const allTools = [
  // Tier 1: Conversational Tools
  hardwareSnapshotTool,
  availableRoomsTool,
  spaceBusynessTool,
  trafficFlowTool,
  // Tier 2: Data Tools
  searchAssetsTool,
  getAssetDetailsTool,
  // Tier 3: Foundation Tools (validation/debugging)
  listTopologyTool,
  fetchEntityDetailsTool,
  getOccupancyTimeseriesTool,
  getCurrentOccupancyTool,
];

/**
 * Handler for listing available tools
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: allTools,
  };
});

/**
 * Handler for tool execution
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: any;

    switch (name) {
      // Tier 1: Conversational Tools
      case "butlr_hardware_snapshot": {
        const validated = validateToolArgs(HardwareSnapshotArgsSchema, args);
        result = await executeHardwareSnapshot(validated);
        break;
      }
      case "butlr_available_rooms": {
        const validated = validateToolArgs(AvailableRoomsArgsSchema, args);
        result = await executeAvailableRooms(validated);
        break;
      }
      case "butlr_space_busyness": {
        const validated = validateToolArgs(SpaceBusynessArgsSchema, args);
        result = await executeSpaceBusyness(validated);
        break;
      }
      case "butlr_traffic_flow": {
        const validated = validateToolArgs(TrafficFlowArgsSchema, args);
        result = await executeTrafficFlow(validated);
        break;
      }

      // Tier 2: Data Tools
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

      // Tier 3: Foundation Tools
      case "butlr_list_topology": {
        const validated = validateToolArgs(ListTopologyArgsSchema, args);
        result = await executeListTopology(validated);
        break;
      }
      case "butlr_fetch_entity_details": {
        const validated = validateToolArgs(FetchEntityDetailsArgsSchema, args);
        result = await executeFetchEntityDetails(validated);
        break;
      }
      case "butlr_get_occupancy_timeseries": {
        const validated = validateToolArgs(GetOccupancyTimeseriesArgsSchema, args);
        result = await executeGetOccupancyTimeseries(validated);
        break;
      }
      case "butlr_get_current_occupancy": {
        const validated = validateToolArgs(GetCurrentOccupancyArgsSchema, args);
        result = await executeGetCurrentOccupancy(validated);
        break;
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    // Log error for debugging
    if (process.env.DEBUG) {
      console.error(`[${SERVER_NAME}] Error executing ${name}:`, error);
    }

    // Return error to client
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

/**
 * Start the server
 */
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Enable debug logging if DEBUG env var is set
  if (process.env.DEBUG === "butlr-mcp" || process.env.DEBUG === "*") {
    console.error(`[${SERVER_NAME}] Server started on stdio transport`);
    console.error(`[${SERVER_NAME}] Version: ${SERVER_VERSION}`);
    console.error(`[${SERVER_NAME}] Available tools: ${allTools.length} total`);
    console.error(
      `[${SERVER_NAME}] - Tier 1 (Conversational): butlr_hardware_snapshot, butlr_available_rooms, butlr_space_busyness, butlr_traffic_flow`
    );
    console.error(`[${SERVER_NAME}] - Tier 2 (Data): butlr_search_assets, butlr_get_asset_details`);
    console.error(
      `[${SERVER_NAME}] - Tier 3 (Foundation): butlr_list_topology, butlr_fetch_entity_details, butlr_get_occupancy_timeseries, butlr_get_current_occupancy`
    );
  }
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
