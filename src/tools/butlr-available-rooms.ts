import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apolloClient } from "../clients/graphql-client.js";
import { gql } from "@apollo/client";
import { z } from "zod";
import type { Room, Building, Floor } from "../clients/types.js";
import { getCurrentOccupancy } from "../clients/reporting-client.js";
import { buildAvailableRoomsSummary } from "../utils/natural-language.js";
import { getCachedOccupancy, setBulkCachedOccupancy } from "../cache/occupancy-cache.js";
import { rethrowIfGraphQLError } from "../utils/graphql-helpers.js";
import type { AvailableRoom, AvailableRoomsResponse, BuildingContext } from "../types/responses.js";
import { debug } from "../utils/debug.js";
import { withToolErrorHandling } from "../errors/mcp-errors.js";

/** Shared shape — used by both registerTool (SDK schema) and full validation */
const availableRoomsInputShape = {
  min_capacity: z
    .number()
    .int("min_capacity must be an integer")
    .min(1, "min_capacity must be at least 1 person")
    .max(10000)
    .optional()
    .describe("Minimum room capacity"),

  max_capacity: z
    .number()
    .int("max_capacity must be an integer")
    .min(1, "max_capacity must be at least 1 person")
    .max(10000)
    .optional()
    .describe("Maximum room capacity"),

  tags: z
    .array(z.string().min(1, "Tag cannot be empty").trim())
    .min(1, "tags array cannot be empty")
    .optional()
    .describe("Filter by room tags"),

  building_id: z
    .string()
    .regex(/^building_[a-zA-Z0-9_-]+$/, "building_id must match pattern: 'building_<id>'")
    .optional()
    .describe("Limit to specific building"),

  floor_id: z
    .string()
    .regex(
      /^(floor|space)_[a-zA-Z0-9_-]+$/,
      "floor_id must match pattern: 'floor_<id>' or 'space_<id>'"
    )
    .optional()
    .describe("Limit to specific floor"),

  max_results: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(50)
    .describe("Maximum rooms to return (default: 50)"),
};

export const AvailableRoomsArgsSchema = z
  .object(availableRoomsInputShape)
  .strict()
  .refine(
    (data) => {
      if (data.min_capacity !== undefined && data.max_capacity !== undefined) {
        return data.min_capacity <= data.max_capacity;
      }
      return true;
    },
    {
      message: "min_capacity cannot be greater than max_capacity",
      path: ["min_capacity"],
    }
  );

const AVAILABLE_ROOMS_DESCRIPTION =
  "Find meeting rooms and collaboration spaces currently unoccupied (occupancy = 0), with optional filters for capacity and room tags. Designed for workplace experience teams and hoteling/room booking integrations. Returns real-time availability based on last 5 minutes of occupancy data.\n\n" +
  "Primary Users:\n" +
  "- Workplace Manager: Monitor meeting room availability, optimize room booking systems, improve employee experience\n" +
  "- Executive Assistant: Find available conference rooms for urgent meetings, check capacity for client visits\n" +
  "- Facilities Coordinator: Validate room availability before events, troubleshoot booking system discrepancies\n" +
  "- Portfolio Manager: Assess meeting room utilization vs. demand, identify underutilized rooms for right-sizing\n\n" +
  "Example Queries:\n" +
  '1. "Are there any conference rooms free right now in Building 3?"\n' +
  '2. "Find available rooms with capacity for at least 8 people"\n' +
  '3. "Show me available video-equipped conference rooms"\n' +
  '4. "Which meeting rooms on Floor 6 are currently empty?"\n' +
  '5. "Find available flex spaces or collaboration areas"\n' +
  '6. "Are there any private focus rooms available (capacity 1-2)?"\n' +
  '7. "Show me all empty rooms in the San Francisco office"\n' +
  '8. "Find available rooms between 6-12 person capacity"\n\n' +
  "When to Use:\n" +
  "- Real-time room availability for immediate use (next 5-10 minutes)\n" +
  "- Filter by capacity (e.g., rooms for 6-8 people)\n" +
  "- Filter by room types using tags (conference, collaboration, focus)\n" +
  "- Validating room booking system accuracy against actual occupancy\n" +
  "- Analyzing meeting room demand vs. supply across buildings/floors\n\n" +
  "When NOT to Use:\n" +
  "- Future availability predictions → this tool shows current state only\n" +
  "- Understanding why rooms are underutilized → use butlr_space_busyness or timeseries data\n" +
  "- Analyzing utilization patterns over time → use butlr_get_occupancy_timeseries\n" +
  "- Booking/reserving rooms → this is read-only; integrate with your booking system\n\n" +
  "CRE Context: Meeting rooms are expensive real estate (avg $150-300/sqft in Class A offices). This tool helps validate booking system accuracy and identify 'ghost bookings' (booked but unused).\n\n" +
  "See Also: butlr_space_busyness, butlr_get_occupancy_timeseries, butlr_search_assets";

export type AvailableRoomsArgs = z.output<typeof AvailableRoomsArgsSchema>;

const GET_ROOMS_BY_FLOOR = gql`
  query GetRoomsByFloor($floorId: ID!) {
    floor(id: $floorId) {
      id
      name
      building_id
      rooms {
        id
        name
        floorID
        roomType
        capacity {
          max
          mid
        }
        area {
          value
          unit
        }
        coordinates
        customID
      }
      building {
        id
        name
        site_id
      }
    }
  }
`;

const GET_ROOMS_BY_BUILDING = gql`
  query GetRoomsByBuilding($buildingId: ID!) {
    building(id: $buildingId) {
      id
      name
      site_id
      floors {
        id
        name
        building_id
        rooms {
          id
          name
          floorID
          roomType
          capacity {
            max
            mid
          }
          area {
            value
            unit
          }
          coordinates
          customID
        }
      }
    }
  }
`;

const GET_ROOMS_BY_TAG = gql`
  query GetRoomsByTag($tags: [String!]!) {
    roomsByTag(tags: $tags) {
      id
      name
      floorID
      roomType
      capacity {
        max
        mid
      }
      area {
        value
        unit
      }
      coordinates
      customID
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

const GET_ALL_ROOMS = gql`
  query GetAllRooms {
    sites {
      data {
        id
        name
        buildings {
          id
          name
          site_id
          floors {
            id
            name
            building_id
            rooms {
              id
              name
              floorID
              roomType
              capacity {
                max
                mid
              }
              area {
                value
                unit
              }
              coordinates
              customID
            }
          }
        }
      }
    }
  }
`;

/**
 * Execute available rooms tool
 */
export async function executeAvailableRooms(args: AvailableRoomsArgs) {
  debug("available-rooms", "Finding available rooms with filters:", JSON.stringify(args, null, 2));

  // Query rooms based on scope
  let rooms: Room[] = [];
  let buildings: Building[] = [];
  let floors: Floor[] = [];

  try {
    if (args.floor_id) {
      // Query specific floor
      const result = await apolloClient.query<{ floor: Floor }>({
        query: GET_ROOMS_BY_FLOOR,
        variables: { floorId: args.floor_id },
        fetchPolicy: "network-only",
      });

      if (!result.data?.floor) {
        throw new Error(`Floor ${args.floor_id} not found`);
      }

      rooms = result.data.floor.rooms || [];
      floors = [result.data.floor];
      buildings = result.data.floor.building ? [result.data.floor.building] : [];
    } else if (args.building_id) {
      // Query specific building
      const result = await apolloClient.query<{ building: Building }>({
        query: GET_ROOMS_BY_BUILDING,
        variables: { buildingId: args.building_id },
        fetchPolicy: "network-only",
      });

      if (!result.data?.building) {
        throw new Error(`Building ${args.building_id} not found`);
      }

      buildings = [result.data.building];
      floors = result.data.building.floors || [];
      rooms = floors.flatMap((f) => f.rooms || []);
    } else if (args.tags && args.tags.length > 0) {
      // Query by tags
      const result = await apolloClient.query<{ roomsByTag: Room[] }>({
        query: GET_ROOMS_BY_TAG,
        variables: { tags: args.tags },
        fetchPolicy: "network-only",
      });

      if (!result.data?.roomsByTag) {
        throw new Error("Invalid response structure from API");
      }

      rooms = result.data.roomsByTag;

      // Extract floors and buildings from room.floor references
      for (const room of rooms) {
        if (room.floor) {
          floors.push(room.floor);
          if (room.floor.building) {
            buildings.push(room.floor.building);
          }
        }
      }
    } else {
      // Query all rooms (org-wide)
      const result = await apolloClient.query<{
        sites: { data: { buildings: Building[] }[] };
      }>({
        query: GET_ALL_ROOMS,
        fetchPolicy: "network-only",
      });

      if (!result.data?.sites?.data) {
        throw new Error("Invalid response structure from API");
      }

      buildings = result.data.sites.data.flatMap((s) => s.buildings || []);
      floors = buildings.flatMap((b) => b.floors || []);
      rooms = floors.flatMap((f) => f.rooms || []);
    }
  } catch (error: unknown) {
    rethrowIfGraphQLError(error);
    throw error;
  }

  debug("available-rooms", `Found ${rooms.length} rooms before filtering`);

  // Apply capacity filters and track rooms excluded due to missing capacity data
  const warnings: string[] = [];

  if (args.min_capacity !== undefined || args.max_capacity !== undefined) {
    const roomsWithoutCapacity = rooms.filter((r) => !r.capacity?.max).length;

    const minCapacity = args.min_capacity;
    if (minCapacity !== undefined) {
      rooms = rooms.filter((r) => r.capacity?.max && r.capacity.max >= minCapacity);
    }

    const maxCapacity = args.max_capacity;
    if (maxCapacity !== undefined) {
      rooms = rooms.filter((r) => r.capacity?.max && r.capacity.max <= maxCapacity);
    }

    if (roomsWithoutCapacity > 0) {
      warnings.push(
        `${roomsWithoutCapacity} room(s) excluded because they have no capacity data configured.`
      );
    }
  }

  if (rooms.length === 0) {
    // No rooms match filters — unified return shape
    const response: AvailableRoomsResponse = {
      summary: buildAvailableRoomsSummary({
        count: 0,
        roomType: args.tags?.[0],
      }),
      available_rooms: [],
      total_available: 0,
      showing: 0,
      timestamp: new Date().toISOString(),
    };

    if (Object.keys(args).length > 0) {
      response.filtered_by = args;
    }

    if (warnings.length > 0) {
      response.warning = warnings.join(" ");
    }

    return response;
  }

  // Get current occupancy for all rooms
  const roomIds = rooms.map((r) => r.id);

  debug("available-rooms", `Querying occupancy for ${roomIds.length} rooms`);

  // Check cache first
  const now = new Date();
  const occupancyMap: Record<string, number> = {};

  for (const roomId of roomIds) {
    const cached = getCachedOccupancy(roomId, now);
    if (cached) {
      occupancyMap[roomId] = cached.occupancy;
    }
  }

  // Query uncached rooms
  const uncachedRoomIds = roomIds.filter((id) => !(id in occupancyMap));
  let occupancyFetchFailed = false;

  if (uncachedRoomIds.length > 0) {
    debug("available-rooms", `Cache miss for ${uncachedRoomIds.length} rooms, querying API`);

    try {
      const occupancyData = await getCurrentOccupancy("room", uncachedRoomIds);

      // Store in occupancy map and cache
      const cacheEntries = [];
      for (const point of occupancyData) {
        if (point.asset_id) {
          occupancyMap[point.asset_id] = point.value;
          cacheEntries.push({
            assetId: point.asset_id,
            occupancy: point.value,
            assetType: "room",
            timestamp: new Date(point.start),
          });
        }
      }

      setBulkCachedOccupancy(cacheEntries);
    } catch (error: unknown) {
      debug("available-rooms", "Failed to get occupancy data:", error);
      occupancyFetchFailed = true;
    }
  }

  // When occupancy fetch failed and we have no cached data, we cannot determine availability
  if (occupancyFetchFailed && Object.keys(occupancyMap).length === 0) {
    throw new Error(
      "Unable to determine room availability: occupancy data fetch failed and no cached data is available. " +
        "Please retry or check the Butlr reporting API status."
    );
  }

  // Filter to available rooms — only include rooms with confirmed zero occupancy
  // (exclude rooms with no data)
  const availableRooms: AvailableRoom[] = [];

  for (const room of rooms) {
    const occupancy = occupancyMap[room.id] ?? null;

    if (occupancy === 0) {
      // Build path
      const floor = floors.find((f) => f.id === room.floorID);
      const building = floor ? buildings.find((b) => b.id === floor.building_id) : null;

      let path = room.name;
      if (floor) {
        path = `${floor.name} > ${room.name}`;
        if (building) {
          path = `${building.name} > ${path}`;
        }
      }

      availableRooms.push({
        id: room.id,
        name: room.name,
        path,
        capacity: room.capacity,
        area: room.area,
        data_window_minutes: 5,
      });
    }
  }

  // If occupancy fetch partially failed, note how many rooms have no data
  if (occupancyFetchFailed) {
    const roomsWithoutData = rooms.filter((r) => !(r.id in occupancyMap)).length;
    if (roomsWithoutData > 0) {
      warnings.push(
        `Occupancy data unavailable for ${roomsWithoutData} room(s). ` +
          `Only rooms with confirmed zero occupancy are shown.`
      );
    }
  }

  debug("available-rooms", `${availableRooms.length} rooms available (occupancy=0)`);

  // Sort by capacity (largest first) and limit results
  availableRooms.sort((a, b) => (b.capacity?.max || 0) - (a.capacity?.max || 0));
  const totalAvailable = availableRooms.length;
  const maxResults = args.max_results ?? 50;
  const limitedRooms = availableRooms.slice(0, maxResults);

  // Calculate capacity range
  const capacities = availableRooms
    .map((r) => r.capacity?.max)
    .filter((c) => c !== undefined) as number[];
  const minCap = capacities.length > 0 ? Math.min(...capacities) : undefined;
  const maxCap = capacities.length > 0 ? Math.max(...capacities) : undefined;

  // Build building context if applicable
  let buildingContext: BuildingContext | undefined;
  if (args.building_id) {
    const building = buildings.find((b) => b.id === args.building_id);
    if (building) {
      const totalRooms = rooms.length;
      const occupiedRooms = totalRooms - availableRooms.length;
      const occupancyPercent = totalRooms > 0 ? Math.round((occupiedRooms / totalRooms) * 100) : 0;

      buildingContext = {
        building_name: building.name,
        total_rooms: totalRooms,
        available_rooms: availableRooms.length,
        occupancy_percent: occupancyPercent,
      };
    }
  }

  // Build summary
  const summary = buildAvailableRoomsSummary({
    count: limitedRooms.length,
    roomType: args.tags?.[0],
    minCapacity: minCap,
    maxCapacity: maxCap,
  });

  // Build response
  const response: AvailableRoomsResponse = {
    summary,
    available_rooms: limitedRooms,
    total_available: totalAvailable,
    showing: limitedRooms.length,
    timestamp: new Date().toISOString(),
  };

  if (Object.keys(args).length > 0) {
    response.filtered_by = args;
  }

  if (buildingContext) {
    response.building_context = buildingContext;
  }

  if (occupancyFetchFailed) {
    warnings.push(
      "Could not retrieve real-time occupancy data for all rooms. Room availability may be incomplete."
    );
  }

  if (warnings.length > 0) {
    response.warning = warnings.join(" ");
  }

  return response;
}

/**
 * Register butlr_available_rooms with an McpServer instance
 */
export function registerAvailableRooms(server: McpServer): void {
  server.registerTool(
    "butlr_available_rooms",
    {
      title: "Available Rooms",
      description: AVAILABLE_ROOMS_DESCRIPTION,
      inputSchema: availableRoomsInputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    withToolErrorHandling(async (args) => {
      const validated = AvailableRoomsArgsSchema.parse(args);
      const result = await executeAvailableRooms(validated);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    })
  );
}
