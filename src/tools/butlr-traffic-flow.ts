import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apolloClient } from "../clients/graphql-client.js";
import { gql } from "@apollo/client";
import { z } from "zod";
import type { Room, Site, Sensor } from "../clients/types.js";
import { ReportingRequestBuilder } from "../clients/reporting-client.js";
import { GET_ALL_SENSORS, GET_FULL_TOPOLOGY } from "../clients/queries/topology.js";
import { executeSearchAssets } from "./butlr-search-assets.js";
import {
  getTimezoneForAsset,
  buildTimezoneMetadata,
  getLocalMidnight,
} from "../utils/timezone-helpers.js";
import type { TimezoneMetadata } from "../utils/timezone-helpers.js";
import { createValidationError } from "../errors/mcp-errors.js";
import { rethrowIfGraphQLError } from "../utils/graphql-helpers.js";
import type { TrafficFlowResponse } from "../types/responses.js";

const timeStringSchema = z.string().refine(
  (val) => {
    const isoMatch = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?$/.test(val);
    const relativeMatch = /^-\d+[dhm]$/.test(val);
    const isNow = val === "now";
    return isoMatch || relativeMatch || isNow;
  },
  {
    message:
      "Time must be ISO-8601 format (2025-01-15T10:00:00Z), relative (-24h, -7d, -30m), or 'now'",
  }
);

/** Shared shape — used by both registerTool (SDK schema) and full validation */
const trafficFlowInputShape = {
  space_id_or_name: z
    .string()
    .min(1, "space_id_or_name cannot be empty")
    .max(200)
    .trim()
    .describe("Space ID or search term"),

  time_window: z
    .enum(["20m", "1h", "today", "custom"])
    .default("today")
    .describe("Time period for traffic count"),

  custom_start: z
    .string()
    .pipe(timeStringSchema)
    .optional()
    .describe("Custom start time (ISO-8601 or relative '-24h'). Required if time_window='custom'"),

  custom_stop: z
    .string()
    .pipe(timeStringSchema)
    .optional()
    .describe("Custom stop time. Defaults to 'now'"),
};

export const TrafficFlowArgsSchema = z
  .object(trafficFlowInputShape)
  .strict()
  .refine(
    (data) => {
      if (data.time_window === "custom" && !data.custom_start) {
        return false;
      }
      return true;
    },
    {
      message: "custom_start is required when time_window='custom'",
      path: ["custom_start"],
    }
  );

const TRAFFIC_FLOW_DESCRIPTION =
  "Get entry and exit counts for spaces equipped with traffic-mode sensors (typically lobbies, building entrances, elevator banks). Returns total movements, net flow (entries - exits), and hourly breakdown in the space's local timezone. Designed for space activation analysis, security/compliance, and amenity demand forecasting.\n\n" +
  "Primary Users:\n" +
  "- Facilities Manager: Monitor building entry/exit patterns, optimize security staffing, validate badge system accuracy\n" +
  "- Workplace Manager: Understand amenity traffic (café, gym, event spaces), measure activation of new spaces\n" +
  "- Portfolio Manager: Analyze building utilization patterns for lease negotiations, assess occupancy vs. leased capacity\n" +
  "- Security/Compliance: Validate occupancy limits for fire code compliance, monitor after-hours access\n\n" +
  "Example Queries:\n" +
  '1. "How many people entered the main lobby today?"\n' +
  '2. "Show me entry/exit counts for the café in the last hour"\n' +
  '3. "What was the peak traffic hour for Building 3 entrance today?"\n' +
  '4. "How many people visited the fitness center yesterday?"\n' +
  '5. "Show me lobby traffic for the last 20 minutes"\n' +
  '6. "What\'s the net flow (entries - exits) for Floor 2 today?"\n' +
  '7. "How many people entered the event space during lunch hour (12-1pm)?"\n' +
  '8. "Compare today\'s building entrance traffic to typical Monday"\n\n' +
  "When to Use:\n" +
  "- Entry/exit counts for lobbies, building entrances, elevator banks, or amenities\n" +
  "- Understand peak traffic hours for security, cleaning, or HVAC planning\n" +
  "- Validate badge system accuracy against actual sensor counts\n" +
  "- Measure activation/adoption of new spaces or amenities\n" +
  "- Analyze compliance with occupancy limits (fire code, COVID density restrictions)\n\n" +
  "When NOT to Use:\n" +
  "- Current occupancy count (people currently in space) → use butlr_get_current_occupancy or butlr_space_busyness\n" +
  "- Rooms without traffic-mode sensors → use butlr_get_current_occupancy (presence mode)\n" +
  "- Spaces that don't have entry/exit chokepoints → traffic mode requires defined entrances\n\n" +
  "CRE Context: Traffic counts are movements, not unique people - one person exiting/re-entering counts as 2 movements. Net flow helps detect sensor calibration issues (large negative net flow might indicate misconfigured entry/exit sensors).\n\n" +
  "See Also: butlr_get_current_occupancy, butlr_space_busyness, butlr_search_assets, butlr_get_asset_details";

export type TrafficFlowArgs = z.output<typeof TrafficFlowArgsSchema>;

const GET_ROOM_SENSORS = gql`
  query GetRoomSensors($roomId: ID!) {
    room(id: $roomId) {
      id
      name
      floorID
      sensors {
        id
        mode
      }
      floor {
        id
        name
        building {
          id
          name
        }
      }
    }
  }
`;

/**
 * Execute traffic flow tool
 */
export async function executeTrafficFlow(args: TrafficFlowArgs) {
  let spaceId = args.space_id_or_name;

  // If not an ID, search for the space
  if (!spaceId.match(/^room_/)) {
    if (process.env.DEBUG) {
      console.error(`[traffic-flow] Searching for space: "${args.space_id_or_name}"`);
    }

    const searchResults = await executeSearchAssets({
      query: args.space_id_or_name,
      asset_types: ["room"], // Traffic is room-level
      max_results: 5,
    });

    if (searchResults.matches.length === 0) {
      throw new Error(
        `No rooms found matching "${args.space_id_or_name}". Try a different search term.`
      );
    }

    spaceId = searchResults.matches[0].id;

    if (process.env.DEBUG) {
      console.error(
        `[traffic-flow] Using best match: ${searchResults.matches[0].name} (${spaceId})`
      );
    }
  }

  // Query room details, topology for timezone, and all sensors
  let room: Room | null = null;
  let roomPath = "";
  let timezone: string;
  let tzMetadata: TimezoneMetadata;
  let trafficSensors: Sensor[] = [];

  try {
    const [roomResult, topoResult, sensorsResult] = await Promise.all([
      apolloClient.query<{ room: Room }>({
        query: GET_ROOM_SENSORS,
        variables: { roomId: spaceId },
        fetchPolicy: "network-only",
      }),
      apolloClient.query<{ sites: { data: Site[] } }>({
        query: GET_FULL_TOPOLOGY,
        fetchPolicy: "network-only",
      }),
      apolloClient.query<{ sensors: { data: Sensor[] } }>({
        query: GET_ALL_SENSORS,
        fetchPolicy: "network-only",
      }),
    ]);

    if (!roomResult.data?.room) {
      throw new Error(`Room ${spaceId} not found`);
    }

    room = roomResult.data.room;
    const floor = room.floor;
    const building = floor?.building;
    roomPath = building ? `${building.name} > ${floor.name} > ${room.name}` : room.name;

    // Get timezone for this room
    const sites = topoResult.data?.sites?.data || [];
    const buildings = sites.flatMap((s) => s.buildings || []);
    const floors = buildings.flatMap((b) => b.floors || []);

    const roomTimezone = getTimezoneForAsset(spaceId, "room", floors, buildings, sites);

    if (!roomTimezone) {
      throw new Error(`Could not determine timezone for room ${spaceId}`);
    }

    timezone = roomTimezone;
    tzMetadata = buildTimezoneMetadata(timezone);

    // Analyze traffic sensors for this room
    const allSensors = sensorsResult.data?.sensors?.data || [];
    const roomSensors = allSensors.filter((s) => (s.room_id || s.roomID) === spaceId);
    // Non-entrance traffic sensors (room-level traffic counting)
    trafficSensors = roomSensors.filter((s) => s.mode === "traffic" && s.is_entrance === false);

    if (trafficSensors.length === 0) {
      throw new Error(
        `Room "${room.name}" does not have traffic-mode sensors. Try butlr_get_current_occupancy for occupancy data instead.`
      );
    }

    if (process.env.DEBUG) {
      console.error(`[traffic-flow] Found ${trafficSensors.length} traffic sensors for room`);
    }
  } catch (error: unknown) {
    rethrowIfGraphQLError(error);
    throw error;
  }

  // Calculate time range
  const timeWindow = args.time_window || "today";
  let start: string;
  let stop: string = "now";
  let periodDescription: string;
  let usedUtcFallback = false;

  if (timeWindow === "custom") {
    if (!args.custom_start) {
      throw createValidationError("custom_start is required when time_window='custom'");
    }
    start = args.custom_start;
    stop = args.custom_stop || "now";
    periodDescription = "custom period";
  } else if (timeWindow === "20m") {
    start = "-20m";
    periodDescription = "last 20 minutes";
  } else if (timeWindow === "1h") {
    start = "-1h";
    periodDescription = "last hour";
  } else {
    // today - use site's timezone for local midnight
    const localMidnight = getLocalMidnight(new Date(), timezone);

    if (isNaN(localMidnight.getTime())) {
      // getLocalMidnight returns UTC midnight as fallback on error
      usedUtcFallback = true;
    }

    // Detect if getLocalMidnight silently fell back to UTC by comparing
    // the result against a plain UTC midnight (which is what the internal fallback does)
    const utcMidnight = new Date();
    utcMidnight.setUTCHours(0, 0, 0, 0);
    if (timezone !== "UTC" && Math.abs(localMidnight.getTime() - utcMidnight.getTime()) < 1000) {
      // The result suspiciously matches UTC midnight for a non-UTC timezone —
      // likely the internal fallback fired
      usedUtcFallback = true;
    }

    start = localMidnight.toISOString();
    periodDescription = usedUtcFallback
      ? "today (UTC fallback)"
      : `today (${tzMetadata.timezone_abbr})`;

    if (process.env.DEBUG) {
      console.error(
        `[traffic-flow] Today starts at ${start} (midnight ${usedUtcFallback ? "UTC fallback" : tzMetadata.timezone_abbr})`
      );
    }
  }

  if (process.env.DEBUG) {
    console.error(`[traffic-flow] Querying traffic from ${start} to ${stop}`);
  }

  // Query traffic data with timezone
  interface TrafficDataPoint {
    time: string;
    sensor_id: string;
    field: "in" | "out";
    value: number;
  }

  let trafficData: TrafficDataPoint[] = [];

  try {
    const response = await new ReportingRequestBuilder()
      .assets("room", [spaceId])
      .measurements(["traffic"])
      .timeRange(start, stop)
      .window("1h", "sum", timezone) // Sum traffic per hour, aligned to local timezone
      .execute();

    // Parse flat array response
    // Traffic returns TWO data points per hour per sensor: "in" and "out"
    if (!Array.isArray(response.data)) {
      throw new Error("Expected array response from traffic query");
    }

    trafficData = response.data as TrafficDataPoint[];

    if (process.env.DEBUG) {
      console.error(
        `[traffic-flow] Received ${trafficData.length} data points from ${trafficSensors.length} sensors`
      );
    }
  } catch (error: unknown) {
    rethrowIfGraphQLError(error);
    if (process.env.DEBUG) {
      console.error(`[traffic-flow] Failed to get traffic data:`, error);
    }
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to get traffic data for ${room.name}. ${msg}`);
  }

  // Parse traffic data: group by time, then by sensor, then aggregate
  // Store time separately to preserve full ISO timestamp
  const byHourSensor = new Map<string, { time: string; in: number; out: number }>();

  for (const point of trafficData) {
    const key = `${point.time}:${point.sensor_id}`;
    if (!byHourSensor.has(key)) {
      byHourSensor.set(key, { time: point.time, in: 0, out: 0 });
    }

    const counts = byHourSensor.get(key)!;
    if (point.field === "in") {
      counts.in = point.value || 0;
    } else if (point.field === "out") {
      counts.out = point.value || 0;
    }
  }

  // Aggregate across sensors by hour (group by time only)
  const byHour = new Map<string, { in: number; out: number }>();
  for (const [_key, data] of byHourSensor) {
    const time = data.time; // Use actual time from data, not split key
    if (!byHour.has(time)) {
      byHour.set(time, { in: 0, out: 0 });
    }

    const hourCounts = byHour.get(time)!;
    hourCounts.in += data.in;
    hourCounts.out += data.out;
  }

  // Build hourly breakdown (keep UTC timestamps like unified tools)
  const hourlyBreakdown = Array.from(byHour.entries())
    .map(([time, counts]) => ({
      hour_utc: time, // Full ISO timestamp from API
      entries: Math.round(counts.in),
      exits: Math.round(counts.out),
      total_traffic: Math.round(counts.in + counts.out),
      net_flow: Math.round(counts.in - counts.out),
    }))
    .sort((a, b) => a.hour_utc.localeCompare(b.hour_utc));

  // Calculate totals
  const totalEntries = hourlyBreakdown.reduce((sum, h) => sum + h.entries, 0);
  const totalExits = hourlyBreakdown.reduce((sum, h) => sum + h.exits, 0);
  const totalTraffic = totalEntries + totalExits;
  const netFlow = totalEntries - totalExits;

  // Find peak hour (by total traffic)
  let peakHour = hourlyBreakdown.length > 0 ? hourlyBreakdown[0] : null;
  for (const hour of hourlyBreakdown) {
    if (hour.total_traffic > (peakHour?.total_traffic || 0)) {
      peakHour = hour;
    }
  }

  // Build enhanced summary
  const netFlowStr = netFlow >= 0 ? `+${netFlow}` : `${netFlow}`;
  const summary = `${room.name}: ${totalTraffic.toLocaleString()} movements ${periodDescription} (${totalEntries.toLocaleString()} entries, ${totalExits.toLocaleString()} exits, net flow: ${netFlowStr})`;

  // Build response with timezone metadata and in/out breakdown
  const response: TrafficFlowResponse = {
    space: {
      id: room.id,
      name: room.name,
      type: "room",
      path: roomPath,
      sensor_mode: "traffic",
      ...tzMetadata,
    },
    traffic: {
      total_entries: totalEntries,
      total_exits: totalExits,
      total_traffic: totalTraffic,
      net_flow: netFlow,
      sensor_count: trafficSensors.length,
      period: {
        start_utc: start,
        stop_utc: stop,
        description: periodDescription,
      },
    },
    hourly_breakdown: hourlyBreakdown,
    peak_hour: peakHour
      ? {
          hour_utc: peakHour.hour_utc,
          total_traffic: peakHour.total_traffic,
          entries: peakHour.entries,
          exits: peakHour.exits,
          net_flow: peakHour.net_flow,
        }
      : null,
    summary,
    timestamp: new Date().toISOString(),
    timezone_note:
      "All timestamps are UTC (ISO-8601). Use site_timezone to interpret in local time.",
    ...(usedUtcFallback && {
      warning:
        "Could not determine local timezone for this space; timestamps use UTC midnight as fallback. 'Today' may not align with the site's actual local day.",
    }),
  };

  return response;
}

/**
 * Register butlr_traffic_flow with an McpServer instance
 */
export function registerTrafficFlow(server: McpServer): void {
  server.registerTool(
    "butlr_traffic_flow",
    {
      title: "Traffic Flow",
      description: TRAFFIC_FLOW_DESCRIPTION,
      inputSchema: trafficFlowInputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const validated = TrafficFlowArgsSchema.parse(args);
      const result = await executeTrafficFlow(validated);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
