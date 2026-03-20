import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apolloClient } from "../clients/graphql-client.js";
import { GET_ALL_SENSORS, GET_FULL_TOPOLOGY } from "../clients/queries/topology.js";
import { ReportingRequestBuilder } from "../clients/reporting-client.js";
import type { Sensor, Site } from "../clients/types.js";
import { z } from "zod";
import { detectAssetType } from "../utils/asset-helpers.js";
import { validateTimeRange } from "../utils/time-range-validator.js";
import { buildTimezoneMetadata, getTimezoneForAsset } from "../utils/timezone-helpers.js";
import { translateGraphQLError, formatMCPError } from "../errors/mcp-errors.js";

const GET_OCCUPANCY_TIMESERIES_DESCRIPTION =
  "Get occupancy timeseries data for floors, rooms, or zones. Automatically queries both traffic and presence measurements, " +
  "analyzes which are available based on sensor configuration, and returns structured data with timezone context. " +
  "Single tool call provides complete occupancy picture without guessing measurement types.";

/** Shared shape — used by both registerTool (SDK schema) and full validation */
const getOccupancyTimeseriesInputShape = {
  asset_ids: z.array(z.string()).describe("Floor, room, or zone IDs"),

  interval: z
    .enum(["1m", "1h", "1d"])
    .describe("Aggregation interval (1m=max 1hr range, 1h=max 48hrs, 1d=max 60 days)"),

  start: z.string().describe("ISO-8601 timestamp or relative time (e.g., '-24h')"),

  stop: z.string().describe("ISO-8601 timestamp or relative time (e.g., 'now')"),
};

export const GetOccupancyTimeseriesArgsSchema = z.object(getOccupancyTimeseriesInputShape).strict();

/**
 * Tool definition for unified butlr_get_occupancy_timeseries
 */
export const getOccupancyTimeseriesTool = {
  name: "butlr_get_occupancy_timeseries",
  description: GET_OCCUPANCY_TIMESERIES_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      asset_ids: {
        type: "array",
        items: { type: "string" },
        description: "Floor, room, or zone IDs",
      },
      interval: {
        type: "string",
        enum: ["1m", "1h", "1d"],
        description: "Aggregation interval (1m=max 1hr range, 1h=max 48hrs, 1d=max 60 days)",
      },
      start: {
        type: "string",
        description: "ISO-8601 timestamp or relative time (e.g., '-24h')",
      },
      stop: {
        type: "string",
        description: "ISO-8601 timestamp or relative time (e.g., 'now')",
      },
    },
    required: ["asset_ids", "interval", "start", "stop"],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/**
 * Input arguments
 */
export interface GetOccupancyTimeseriesArgs {
  asset_ids: string[];
  interval: string;
  start: string;
  stop: string;
}

/**
 * Measurement data for an asset
 */
interface MeasurementData {
  available: boolean;
  sensor_count?: number;
  entrance_sensor_count?: number;
  coverage_note?: string;
  warning?: string;
  timeseries: any[];
}

/**
 * Occupancy data for a single asset
 */
interface AssetOccupancyData {
  asset_id: string;
  asset_type: string;
  asset_name?: string;
  site_timezone: string;
  timezone_offset: string;
  timezone_abbr: string;
  current_local_time: string;
  dst_active: boolean;
  presence: MeasurementData;
  traffic: MeasurementData;
  recommended_measurement: "presence" | "traffic" | "none";
  recommendation_reason: string;
}

/**
 * Execute unified occupancy timeseries tool
 */
export async function executeGetOccupancyTimeseries(args: GetOccupancyTimeseriesArgs) {
  // Validate inputs
  if (!args.asset_ids || !Array.isArray(args.asset_ids) || args.asset_ids.length === 0) {
    throw new Error("asset_ids is required and must be a non-empty array");
  }

  if (!["1m", "1h", "1d"].includes(args.interval)) {
    throw new Error("interval must be one of: 1m, 1h, 1d");
  }

  // Validate time range
  try {
    validateTimeRange(args.interval, args.start, args.stop);
  } catch (error: any) {
    throw new Error(error.message);
  }

  if (process.env.DEBUG) {
    console.error(`[butlr-get-occupancy-timeseries] Querying ${args.asset_ids.length} assets`);
  }

  // Query topology and sensors
  let topoResult, sensorsResult;
  try {
    [topoResult, sensorsResult] = await Promise.all([
      apolloClient.query<{ sites: { data: Site[] } }>({
        query: GET_FULL_TOPOLOGY,
        fetchPolicy: "network-only",
      }),
      apolloClient.query<{ sensors: { data: Sensor[] } }>({
        query: GET_ALL_SENSORS,
        fetchPolicy: "network-only",
      }),
    ]);
  } catch (error: any) {
    if (error && (error.graphQLErrors || error.networkError)) {
      const mcpError = translateGraphQLError(error);
      const errorMessage = formatMCPError(mcpError);
      throw new Error(errorMessage);
    }
    throw error;
  }

  const sites = topoResult.data?.sites?.data || [];
  const buildings = sites.flatMap((s) => s.buildings || []);
  const floors = buildings.flatMap((b) => b.floors || []);
  const allSensors = sensorsResult.data?.sensors?.data || [];

  // Filter out test/placeholder sensors
  const productionSensors = allSensors.filter(
    (s) =>
      s.mac_address &&
      s.mac_address.trim() !== "" &&
      !s.mac_address.startsWith("mi-rr-or") &&
      !s.mac_address.startsWith("fa-ke")
  );

  // Process each asset
  const assetData: AssetOccupancyData[] = [];

  for (const assetId of args.asset_ids) {
    const assetType = detectAssetType(assetId);

    if (!["floor", "room", "zone"].includes(assetType)) {
      throw new Error(`Asset ${assetId} must be a floor, room, or zone. Got: ${assetType}`);
    }

    // Get timezone for this asset
    const timezone = getTimezoneForAsset(
      assetId,
      assetType as "floor" | "room" | "zone",
      floors,
      buildings,
      sites
    );

    if (!timezone) {
      throw new Error(`Could not determine timezone for asset ${assetId}`);
    }

    const tzMetadata = buildTimezoneMetadata(timezone);

    // Get asset name
    let assetName: string | undefined;
    if (assetType === "floor") {
      assetName = floors.find((f) => f.id === assetId)?.name;
    } else if (assetType === "room") {
      for (const floor of floors) {
        const room = floor.rooms?.find((r) => r.id === assetId);
        if (room) {
          assetName = room.name;
          break;
        }
      }
    } else if (assetType === "zone") {
      for (const floor of floors) {
        const zone = floor.zones?.find((z) => z.id === assetId);
        if (zone) {
          assetName = zone.name;
          break;
        }
      }
    }

    // Filter sensors for this asset
    const assetSensors = productionSensors.filter((s) => {
      const sensorFloorId = s.floor_id || s.floorID;
      const sensorRoomId = s.room_id || s.roomID;

      if (assetType === "floor") {
        return sensorFloorId === assetId;
      } else if (assetType === "room") {
        return sensorRoomId === assetId;
      } else if (assetType === "zone") {
        // Zones don't have direct sensor assignments in our current model
        // Would need to check sensor.zone_ids array
        return false;
      }
      return false;
    });

    // Analyze sensor configuration
    const presenceSensors = assetSensors.filter((s) => s.mode === "presence");

    let trafficSensors: Sensor[];
    if (assetType === "floor") {
      // Floor traffic: entrance sensors only
      trafficSensors = assetSensors.filter((s) => s.mode === "traffic" && s.is_entrance === true);
    } else if (assetType === "room") {
      // Room traffic: non-entrance sensors
      trafficSensors = assetSensors.filter((s) => s.mode === "traffic" && s.is_entrance === false);
    } else {
      // Zones don't support traffic
      trafficSensors = [];
    }

    // Query presence data if sensors available
    const presenceData: MeasurementData = {
      available: presenceSensors.length > 0,
      sensor_count: presenceSensors.length,
      timeseries: [],
    };

    if (presenceSensors.length > 0) {
      const measurement =
        assetType === "floor"
          ? "floor_occupancy"
          : assetType === "room"
            ? "room_occupancy"
            : "zone_occupancy";

      presenceData.coverage_note =
        assetType === "floor"
          ? `Presence data from ${presenceSensors.length} sensors. May not cover entire floor area.`
          : `Presence data from ${presenceSensors.length} sensors.`;

      try {
        const response = await new ReportingRequestBuilder()
          .assets(assetType, [assetId])
          .measurements([measurement])
          .timeRange(args.start, args.stop)
          .window(args.interval, "median")
          .execute();

        if (response.data && Array.isArray(response.data)) {
          presenceData.timeseries = response.data.map((d) => ({
            timestamp: new Date(d.time).toISOString(),
            value: d.value,
          }));
        }
      } catch (error: any) {
        console.error(`[occupancy-timeseries] Presence query failed:`, error);
        presenceData.warning =
          "Failed to retrieve presence timeseries data. Results may be incomplete.";
      }
    } else {
      presenceData.coverage_note =
        assetType === "zone"
          ? "Zones support presence measurement only."
          : `No presence sensors configured for this ${assetType}.`;
    }

    // Query traffic data if sensors available
    const trafficData: MeasurementData = {
      available: trafficSensors.length > 0,
      entrance_sensor_count: assetType === "floor" ? trafficSensors.length : undefined,
      sensor_count: assetType === "room" ? trafficSensors.length : undefined,
      timeseries: [],
    };

    if (trafficSensors.length > 0) {
      const measurement =
        assetType === "floor" ? "traffic_floor_occupancy" : "traffic_room_occupancy";

      trafficData.coverage_note =
        assetType === "floor"
          ? `Traffic data from ${trafficSensors.length} main entrance sensors.`
          : `Traffic data from ${trafficSensors.length} sensors (non-entrance).`;

      try {
        const response = await new ReportingRequestBuilder()
          .assets(assetType, [assetId])
          .measurements([measurement])
          .timeRange(args.start, args.stop)
          .window(args.interval, "median")
          .execute();

        if (response.data && Array.isArray(response.data)) {
          trafficData.timeseries = response.data.map((d) => ({
            timestamp: new Date(d.time).toISOString(),
            value: d.value,
          }));
        }
      } catch (error: any) {
        console.error(`[occupancy-timeseries] Traffic query failed:`, error);
        trafficData.warning =
          "Failed to retrieve traffic timeseries data. Results may be incomplete.";
      }
    } else {
      if (assetType === "zone") {
        trafficData.coverage_note = "Zones do not support traffic measurement.";
      } else if (assetType === "floor") {
        trafficData.coverage_note =
          "No main entrance sensors configured. Floor does not have traffic data.";
      } else {
        trafficData.coverage_note = "No traffic sensors configured for this room.";
      }
    }

    // Determine recommendation
    let recommended: "presence" | "traffic" | "none" = "none";
    let reason = "No occupancy data available for this asset.";

    if (presenceData.available && trafficData.available) {
      recommended = "presence";
      reason =
        "Both measurements available. Presence shows current occupants; traffic shows entry/exit flow.";
    } else if (presenceData.available) {
      recommended = "presence";
      reason = "Only presence data available (direct occupant count).";
    } else if (trafficData.available) {
      recommended = "traffic";
      reason = "Only traffic data available (entry/exit counts).";
    }

    assetData.push({
      asset_id: assetId,
      asset_type: assetType,
      asset_name: assetName,
      ...tzMetadata,
      presence: presenceData,
      traffic: trafficData,
      recommended_measurement: recommended,
      recommendation_reason: reason,
    });
  }

  return {
    assets: assetData,
    interval: args.interval,
    start: args.start,
    stop: args.stop,
    timezone_note:
      "All timestamps are UTC (ISO-8601). Use site_timezone for each asset to convert to local time.",
    timestamp: new Date().toISOString(),
  };
}

/**
 * Register butlr_get_occupancy_timeseries with an McpServer instance
 */
export function registerGetOccupancyTimeseries(server: McpServer): void {
  server.registerTool(
    "butlr_get_occupancy_timeseries",
    {
      title: "Get Occupancy Timeseries",
      description: GET_OCCUPANCY_TIMESERIES_DESCRIPTION,
      inputSchema: getOccupancyTimeseriesInputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const validated = GetOccupancyTimeseriesArgsSchema.parse(args);
      const result = await executeGetOccupancyTimeseries(validated);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
