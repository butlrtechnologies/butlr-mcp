import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ReportingRequestBuilder, ApiError } from "../clients/reporting-client.js";
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
  buildSpaceLifecycle,
  isSensorlessSpace,
  probeSensorlessHistory,
  sensorlessCoverageNote,
  sensorlessRecommendationReason,
  type HistoryProbe,
} from "../utils/occupancy-helpers.js";
import { debug } from "../utils/debug.js";
import { mapWithConcurrency } from "../utils/concurrency.js";
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
  "Sensorless, archived and replaced spaces: a room or zone with no sensors (archived or not; see `archived_at`) still returns the history it recorded; " +
  "`history_end` is the last full day of that history (the day before its final, partial recorded day), which can be well before the archive date. " +
  "A space that replaced another carries `replaces`, and `history_note` names the predecessor's ID: series are not merged, " +
  "so query the predecessor separately for history before the switch-over.\n\n" +
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
 * Assets processed at once. The reporting path has no client-side rate
 * limiter, so this stays small: enough to stop a 50-asset batch from paying
 * 50+ serial round trips, without bursting the API into 429s.
 */
const ASSET_CONCURRENCY = 5;

/**
 * Query a single measurement type and map to TimeseriesPoint[].
 */
async function queryTimeseries(
  assetType: string,
  assetId: string,
  measurement: string,
  start: string,
  stop: string,
  interval: string,
  timezone: string
): Promise<TimeseriesPoint[]> {
  const response = await new ReportingRequestBuilder()
    .assets(assetType, [assetId])
    .measurements([measurement])
    .timeRange(start, stop)
    .window(interval, "median", timezone)
    .execute();

  if (!Array.isArray(response.data)) return [];
  return response.data.map(
    (d): TimeseriesPoint => ({
      timestamp: new Date(d.time).toISOString(),
      value: d.value,
    })
  );
}

async function buildPresenceData(
  asset: ReturnType<typeof resolveAssetContext>,
  assetId: string,
  args: GetOccupancyTimeseriesArgs
): Promise<{ presenceData: TimeseriesMeasurementData; probe: HistoryProbe }> {
  // Always query, whatever the current sensor count: a room or zone with 0
  // sensors today can still hold history from sensors that were moved
  // elsewhere (e.g. a room superseded by a re-mapped "_V2" copy).
  const sensorCount = asset.presenceSensors.length;
  // A sensorless space (a room with no sensors of any mode, or an ARCHIVED
  // zone with none; see isSensorlessSpace) gets a history-end probe in
  // parallel with the range query, and its coverage note says where its
  // recorded history ends. A non-archived zone is never sensorless, whatever
  // its attributed-sensor count or however empty its range: zone occupancy
  // can come from overlapping floor sensors, so an empty range on a live
  // zone just means no data in range.
  const sensorless = isSensorlessSpace(asset);
  // A 0-presence floor, a room whose only sensors are traffic-mode, or a
  // room ID that did not resolve keeps the 0.6.2 speculative note.
  const speculative = !sensorless && asset.assetType !== "zone" && sensorCount === 0;
  // These lookups may well find nothing, and their failure must not take
  // down the rest of the batch. Non-archived zones still fail the call on a
  // 4xx as before.
  const bestEffort = speculative || sensorless;
  const presenceData: TimeseriesMeasurementData = {
    available: !bestEffort,
    sensor_count: sensorCount,
    coverage_note: getPresenceCoverageNote(asset.assetType, sensorCount),
    timeseries: [],
  };

  const early = sensorless ? probeSensorlessHistory(asset, assetId) : undefined;
  // Keep an auth rejection from going unhandled while the range query is in
  // flight; it is rethrown by the await below.
  early?.catch(() => undefined);

  try {
    presenceData.timeseries = await queryTimeseries(
      asset.assetType,
      assetId,
      getPresenceMeasurement(asset.assetType),
      args.start,
      args.stop,
      args.interval,
      asset.timezone
    );
  } catch (error: unknown) {
    debug("occupancy-timeseries", "Presence query failed:", error);
    // Auth failures are not asset-specific, so they still fail the call.
    // Anything else on a best-effort lookup (429, 5xx, timeout) is reported
    // on this asset only.
    const isAuthError =
      error instanceof ApiError && (error.statusCode === 401 || error.statusCode === 403);
    if (error instanceof ApiError && error.statusCode >= 400 && (!bestEffort || isAuthError)) {
      throw error;
    }
    presenceData.warning =
      "Failed to retrieve presence timeseries data. Results may be incomplete.";
  }

  const probe: HistoryProbe = early ? await early : { status: "skipped" };

  if (bestEffort && presenceData.timeseries.length > 0) {
    presenceData.available = true;
  }

  if (probe.status !== "skipped") {
    presenceData.coverage_note = sensorlessCoverageNote(asset, probe);
    if (presenceData.warning && presenceData.timeseries.length === 0) {
      // Don't let "no data" stand when the range lookup itself failed.
      presenceData.coverage_note +=
        " The lookup for the requested range failed; it may still have data, retry to check.";
    }
  } else if (speculative) {
    if (presenceData.timeseries.length > 0) {
      presenceData.coverage_note = `No presence sensors are assigned to this ${asset.assetType} now; this history was recorded by sensors assigned to it earlier.`;
    } else if (presenceData.warning) {
      // Don't claim "no sensors, no data" when we never found out.
      presenceData.coverage_note = `No presence sensors are assigned to this ${asset.assetType} now, and the lookup for history from earlier sensors failed. It may still have data for this range; retry to check.`;
    }
  }

  return { presenceData, probe };
}

async function buildTrafficData(
  asset: ReturnType<typeof resolveAssetContext>,
  assetId: string,
  args: GetOccupancyTimeseriesArgs
): Promise<TimeseriesMeasurementData> {
  // Still gated on current traffic sensors: querying traffic for every
  // presence-only room would add a call per room for data that almost never
  // exists. A room whose traffic sensors were moved away loses its traffic
  // history here (see CHANGELOG 0.6.2).
  const trafficData: TimeseriesMeasurementData = {
    available: asset.trafficSensors.length > 0,
    entrance_sensor_count: asset.assetType === "floor" ? asset.trafficSensors.length : undefined,
    sensor_count: asset.assetType === "room" ? asset.trafficSensors.length : undefined,
    coverage_note: getTrafficCoverageNote(asset.assetType, asset.trafficSensors.length),
    timeseries: [],
  };

  if (asset.trafficSensors.length > 0 && asset.assetType !== "zone") {
    try {
      trafficData.timeseries = await queryTimeseries(
        asset.assetType,
        assetId,
        getTrafficMeasurement(asset.assetType as "floor" | "room"),
        args.start,
        args.stop,
        args.interval,
        asset.timezone
      );
    } catch (error: unknown) {
      debug("occupancy-timeseries", "Traffic query failed:", error);
      if (error instanceof ApiError && error.statusCode >= 400) {
        throw error;
      }
      trafficData.warning =
        "Failed to retrieve traffic timeseries data. Results may be incomplete.";
    }
  }

  return trafficData;
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

  const resolved = await mapWithConcurrency(args.asset_ids, ASSET_CONCURRENCY, async (assetId) => {
    const asset = resolveAssetContext(assetId, ctx);
    const [{ presenceData, probe }, trafficData] = await Promise.all([
      buildPresenceData(asset, assetId, args),
      buildTrafficData(asset, assetId, args),
    ]);

    // Recommendation checks data success, not just sensor count
    const recommendation = buildRecommendation(
      presenceData,
      trafficData,
      presenceData.timeseries.length > 0,
      trafficData.timeseries.length > 0,
      {
        assetType: asset.assetType,
        windowLabel: "the requested time range",
        archivedReason: sensorlessRecommendationReason(asset, "timeseries", probe),
      }
    );

    const assetEntry: AssetOccupancyTimeseries = {
      asset_id: assetId,
      asset_type: asset.assetType,
      asset_name: asset.assetName,
      ...buildSpaceLifecycle(asset, assetId, "timeseries", probe),
      ...asset.tzMetadata,
      presence: presenceData,
      traffic: trafficData,
      ...recommendation,
    };
    if (asset.timezoneWarning) {
      assetEntry.timezone_warning = asset.timezoneWarning;
    }
    return { assetEntry, timezoneFallback: asset.timezoneFallback };
  });

  const assets = resolved.map((r) => r.assetEntry);
  const hasAnyFallback = resolved.some((r) => r.timezoneFallback);

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
