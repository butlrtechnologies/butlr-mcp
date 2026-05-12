import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ReportingRequestBuilder } from "../clients/reporting-client.js";
import { z } from "zod";
import { validateTimeRange } from "../utils/time-range-validator.js";
import {
  fetchTopologyAndSensors,
  resolveAssetContext,
  getPresenceMeasurement,
  getTrafficMeasurement,
  getPresenceCoverageNote,
  getTrafficCoverageNote,
  buildRecommendation,
} from "../utils/occupancy-helpers.js";
import { debug } from "../utils/debug.js";
import { withToolErrorHandling } from "../errors/mcp-errors.js";
import type {
  OccupancyTimeseriesResponse,
  AssetOccupancyTimeseries,
  TimeseriesMeasurementData,
  TimeseriesPoint,
} from "../types/responses.js";

const GET_OCCUPANCY_TIMESERIES_DESCRIPTION =
  "Get occupancy timeseries data for floors, rooms, or zones. Automatically queries both traffic and presence measurements, " +
  "analyzes which are available based on sensor configuration, and returns structured data with timezone context. " +
  "Single tool call provides complete occupancy picture without guessing measurement types.\n\n" +
  "When NOT to Use:\n" +
  "- Real-time current occupancy snapshot → use butlr_get_current_occupancy instead\n" +
  "- Qualitative busyness labels (quiet/moderate/busy) → use butlr_space_busyness instead\n" +
  "- Entry/exit traffic counts rather than occupancy → use butlr_traffic_flow instead\n" +
  "- Finding currently available rooms → use butlr_available_rooms instead";

/** Shared shape — used by both registerTool (SDK schema) and full validation */
const getOccupancyTimeseriesInputShape = {
  asset_ids: z.array(z.string()).min(1).max(50).describe("Floor, room, or zone IDs"),

  interval: z
    .enum(["1m", "1h", "1d"])
    .describe("Aggregation interval (1m=max 1hr range, 1h=max 48hrs, 1d=max 60 days)"),

  start: z.string().describe("ISO-8601 timestamp or relative time (e.g., '-24h')"),

  stop: z.string().describe("ISO-8601 timestamp or relative time (e.g., 'now')"),
};

export const GetOccupancyTimeseriesArgsSchema = z.object(getOccupancyTimeseriesInputShape).strict();

/** Inferred args type — no manual interface needed */
type GetOccupancyTimeseriesArgs = z.output<typeof GetOccupancyTimeseriesArgsSchema>;

/**
 * Query a single measurement type and map to TimeseriesPoint[].
 * Returns the array on success, or undefined on failure (with warning set on data).
 */
async function queryTimeseries(
  assetType: string,
  assetId: string,
  measurement: string,
  start: string,
  stop: string,
  interval: string,
  timezone: string
): Promise<TimeseriesPoint[] | undefined> {
  const response = await new ReportingRequestBuilder()
    .assets(assetType, [assetId])
    .measurements([measurement])
    .timeRange(start, stop)
    .window(interval, "median", timezone)
    .execute();

  if (response.data && Array.isArray(response.data)) {
    return response.data.map(
      (d): TimeseriesPoint => ({
        timestamp: new Date(d.time).toISOString(),
        value: d.value,
      })
    );
  }
  return [];
}

/**
 * Execute unified occupancy timeseries tool
 */
export async function executeGetOccupancyTimeseries(
  args: GetOccupancyTimeseriesArgs
): Promise<OccupancyTimeseriesResponse> {
  // Validate time range — let errors throw naturally
  validateTimeRange(args.interval, args.start, args.stop);

  debug("butlr-get-occupancy-timeseries", `Querying ${args.asset_ids.length} assets`);

  // Fetch topology and sensors in parallel
  const ctx = await fetchTopologyAndSensors();

  // Process each asset
  const assets: AssetOccupancyTimeseries[] = [];
  let hasAnyFallback = false;

  for (const assetId of args.asset_ids) {
    const asset = resolveAssetContext(assetId, ctx);

    // Build presence measurement data. Zones have no client-visible sensor
    // attribution (see occupancy-helpers `resolveAssetContext`), but the
    // server computes `zone_occupancy` independently. Always query for
    // zones; gate on sensor count for rooms/floors where 0 sensors really
    // does mean "no data possible".
    const shouldQueryPresence = asset.assetType === "zone" || asset.presenceSensors.length > 0;
    const presenceData: TimeseriesMeasurementData = {
      available: shouldQueryPresence,
      sensor_count: asset.presenceSensors.length,
      coverage_note: getPresenceCoverageNote(asset.assetType, asset.presenceSensors.length),
      timeseries: [],
    };

    if (shouldQueryPresence) {
      const measurement = getPresenceMeasurement(asset.assetType);
      try {
        const points = await queryTimeseries(
          asset.assetType,
          assetId,
          measurement,
          args.start,
          args.stop,
          args.interval,
          asset.timezone
        );
        if (points) {
          presenceData.timeseries = points;
        }
      } catch (error: unknown) {
        debug("occupancy-timeseries", "Presence query failed:", error);
        presenceData.warning =
          "Failed to retrieve presence timeseries data. Results may be incomplete.";
      }
    }

    // Build traffic measurement data
    const trafficData: TimeseriesMeasurementData = {
      available: asset.trafficSensors.length > 0,
      entrance_sensor_count: asset.assetType === "floor" ? asset.trafficSensors.length : undefined,
      sensor_count: asset.assetType === "room" ? asset.trafficSensors.length : undefined,
      coverage_note: getTrafficCoverageNote(asset.assetType, asset.trafficSensors.length),
      timeseries: [],
    };

    if (asset.trafficSensors.length > 0 && asset.assetType !== "zone") {
      const measurement = getTrafficMeasurement(asset.assetType as "floor" | "room");
      try {
        const points = await queryTimeseries(
          asset.assetType,
          assetId,
          measurement,
          args.start,
          args.stop,
          args.interval,
          asset.timezone
        );
        if (points) {
          trafficData.timeseries = points;
        }
      } catch (error: unknown) {
        debug("occupancy-timeseries", "Traffic query failed:", error);
        trafficData.warning =
          "Failed to retrieve traffic timeseries data. Results may be incomplete.";
      }
    }

    // Recommendation checks data success, not just sensor count
    const recommendation = buildRecommendation(
      presenceData,
      trafficData,
      presenceData.timeseries.length > 0,
      trafficData.timeseries.length > 0
    );

    const assetEntry: AssetOccupancyTimeseries = {
      asset_id: assetId,
      asset_type: asset.assetType,
      asset_name: asset.assetName,
      ...asset.tzMetadata,
      presence: presenceData,
      traffic: trafficData,
      ...recommendation,
    };
    if (asset.timezoneWarning) {
      assetEntry.timezone_warning = asset.timezoneWarning;
    }
    if (asset.timezoneFallback) {
      hasAnyFallback = true;
    }
    assets.push(assetEntry);
  }

  return {
    assets,
    interval: args.interval,
    start: args.start,
    stop: args.stop,
    timezone_note: hasAnyFallback
      ? "All timestamps are UTC (ISO-8601). WARNING: One or more assets have no site timezone configured — UTC was used as fallback. Window aggregation boundaries and local time conversions may not reflect the site's actual local time."
      : "All timestamps are UTC (ISO-8601). Use site_timezone for each asset to convert to local time.",
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
        openWorldHint: false,
      },
    },
    withToolErrorHandling(async (args) => {
      const validated = GetOccupancyTimeseriesArgsSchema.parse(args);
      const result = await executeGetOccupancyTimeseries(validated);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    })
  );
}
