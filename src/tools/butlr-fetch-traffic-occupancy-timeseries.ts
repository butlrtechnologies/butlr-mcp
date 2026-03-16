import { ReportingRequestBuilder } from "../clients/reporting-client.js";
import {
  detectAssetType,
  getTrafficMeasurementForAssetType,
  supportsTrafficMeasurement,
} from "../utils/asset-helpers.js";
import { validateTimeRange } from "../utils/time-range-validator.js";

/**
 * Tool definition for butlr_fetch_traffic_occupancy_timeseries
 */
export const trafficOccupancyTimeseriesToolTool = {
  name: "butlr_fetch_traffic_occupancy_timeseries",
  description:
    "Get traffic-based occupancy timeseries data for rooms or floors. Uses median aggregation (hard-coded). " +
    "Requires traffic-mode sensors. Time range limits: 1m interval ≤ 1 hour, 1h interval ≤ 48 hours, 1d interval ≤ 60 days. " +
    "Supports relative times (e.g., '-24h') and ISO-8601 timestamps.",
  inputSchema: {
    type: "object",
    properties: {
      asset_ids: {
        type: "array",
        items: { type: "string" },
        description: "Room or floor IDs with traffic sensors",
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
};

/**
 * Input arguments for butlr_fetch_traffic_occupancy_timeseries
 */
export interface TrafficOccupancyTimeseriesArgs {
  asset_ids: string[];
  interval: string;
  start: string;
  stop: string;
}

/**
 * Execute butlr_fetch_traffic_occupancy_timeseries tool
 */
export async function executeTrafficOccupancyTimeseries(args: TrafficOccupancyTimeseriesArgs) {
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

  // Validate all assets support traffic measurements
  const assetTypes = new Set<string>();
  for (const id of args.asset_ids) {
    const assetType = detectAssetType(id);
    if (assetType === "unknown") {
      throw new Error(`Unknown asset type for ID: ${id}`);
    }
    if (!supportsTrafficMeasurement(assetType)) {
      throw new Error(
        `Asset ${id} (type: ${assetType}) does not support traffic measurements. Only rooms and floors are supported.`
      );
    }
    assetTypes.add(assetType);
  }

  if (process.env.DEBUG) {
    console.error(
      `[butlr-fetch-traffic-occupancy-timeseries] Querying ${args.asset_ids.length} assets, interval: ${args.interval}, range: ${args.start} to ${args.stop}`
    );
  }

  // Group assets by type
  const assetsByType: Record<string, string[]> = {};
  for (const id of args.asset_ids) {
    const assetType = detectAssetType(id);
    if (!assetsByType[assetType]) {
      assetsByType[assetType] = [];
    }
    assetsByType[assetType].push(id);
  }

  // Query each asset type separately
  const allTimeseries: any[] = [];

  for (const [assetType, ids] of Object.entries(assetsByType)) {
    const measurement = getTrafficMeasurementForAssetType(assetType);

    const response = await new ReportingRequestBuilder()
      .assets(assetType, ids)
      .measurements([measurement])
      .timeRange(args.start, args.stop)
      .window(args.interval, "median")
      .execute();

    // Parse response - v3 API returns flat array of data points
    if (response.data && Array.isArray(response.data)) {
      for (const dataPoint of response.data) {
        // Each data point has: time, value, room_id/space_id, etc.
        const assetId = dataPoint.room_id || dataPoint.space_id;

        if (assetId && dataPoint.time && dataPoint.value !== undefined) {
          allTimeseries.push({
            asset_id: assetId,
            timestamp: new Date(dataPoint.time).toISOString(),
            value: dataPoint.value,
            measurement,
          });
        }
      }
    }
  }

  const response: any = {
    timeseries: allTimeseries,
    interval: args.interval,
    aggregation: "median",
    start: args.start,
    stop: args.stop,
    total_points: allTimeseries.length,
    assets_queried: args.asset_ids,
    measurement_type: "traffic",
    timestamp: new Date().toISOString(),
  };

  // Add helpful note if no data returned
  if (allTimeseries.length === 0) {
    response.note =
      "No traffic data returned. Assets may not have traffic sensors or no activity during this period. " +
      "Try butlr_fetch_presence_occupancy_timeseries for presence-based measurements.";
  }

  return response;
}
