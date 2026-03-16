#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { validateToolArgs } from "./utils/validation.js";
import {
  searchAssetsTool,
  executeSearchAssets,
  SearchAssetsArgsSchema,
} from "./tools/search-assets.js";
import {
  getAssetDetailsTool,
  executeGetAssetDetails,
  GetAssetDetailsArgsSchema,
} from "./tools/get-asset-details.js";
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
import {
  listTopologyTool,
  executeListTopology,
  type ListTopologyArgs,
} from "./tools/butlr-list-topology.js";
import {
  fetchEntityDetailsTool,
  executeFetchEntityDetails,
  type FetchEntityDetailsArgs,
} from "./tools/butlr-fetch-entity-details.js";
// Legacy occupancy tools (temporarily disabled for testing)
// import {
//   trafficOccupancyTimeseriesToolTool,
//   executeTrafficOccupancyTimeseries,
//   type TrafficOccupancyTimeseriesArgs,
// } from "./tools/butlr-fetch-traffic-occupancy-timeseries.js";
// import {
//   presenceOccupancyTimeseriesToolTool,
//   executePresenceOccupancyTimeseries,
//   type PresenceOccupancyTimeseriesArgs,
// } from "./tools/butlr-fetch-presence-occupancy-timeseries.js";
// import {
//   currentTrafficOccupancyTool,
//   executeCurrentTrafficOccupancy,
//   type CurrentTrafficOccupancyArgs,
// } from "./tools/butlr-fetch-current-traffic-occupancy.js";
// import {
//   currentPresenceOccupancyTool,
//   executeCurrentPresenceOccupancy,
//   type CurrentPresenceOccupancyArgs,
// } from "./tools/butlr-fetch-current-presence-occupancy.js";

// NEW: Unified occupancy tools with timezone support
import {
  getOccupancyTimeseriesTool,
  executeGetOccupancyTimeseries,
  type GetOccupancyTimeseriesArgs,
} from "./tools/butlr-get-occupancy-timeseries.js";
import {
  getCurrentOccupancyTool,
  executeGetCurrentOccupancy,
  type GetCurrentOccupancyArgs,
} from "./tools/butlr-get-current-occupancy.js";

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
 * Handler for listing available tools
 */
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
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
      // NEW: Unified occupancy tools with timezone support
      getOccupancyTimeseriesTool,
      getCurrentOccupancyTool,
      // Legacy occupancy tools (temporarily unregistered for testing)
      // trafficOccupancyTimeseriesToolTool,
      // presenceOccupancyTimeseriesToolTool,
      // currentTrafficOccupancyTool,
      // currentPresenceOccupancyTool,
    ],
  };
});

/**
 * Handler for tool execution
 */
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result: any;

    // Tier 1: Conversational Tools
    if (name === "butlr_hardware_snapshot") {
      const validated = validateToolArgs(HardwareSnapshotArgsSchema, args) as any;
      result = await executeHardwareSnapshot(validated);
    } else if (name === "butlr_available_rooms") {
      const validated = validateToolArgs(AvailableRoomsArgsSchema, args) as any;
      result = await executeAvailableRooms(validated);
    } else if (name === "butlr_space_busyness") {
      const validated = validateToolArgs(SpaceBusynessArgsSchema, args) as any;
      result = await executeSpaceBusyness(validated);
    } else if (name === "butlr_traffic_flow") {
      const validated = validateToolArgs(TrafficFlowArgsSchema, args) as any;
      result = await executeTrafficFlow(validated);
    }
    // Tier 2: Data Tools
    else if (name === "search_assets") {
      const validated = validateToolArgs(SearchAssetsArgsSchema, args) as any;
      result = await executeSearchAssets(validated);
    } else if (name === "get_asset_details") {
      const validated = validateToolArgs(GetAssetDetailsArgsSchema, args) as any;
      result = await executeGetAssetDetails(validated);
    }
    // Tier 3: Foundation Tools
    else if (name === "butlr_list_topology") {
      result = await executeListTopology(args as any as ListTopologyArgs);
    } else if (name === "butlr_fetch_entity_details") {
      result = await executeFetchEntityDetails(args as any as FetchEntityDetailsArgs);
    }
    // NEW: Unified occupancy tools
    else if (name === "butlr_get_occupancy_timeseries") {
      result = await executeGetOccupancyTimeseries(args as any as GetOccupancyTimeseriesArgs);
    } else if (name === "butlr_get_current_occupancy") {
      result = await executeGetCurrentOccupancy(args as any as GetCurrentOccupancyArgs);
    }
    // Legacy occupancy tools (temporarily disabled)
    // else if (name === "butlr_fetch_traffic_occupancy_timeseries") {
    //   result = await executeTrafficOccupancyTimeseries(
    //     args as any as TrafficOccupancyTimeseriesArgs
    //   );
    // } else if (name === "butlr_fetch_presence_occupancy_timeseries") {
    //   result = await executePresenceOccupancyTimeseries(
    //     args as any as PresenceOccupancyTimeseriesArgs
    //   );
    // } else if (name === "butlr_fetch_current_traffic_occupancy") {
    //   result = await executeCurrentTrafficOccupancy(
    //     args as any as CurrentTrafficOccupancyArgs
    //   );
    // } else if (name === "butlr_fetch_current_presence_occupancy") {
    //   result = await executeCurrentPresenceOccupancy(
    //     args as any as CurrentPresenceOccupancyArgs
    //   );
    // }
    else {
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
    console.error(
      `[${SERVER_NAME}] Available tools: 10 total (4 conversational + 2 data + 4 foundation)`
    );
    console.error(
      `[${SERVER_NAME}] - Tier 1 (Conversational): butlr_hardware_snapshot, butlr_available_rooms, butlr_space_busyness, butlr_traffic_flow`
    );
    console.error(`[${SERVER_NAME}] - Tier 2 (Data): search_assets, get_asset_details`);
    console.error(
      `[${SERVER_NAME}] - Tier 3 (Foundation): butlr_list_topology, butlr_fetch_entity_details, butlr_get_occupancy_timeseries, butlr_get_current_occupancy`
    );
    console.error(
      `[${SERVER_NAME}] - Legacy tools temporarily disabled: 4 separate occupancy tools`
    );
  }
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
