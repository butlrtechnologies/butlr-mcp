import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apolloClient } from "../clients/graphql-client.js";
import { GET_ALL_SENSORS, GET_FULL_TOPOLOGY } from "../clients/queries/topology.js";
import { ReportingRequestBuilder } from "../clients/reporting-client.js";
import type { Sensor, Site } from "../clients/types.js";
import { z } from "zod";
import { detectAssetType } from "../utils/asset-helpers.js";
import { buildTimezoneMetadata, getTimezoneForAsset } from "../utils/timezone-helpers.js";
import { translateGraphQLError, formatMCPError } from "../errors/mcp-errors.js";

const GET_CURRENT_OCCUPANCY_DESCRIPTION =
  "Get current occupancy for floors, rooms, or zones (last 5 minutes median). Automatically queries both traffic and presence measurements, " +
  "analyzes which are available based on sensor configuration, and returns structured data with timezone context. " +
  "Single tool call provides complete current occupancy picture.";

/** Shared shape — used by both registerTool (SDK schema) and full validation */
const getCurrentOccupancyInputShape = {
  asset_ids: z.array(z.string()).describe("Floor, room, or zone IDs"),
};

export const GetCurrentOccupancyArgsSchema = z.object(getCurrentOccupancyInputShape).strict();

/**
 * Tool definition for unified butlr_get_current_occupancy
 */
export const getCurrentOccupancyTool = {
  name: "butlr_get_current_occupancy",
  description: GET_CURRENT_OCCUPANCY_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      asset_ids: {
        type: "array",
        items: { type: "string" },
        description: "Floor, room, or zone IDs",
      },
    },
    required: ["asset_ids"],
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
export interface GetCurrentOccupancyArgs {
  asset_ids: string[];
}

/**
 * Current measurement data
 */
interface CurrentMeasurementData {
  available: boolean;
  sensor_count?: number;
  entrance_sensor_count?: number;
  coverage_note?: string;
  warning?: string;
  current_occupancy?: number;
  timestamp?: string;
}

/**
 * Current occupancy for a single asset
 */
interface AssetCurrentOccupancy {
  asset_id: string;
  asset_type: string;
  asset_name?: string;
  site_timezone: string;
  timezone_offset: string;
  timezone_abbr: string;
  current_local_time: string;
  dst_active: boolean;
  presence: CurrentMeasurementData;
  traffic: CurrentMeasurementData;
  recommended_measurement: "presence" | "traffic" | "none";
  recommendation_reason: string;
}

/**
 * Execute unified current occupancy tool
 */
export async function executeGetCurrentOccupancy(args: GetCurrentOccupancyArgs) {
  // Validate inputs
  if (!args.asset_ids || !Array.isArray(args.asset_ids) || args.asset_ids.length === 0) {
    throw new Error("asset_ids is required and must be a non-empty array");
  }

  if (process.env.DEBUG) {
    console.error(`[butlr-get-current-occupancy] Querying ${args.asset_ids.length} assets`);
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
  const assetData: AssetCurrentOccupancy[] = [];
  const now = new Date();
  const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);

  for (const assetId of args.asset_ids) {
    const assetType = detectAssetType(assetId);

    if (!["floor", "room", "zone"].includes(assetType)) {
      throw new Error(`Asset ${assetId} must be a floor, room, or zone. Got: ${assetType}`);
    }

    // Get timezone
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
      }
      return false;
    });

    // Analyze sensors
    const presenceSensors = assetSensors.filter((s) => s.mode === "presence");
    let trafficSensors: Sensor[];

    if (assetType === "floor") {
      trafficSensors = assetSensors.filter((s) => s.mode === "traffic" && s.is_entrance === true);
    } else if (assetType === "room") {
      trafficSensors = assetSensors.filter((s) => s.mode === "traffic" && s.is_entrance === false);
    } else {
      trafficSensors = [];
    }

    // Query presence
    const presenceData: CurrentMeasurementData = {
      available: presenceSensors.length > 0,
      sensor_count: presenceSensors.length,
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
          ? `Presence from ${presenceSensors.length} sensors (may not cover entire floor).`
          : `Presence from ${presenceSensors.length} sensors.`;

      try {
        const response = await new ReportingRequestBuilder()
          .assets(assetType, [assetId])
          .measurements([measurement])
          .timeRange(fiveMinAgo.toISOString(), now.toISOString())
          .window("1m", "median")
          .execute();

        if (response.data && Array.isArray(response.data) && response.data.length > 0) {
          // Get latest data point
          const latest = response.data[response.data.length - 1];
          presenceData.current_occupancy = latest.value;
          presenceData.timestamp = new Date(latest.time).toISOString();
        }
      } catch (error: any) {
        console.error(`[current-occupancy] Presence query failed:`, error);
        presenceData.warning =
          "Failed to retrieve current presence data. Occupancy value may be missing.";
      }
    } else {
      presenceData.coverage_note =
        assetType === "zone"
          ? "Zones support presence measurement only."
          : `No presence sensors on this ${assetType}.`;
    }

    // Query traffic
    const trafficData: CurrentMeasurementData = {
      available: trafficSensors.length > 0,
      entrance_sensor_count: assetType === "floor" ? trafficSensors.length : undefined,
      sensor_count: assetType === "room" ? trafficSensors.length : undefined,
    };

    if (trafficSensors.length > 0) {
      const measurement =
        assetType === "floor" ? "traffic_floor_occupancy" : "traffic_room_occupancy";

      trafficData.coverage_note =
        assetType === "floor"
          ? `Traffic from ${trafficSensors.length} main entrance sensors.`
          : `Traffic from ${trafficSensors.length} sensors.`;

      try {
        const response = await new ReportingRequestBuilder()
          .assets(assetType, [assetId])
          .measurements([measurement])
          .timeRange(fiveMinAgo.toISOString(), now.toISOString())
          .window("1m", "median")
          .execute();

        if (response.data && Array.isArray(response.data) && response.data.length > 0) {
          const latest = response.data[response.data.length - 1];
          trafficData.current_occupancy = latest.value;
          trafficData.timestamp = new Date(latest.time).toISOString();
        }
      } catch (error: any) {
        console.error(`[current-occupancy] Traffic query failed:`, error);
        trafficData.warning =
          "Failed to retrieve current traffic data. Occupancy value may be missing.";
      }
    } else {
      if (assetType === "zone") {
        trafficData.coverage_note = "Zones do not support traffic.";
      } else if (assetType === "floor") {
        trafficData.coverage_note = "No main entrance sensors.";
      } else {
        trafficData.coverage_note = "No traffic sensors.";
      }
    }

    // Recommendation
    let recommended: "presence" | "traffic" | "none" = "none";
    let reason = "No current occupancy data available.";

    if (presenceData.available && trafficData.available) {
      recommended = "presence";
      reason = "Both available. Presence shows current occupants; traffic shows flow.";
    } else if (presenceData.available) {
      recommended = "presence";
      reason = "Presence available (direct occupant count).";
    } else if (trafficData.available) {
      recommended = "traffic";
      reason = "Traffic available (entry/exit counts).";
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
    query_time: now.toISOString(),
    timezone_note: "All timestamps are UTC (ISO-8601). Use site_timezone for local conversion.",
  };
}

/**
 * Register butlr_get_current_occupancy with an McpServer instance
 */
export function registerGetCurrentOccupancy(server: McpServer): void {
  server.registerTool(
    "butlr_get_current_occupancy",
    {
      title: "Get Current Occupancy",
      description: GET_CURRENT_OCCUPANCY_DESCRIPTION,
      inputSchema: getCurrentOccupancyInputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      const validated = GetCurrentOccupancyArgsSchema.parse(args);
      const result = await executeGetCurrentOccupancy(validated);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
