import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ReportingRequestBuilder, ApiError } from "../clients/reporting-client.js";
import { z } from "zod";
import {
  fetchTopologyAndSensors,
  resolveAssetContext,
  getPresenceMeasurement,
  getTrafficMeasurement,
  getPresenceCoverageNote,
  getTrafficCoverageNote,
  buildRecommendation,
  buildSpaceLifecycle,
  isSensorlessSpace,
  probeSensorlessHistory,
  sensorlessCoverageNote,
  sensorlessRecommendationReason,
  type HistoryProbe,
} from "../utils/occupancy-helpers.js";
import { debug } from "../utils/debug.js";
import { withToolErrorHandling } from "../errors/mcp-errors.js";
import type {
  CurrentOccupancyResponse,
  AssetCurrentOccupancy,
  CurrentMeasurementData,
} from "../types/responses.js";

const GET_CURRENT_OCCUPANCY_DESCRIPTION =
  "Get current occupancy for floors, rooms, or zones (last 5 minutes median). Automatically queries both traffic and presence measurements, " +
  "analyzes which are available based on sensor configuration, and returns structured data with timezone context. " +
  "Single tool call provides complete current occupancy picture.\n\n" +
  "An archived room or zone with no sensors (`archived_at` set) has no live data and is reported as such rather than queried. " +
  "For a sensorless or archived room/zone, `history_end` is the last full day of its recorded history; " +
  "`history_note` points at butlr_get_occupancy_timeseries for that history and names any replacement.\n\n" +
  "When NOT to Use:\n" +
  "- Historical occupancy trends or time-range analysis → use butlr_get_occupancy_timeseries instead\n" +
  "- Qualitative busyness labels (quiet/moderate/busy) with trend comparison → use butlr_space_busyness instead\n" +
  "- Entry/exit traffic counts → use butlr_traffic_flow instead\n" +
  "- Finding available/empty rooms → use butlr_available_rooms instead";

/** Shared shape — used by both registerTool (SDK schema) and full validation */
const getCurrentOccupancyInputShape = {
  asset_ids: z.array(z.string()).min(1).max(50).describe("Floor, room, or zone IDs"),
};

export const GetCurrentOccupancyArgsSchema = z.object(getCurrentOccupancyInputShape).strict();

/** Input arguments — inferred from Zod schema */
export type GetCurrentOccupancyArgs = z.output<typeof GetCurrentOccupancyArgsSchema>;

/**
 * Execute unified current occupancy tool
 */
export async function executeGetCurrentOccupancy(
  args: GetCurrentOccupancyArgs
): Promise<CurrentOccupancyResponse> {
  debug("butlr-get-current-occupancy", `Querying ${args.asset_ids.length} assets`);

  // Fetch topology and sensors using shared helper
  const ctx = await fetchTopologyAndSensors();

  // Process each asset
  const assets: AssetCurrentOccupancy[] = [];
  let hasAnyFallback = false;
  const now = new Date();
  const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);

  for (const assetId of args.asset_ids) {
    const asset = resolveAssetContext(assetId, ctx);
    const archivedOn = asset.archivedOn;

    // ---- Presence ----
    // Zones have no client-visible sensor attribution (see occupancy-helpers
    // `resolveAssetContext`), but the server computes `zone_occupancy`
    // independently. Always query for zones; gate on sensor count for
    // rooms/floors where 0 sensors really does mean "no data possible".
    // An archived room or zone with no sensors is never queried: it is
    // retired, and the note below says so instead of a lookup that can only
    // come back empty (or, for a zone, fail). An archived space that still
    // has sensors (bad data; the API refuses to archive one) is read like an
    // active space.
    const sensorless = isSensorlessSpace(asset);
    const retired = sensorless && Boolean(archivedOn);
    const shouldQueryPresence =
      !retired && (asset.assetType === "zone" || asset.presenceSensors.length > 0);
    const presenceData: CurrentMeasurementData = {
      available: shouldQueryPresence,
      sensor_count: asset.presenceSensors.length,
      coverage_note: getPresenceCoverageNote(asset.assetType, asset.presenceSensors.length),
    };

    let presenceHasData = false;

    if (shouldQueryPresence) {
      const measurement = getPresenceMeasurement(asset.assetType);

      try {
        const response = await new ReportingRequestBuilder()
          .assets(asset.assetType, [assetId])
          .measurements([measurement])
          .timeRange(fiveMinAgo.toISOString(), now.toISOString())
          .window("1m", "median")
          .execute();

        if (response.data && Array.isArray(response.data) && response.data.length > 0) {
          const latest = response.data[response.data.length - 1];
          presenceData.current_occupancy = latest.value;
          presenceData.timestamp = new Date(latest.time).toISOString();
          presenceHasData = true;
        }
      } catch (error: unknown) {
        debug("current-occupancy", "Presence query failed:", error);
        if (error instanceof ApiError && error.statusCode >= 400) {
          throw error;
        }
        presenceData.warning =
          "Failed to retrieve current presence data. Occupancy value may be missing.";
      }
    }

    // A sensorless room/zone gets a history-end probe so the response can say
    // where its recorded history ends -- but only once the live read (if any)
    // came back empty. A zone with no attributed sensors that still reads
    // live (zone occupancy can come from overlapping floor sensors) is not
    // retired, and the six-month probe would be wasted on it.
    let probe: HistoryProbe = { status: "skipped" };
    if (sensorless && !presenceHasData && !presenceData.warning) {
      probe = await probeSensorlessHistory(asset, assetId);
      presenceData.coverage_note = sensorlessCoverageNote(asset, probe);
    }

    // ---- Traffic ----
    const shouldQueryTraffic = asset.trafficSensors.length > 0;
    const trafficData: CurrentMeasurementData = {
      available: shouldQueryTraffic,
      entrance_sensor_count: asset.assetType === "floor" ? asset.trafficSensors.length : undefined,
      sensor_count: asset.assetType === "room" ? asset.trafficSensors.length : undefined,
      coverage_note:
        retired && asset.assetType === "room"
          ? presenceData.coverage_note
          : getTrafficCoverageNote(asset.assetType, asset.trafficSensors.length),
    };

    let trafficHasData = false;

    if (shouldQueryTraffic) {
      const measurement = getTrafficMeasurement(asset.assetType as "floor" | "room");

      try {
        const response = await new ReportingRequestBuilder()
          .assets(asset.assetType, [assetId])
          .measurements([measurement])
          .timeRange(fiveMinAgo.toISOString(), now.toISOString())
          .window("1m", "median")
          .execute();

        if (response.data && Array.isArray(response.data) && response.data.length > 0) {
          const latest = response.data[response.data.length - 1];
          trafficData.current_occupancy = latest.value;
          trafficData.timestamp = new Date(latest.time).toISOString();
          trafficHasData = true;
        }
      } catch (error: unknown) {
        debug("current-occupancy", "Traffic query failed:", error);
        if (error instanceof ApiError && error.statusCode >= 400) {
          throw error;
        }
        trafficData.warning =
          "Failed to retrieve current traffic data. Occupancy value may be missing.";
      }
    }

    // ---- Recommendation (checks data success, not just sensor availability) ----
    const recommendation = buildRecommendation(
      presenceData,
      trafficData,
      presenceHasData,
      trafficHasData,
      {
        assetType: asset.assetType,
        windowLabel: "the last 5 minutes",
        archivedReason: sensorlessRecommendationReason(asset, "current", probe),
      }
    );

    const assetEntry: AssetCurrentOccupancy = {
      asset_id: assetId,
      asset_type: asset.assetType,
      asset_name: asset.assetName,
      ...buildSpaceLifecycle(asset, assetId, "current", probe),
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
    timestamp: now.toISOString(),
    timezone_note: hasAnyFallback
      ? "All timestamps are UTC (ISO-8601). WARNING: One or more assets have no site timezone configured — UTC was used as fallback. Local time conversions may not reflect the site's actual local time."
      : "All timestamps are UTC (ISO-8601). Use site_timezone for local conversion.",
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
        openWorldHint: false,
      },
    },
    withToolErrorHandling(async (args) => {
      const validated = GetCurrentOccupancyArgsSchema.parse(args);
      const result = await executeGetCurrentOccupancy(validated);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    })
  );
}
