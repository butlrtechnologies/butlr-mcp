import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apolloClient } from "../clients/graphql-client.js";
import { gql } from "@apollo/client";
import { z } from "zod";
import type { Room, Zone } from "../clients/types.js";
import { getCurrentOccupancy } from "../clients/reporting-client.js";
import { getSingleAssetStats } from "../clients/stats-client.js";
import { executeSearchAssets } from "./butlr-search-assets.js";
import {
  buildBusynessSummary,
  getOccupancyLabel,
  getTrendLabel,
  getBusinessRecommendation,
  formatDayAndTime,
} from "../utils/natural-language.js";
import { getCachedOccupancy, setCachedOccupancy } from "../cache/occupancy-cache.js";
import { translateGraphQLError, formatMCPError } from "../errors/mcp-errors.js";

/**
 * Zod validation schema for butlr_space_busyness
 */

/** Shared shape — used by both registerTool (SDK schema) and full validation */
const spaceBusynessInputShape = {
  space_id_or_name: z
    .string()
    .min(1, "space_id_or_name cannot be empty")
    .max(200, "space_id_or_name too long (max: 200 chars)")
    .trim()
    .describe("Space ID (room_123) or search term ('café', 'lobby')"),

  include_trend: z
    .boolean()
    .default(true)
    .describe("Compare to typical occupancy for this day/time"),
};

export const SpaceBusynessArgsSchema = z.object(spaceBusynessInputShape).strict();

const SPACE_BUSYNESS_DESCRIPTION =
  "Get current occupancy busyness for any room or zone with qualitative labels (quiet/moderate/busy) and trend comparison vs. typical usage. Designed for employee experience apps, wayfinding kiosks, and workplace analytics. Helps employees make real-time decisions about where to work and helps workplace teams understand space demand patterns.\n\n" +
  "Primary Users:\n" +
  "- Workplace Manager: Monitor amenity usage (cafés, focus rooms, lounges), optimize space allocation, improve employee experience\n" +
  "- Employee/End User: Decide whether to visit café, find quiet focus areas, avoid crowded collaboration spaces\n" +
  "- Facilities Coordinator: Validate HVAC/cleaning schedules match actual occupancy patterns\n" +
  "- Portfolio Manager: Understand space demand during different times for densification analysis\n\n" +
  "Example Queries:\n" +
  '1. "How busy is the café right now? Should I go?"\n' +
  '2. "Is the 3rd floor collaboration zone crowded?"\n' +
  '3. "How full is the main lobby?"\n' +
  '4. "Is the fitness center busy compared to usual?"\n' +
  '5. "Check occupancy for Conference Room 401"\n' +
  '6. "Is the outdoor terrace busier than normal for Friday afternoon?"\n' +
  '7. "How crowded is the co-working area on Floor 2?"\n' +
  '8. "Is the cafeteria quiet enough for a phone call right now?"\n\n' +
  "When to Use:\n" +
  "- Real-time 'should I go there now?' recommendations for employees\n" +
  "- Understand if a space is busier or quieter than typical for this day/time\n" +
  "- Troubleshooting complaints about crowded amenities (café, gym, lounge)\n" +
  "- Validating right-sizing decisions ('Is this space too large/small for actual demand?')\n" +
  "- Optimizing cleaning or HVAC schedules based on actual occupancy\n\n" +
  "When NOT to Use:\n" +
  "- Precise occupancy counts for capacity planning → use butlr_get_current_occupancy for exact numbers\n" +
  "- Historical utilization patterns → use butlr_get_occupancy_timeseries for time series data\n" +
  "- Entry/exit traffic counts (lobby, building entrance) → use butlr_traffic_flow instead\n" +
  "- Searching for a space first → use butlr_search_assets to find room/zone ID by name\n\n" +
  "Qualitative Labels: Quiet (<30% utilized), Moderate (30-70%), Busy (70-90%), Very Busy (>90%)\n\n" +
  "See Also: butlr_get_current_occupancy, butlr_traffic_flow, butlr_search_assets, butlr_get_occupancy_timeseries";

/**
 * Input arguments (inferred from Zod schema)
 */
export type SpaceBusynessArgs = z.output<typeof SpaceBusynessArgsSchema>;

/**
 * GraphQL queries
 */
const GET_ROOM = gql`
  query GetRoom($roomId: ID!) {
    room(id: $roomId) {
      id
      name
      floorID
      roomType
      capacity {
        max
        mid
      }
      floor {
        id
        name
        building_id
        building {
          id
          name
          site_id
        }
      }
    }
  }
`;

const GET_ZONE = gql`
  query GetZone($zoneId: ID!) {
    zone(id: $zoneId) {
      id
      name
      floorID
      capacity {
        max
        mid
      }
      floor {
        id
        name
        building_id
        building {
          id
          name
          site_id
        }
      }
    }
  }
`;

/**
 * Execute space busyness tool
 */
export async function executeSpaceBusyness(args: SpaceBusynessArgs) {
  let spaceId = args.space_id_or_name;
  let spaceType: "room" | "zone" = "room";

  // If not an ID, search for the space
  if (!spaceId.match(/^(room|zone)_/)) {
    if (process.env.DEBUG) {
      console.error(`[space-busyness] Searching for space: "${args.space_id_or_name}"`);
    }

    const searchResults = await executeSearchAssets({
      query: args.space_id_or_name,
      asset_types: ["room", "zone"],
      max_results: 5,
    });

    if (searchResults.matches.length === 0) {
      throw new Error(
        `No spaces found matching "${args.space_id_or_name}". Try a different search term.`
      );
    }

    // Use best match
    const bestMatch = searchResults.matches[0];
    spaceId = bestMatch.id;
    spaceType = bestMatch.type as "room" | "zone";

    if (process.env.DEBUG) {
      console.error(`[space-busyness] Using best match: ${bestMatch.name} (${spaceId})`);
    }
  } else {
    // Determine type from ID prefix
    spaceType = spaceId.startsWith("room_") ? "room" : "zone";
  }

  // Query space details
  let space: any = null;
  let spacePath = "";

  try {
    if (spaceType === "room") {
      const result = await apolloClient.query<{ room: Room }>({
        query: GET_ROOM,
        variables: { roomId: spaceId },
        fetchPolicy: "network-only",
      });

      if (!result.data?.room) {
        throw new Error(`Room ${spaceId} not found`);
      }

      space = result.data.room;
      const floor = space.floor;
      const building = floor?.building;
      spacePath = building ? `${building.name} > ${floor.name} > ${space.name}` : space.name;
    } else {
      const result = await apolloClient.query<{ zone: Zone }>({
        query: GET_ZONE,
        variables: { zoneId: spaceId },
        fetchPolicy: "network-only",
      });

      if (!result.data?.zone) {
        throw new Error(`Zone ${spaceId} not found`);
      }

      space = result.data.zone;
      const floor = space.floor;
      const building = floor?.building;
      spacePath = building ? `${building.name} > ${floor.name} > ${space.name}` : space.name;
    }
  } catch (error: any) {
    if (error && (error.graphQLErrors || error.networkError)) {
      const mcpError = translateGraphQLError(error);
      const errorMessage = formatMCPError(mcpError);
      throw new Error(errorMessage);
    }
    throw error;
  }

  // Get current occupancy (check cache first)
  const now = new Date();
  let currentOccupancy = 0;

  const cached = getCachedOccupancy(spaceId, now);
  if (cached) {
    currentOccupancy = cached.occupancy;
    if (process.env.DEBUG) {
      console.error(`[space-busyness] Using cached occupancy: ${currentOccupancy}`);
    }
  } else {
    try {
      const occupancyData = await getCurrentOccupancy(spaceType, [spaceId]);
      if (occupancyData.length > 0) {
        currentOccupancy = occupancyData[0].value;
        setCachedOccupancy(spaceId, currentOccupancy, spaceType, now);
      }
    } catch (error: any) {
      console.error(`[space-busyness] Failed to get occupancy:`, error);
      throw new Error(
        `Failed to get current occupancy for ${space.name}. The space may not have active sensors.`
      );
    }
  }

  // Calculate utilization
  const capacity = space.capacity?.max && space.capacity.max > 0 ? space.capacity.max : 1;
  const utilizationPercent = (currentOccupancy / capacity) * 100;
  const label = getOccupancyLabel(utilizationPercent);

  // Build response
  const response: any = {
    space: {
      id: space.id,
      name: space.name,
      type: spaceType,
      path: spacePath,
    },
    current: {
      occupancy: Math.round(currentOccupancy),
      capacity: space.capacity,
      utilization_percent: parseFloat(utilizationPercent.toFixed(1)),
      label,
      as_of: now.toISOString(),
    },
    recommendation: getBusinessRecommendation(label),
    timestamp: now.toISOString(),
  };

  // Get trend if requested
  if (args.include_trend !== false) {
    try {
      // Query last 4 weeks of data
      const measurement = spaceType === "room" ? "room_occupancy" : "zone_occupancy";
      const stats = await getSingleAssetStats(measurement, spaceId, "-4w", "now");

      if (stats) {
        const typical = stats.mean;
        const vsTypicalPercent =
          typical > 0
            ? ((currentOccupancy - typical) / typical) * 100
            : currentOccupancy > 0
              ? 100
              : 0;
        const trendLabel = getTrendLabel(vsTypicalPercent);

        response.trend = {
          typical_for_time: parseFloat(typical.toFixed(1)),
          vs_typical_percent: parseFloat(vsTypicalPercent.toFixed(1)),
          trend_label: trendLabel,
          historical_context: `${formatDayAndTime(now)} avg: ${Math.round(typical)} people (last 4 weeks)`,
        };
      }
    } catch (error: any) {
      console.error(`[space-busyness] Failed to get trend data:`, error);
      response.warning =
        "Could not retrieve historical trend data. Trend comparison is unavailable.";
    }
  }

  // Build summary
  response.summary = buildBusynessSummary({
    spaceName: space.name,
    occupancy: Math.round(currentOccupancy),
    capacity,
    utilizationPercent,
    trendLabel: response.trend?.trend_label,
    dayTime: formatDayAndTime(now),
  });

  return response;
}

/**
 * Register butlr_space_busyness with an McpServer instance
 */
export function registerSpaceBusyness(server: McpServer): void {
  server.registerTool(
    "butlr_space_busyness",
    {
      title: "Space Busyness",
      description: SPACE_BUSYNESS_DESCRIPTION,
      inputSchema: spaceBusynessInputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const validated = SpaceBusynessArgsSchema.parse(args);
      const result = await executeSpaceBusyness(validated);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
