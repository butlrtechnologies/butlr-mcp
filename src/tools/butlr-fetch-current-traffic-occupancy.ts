import { ReportingRequestBuilder } from "../clients/reporting-client.js";
import {
  detectAssetType,
  getTrafficMeasurementForAssetType,
  supportsTrafficMeasurement,
} from "../utils/asset-helpers.js";
import { getBulkCachedOccupancy, setBulkCachedOccupancy } from "../cache/occupancy-cache.js";

/**
 * Tool definition for butlr_fetch_current_traffic_occupancy
 */
export const currentTrafficOccupancyTool = {
  name: "butlr_fetch_current_traffic_occupancy",
  description:
    "Get current traffic-based occupancy (last 5 minutes median) for rooms or floors. " +
    "Requires traffic-mode sensors. Uses 60s cache for performance.",
  inputSchema: {
    type: "object",
    properties: {
      asset_ids: {
        type: "array",
        items: { type: "string" },
        description: "Room or floor IDs with traffic sensors",
      },
    },
    required: ["asset_ids"],
    additionalProperties: false,
  },
};

/**
 * Input arguments for butlr_fetch_current_traffic_occupancy
 */
export interface CurrentTrafficOccupancyArgs {
  asset_ids: string[];
}

/**
 * Execute butlr_fetch_current_traffic_occupancy tool
 */
export async function executeCurrentTrafficOccupancy(args: CurrentTrafficOccupancyArgs) {
  // Validate inputs
  if (!args.asset_ids || !Array.isArray(args.asset_ids) || args.asset_ids.length === 0) {
    throw new Error("asset_ids is required and must be a non-empty array");
  }

  // Validate all assets support traffic measurements
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
  }

  if (process.env.DEBUG) {
    console.error(
      `[butlr-fetch-current-traffic-occupancy] Querying ${args.asset_ids.length} assets`
    );
  }

  // Check cache first
  const { hits, misses } = getBulkCachedOccupancy(args.asset_ids);

  // Convert cache hits to array
  const cachedData = Object.values(hits).map((entry) => ({
    asset_id: entry.asset_id,
    current_occupancy: entry.occupancy,
    timestamp: entry.timestamp,
    measurement: `traffic_${entry.asset_type}_occupancy`,
  }));

  // Query misses
  const newData: any[] = [];
  if (misses.length > 0) {
    // Group misses by type
    const assetsByType: Record<string, string[]> = {};
    for (const id of misses) {
      const assetType = detectAssetType(id);
      if (!assetsByType[assetType]) {
        assetsByType[assetType] = [];
      }
      assetsByType[assetType].push(id);
    }

    // Query each asset type
    for (const [assetType, ids] of Object.entries(assetsByType)) {
      const measurement = getTrafficMeasurementForAssetType(assetType);

      // Query last 5 minutes
      const now = new Date();
      const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);

      const response = await new ReportingRequestBuilder()
        .assets(assetType, ids)
        .measurements([measurement])
        .timeRange(fiveMinAgo.toISOString(), now.toISOString())
        .window("1m", "median")
        .execute();

      // Parse response - v3 API returns flat array of data points
      if (response.data && Array.isArray(response.data)) {
        // Group by asset ID and get latest timestamp for each
        const latestByAsset: Record<string, any> = {};

        for (const dataPoint of response.data) {
          const assetId = dataPoint.room_id || dataPoint.space_id;

          if (assetId && dataPoint.time && dataPoint.value !== undefined) {
            const timestamp = new Date(dataPoint.time);

            // Keep only the latest data point for each asset
            if (!latestByAsset[assetId] || timestamp > new Date(latestByAsset[assetId].timestamp)) {
              latestByAsset[assetId] = {
                asset_id: assetId,
                current_occupancy: dataPoint.value,
                timestamp: timestamp.toISOString(),
                measurement,
              };
            }
          }
        }

        newData.push(...Object.values(latestByAsset));
      }
    }

    // Cache new data
    const cacheEntries = newData.map((d) => ({
      assetId: d.asset_id,
      occupancy: d.current_occupancy,
      assetType: detectAssetType(d.asset_id),
      timestamp: new Date(d.timestamp),
    }));
    setBulkCachedOccupancy(cacheEntries);
  }

  // Combine hits and new data
  const allOccupancy = [...cachedData, ...newData];

  const response: any = {
    occupancy: allOccupancy,
    query_time: new Date().toISOString(),
    total_assets: allOccupancy.length,
    assets_queried: args.asset_ids,
    measurement_type: "traffic",
    cache_hits: Object.keys(hits).length,
    cache_misses: misses.length,
  };

  // Add helpful note if no data returned
  if (allOccupancy.length === 0) {
    response.note =
      "No current traffic data. Assets may not have traffic sensors or no recent activity (last 5 minutes). " +
      "Try butlr_fetch_current_presence_occupancy for presence-based measurements.";
  }

  return response;
}
