import { request as httpRequest } from "undici";
import { authClient } from "./auth-client.js";

const BASE_URL = process.env.BUTLR_BASE_URL || "https://api.butlr.io";
const STATS_ENDPOINT = `${BASE_URL}/api/v4/reporting/stats`;

/**
 * v4 Stats API Request Structure
 * Based on butlr-api-container/pkg/reporting/stats/handler.go
 *
 * Valid measurements (from query.go lines 30-37):
 * - occupancy_avg_presence: Average occupancy from presence sensors
 * - occupancy_avg_traffic: Average occupancy from traffic sensors
 * - occupancy_median_presence: Median occupancy from presence sensors
 * - occupancy_median_traffic: Median occupancy from traffic sensors
 * - occupancy_used_avg_presence: Average (excluding zeros)
 * - occupancy_used_avg_traffic: Average (excluding zeros)
 * - occupancy_used_median_presence: Median (excluding zeros)
 * - occupancy_used_median_traffic: Median (excluding zeros)
 */
export interface StatsRequest {
  measurements: string[]; // e.g., ['occupancy_avg_presence']
  items: string[]; // Asset IDs: ['room_123', 'floor_456']
  start?: string; // ISO-8601 timestamp (NOT relative like '-7d')
  stop?: string; // ISO-8601 timestamp (optional, omit for "now")
  filters?: {
    // Optional time-of-day filtering
    time_ranges?: Array<{ start: string; stop: string }>; // e.g., [{ start: "09:00", stop: "17:00" }]
    exclude_days_of_week?: string[]; // e.g., ["saturday", "sunday"]
  };
}

/**
 * Statistics for a single asset
 */
export interface AssetStatistics {
  count: number; // Number of data points
  first: number; // First value in period
  last: number; // Last value in period
  max: number; // Maximum value
  mean: number; // Average value
  median: number; // Median value
  min: number; // Minimum value
  stdev: number; // Standard deviation
  sum: number; // Sum of all values
}

/**
 * v4 Stats API Response Structure
 */
export interface StatsResponse {
  data: {
    [assetId: string]: AssetStatistics;
  };
}

/**
 * Query v4 Stats API
 *
 * Note: This endpoint is production-ready but may occasionally return 504 errors
 * under heavy load. Implement fallback to client-side calculation if needed.
 */
export async function queryStats(statsRequest: StatsRequest): Promise<StatsResponse> {
  if (process.env.DEBUG) {
    console.error(`[stats-client] POST ${STATS_ENDPOINT}`, JSON.stringify(statsRequest, null, 2));
  }

  try {
    // Get auth token
    const token = await authClient.getToken();

    // Make request
    const response = await httpRequest(STATS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(statsRequest),
    });

    if (response.statusCode !== 200) {
      const errorBody = await response.body.text();

      // Special handling for 504 Gateway Timeout
      if (response.statusCode === 504) {
        if (process.env.DEBUG) {
          console.error(`[stats-client] 504 Gateway Timeout - stats service may be overloaded`);
        }
        throw new Error(
          "Stats service temporarily unavailable (504). Try reducing the time range or number of assets."
        );
      }

      throw new Error(`Stats API error (${response.statusCode}): ${errorBody}`);
    }

    const data = (await response.body.json()) as StatsResponse;

    if (process.env.DEBUG) {
      console.error(
        `[stats-client] Response: statistics for ${Object.keys(data.data || {}).length} assets`
      );
    }

    return data;
  } catch (error: any) {
    if (process.env.DEBUG) {
      console.error(`[stats-client] Request failed:`, error);
    }

    // Translate common errors
    if (error.message?.includes("401") || error.message?.includes("403")) {
      throw new Error("Authentication failed. Check BUTLR_CLIENT_ID and BUTLR_CLIENT_SECRET.");
    }

    if (error.message?.includes("429")) {
      throw new Error("Rate limit exceeded. Please retry after a few seconds.");
    }

    if (error.message?.includes("400")) {
      throw new Error(
        `Invalid request parameters: ${error.message}. Check measurements and items.`
      );
    }

    throw error;
  }
}

/**
 * Convert relative time to ISO-8601 timestamp
 * e.g., "-7d" → "2025-10-06T00:00:00Z"
 */
function parseRelativeTime(relativeTime: string): string {
  const match = relativeTime.match(/^-(\d+)([mhd])$/);
  if (!match) {
    // If not relative format, return as-is (assume ISO-8601)
    return relativeTime;
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  const now = new Date();

  switch (unit) {
    case "m":
      now.setMinutes(now.getMinutes() - value);
      break;
    case "h":
      now.setHours(now.getHours() - value);
      break;
    case "d":
      now.setDate(now.getDate() - value);
      break;
  }

  return now.toISOString();
}

/**
 * Request builder for stats queries
 */
export class StatsRequestBuilder {
  private request: StatsRequest;

  constructor() {
    this.request = {
      measurements: [],
      items: [],
    };
  }

  /**
   * Set measurements to query
   * Use v4-specific measurement names:
   * - occupancy_avg_presence
   * - occupancy_median_presence
   * - occupancy_avg_traffic
   * - occupancy_median_traffic
   */
  measurements(measurements: string[]): this {
    this.request.measurements = measurements;
    return this;
  }

  /**
   * Set asset IDs to query
   */
  assets(assetIds: string[]): this {
    this.request.items = assetIds;
    return this;
  }

  /**
   * Set time range (ISO-8601 timestamp or relative like '-7d')
   * Relative times will be converted to ISO-8601
   */
  timeRange(start: string, stop?: string): this {
    // Convert start time
    this.request.start = parseRelativeTime(start);

    // Convert stop time - if not provided or "now", use current time
    if (!stop || stop === "now") {
      this.request.stop = new Date().toISOString();
    } else {
      this.request.stop = parseRelativeTime(stop);
    }

    return this;
  }

  /**
   * Set time-of-day filters
   */
  timeOfDayFilter(ranges: Array<{ start: string; stop: string }>): this {
    if (!this.request.filters) {
      this.request.filters = {};
    }
    this.request.filters.time_ranges = ranges;
    return this;
  }

  /**
   * Exclude specific days of week
   */
  excludeDays(days: string[]): this {
    if (!this.request.filters) {
      this.request.filters = {};
    }
    this.request.filters.exclude_days_of_week = days;
    return this;
  }

  /**
   * Build and return the request
   */
  build(): StatsRequest {
    // Validation
    if (!this.request.measurements.length) {
      throw new Error("At least one measurement is required");
    }

    if (!this.request.items.length) {
      throw new Error("At least one asset ID is required");
    }

    return this.request;
  }

  /**
   * Build and execute the query
   */
  async execute(): Promise<StatsResponse> {
    return queryStats(this.build());
  }
}

/**
 * Convenience function: Get statistics for multiple assets
 * @param measurement - Use v4 format: 'occupancy_avg_presence', 'occupancy_median_presence', etc.
 * @param assetIds - Array of asset IDs (rooms, floors, zones)
 * @param start - ISO-8601 or relative time (will be converted)
 * @param stop - ISO-8601 timestamp (optional)
 */
export async function getAssetStatistics(
  measurement: string,
  assetIds: string[],
  start: string = "-7d",
  stop?: string
): Promise<StatsResponse> {
  return new StatsRequestBuilder()
    .measurements([measurement])
    .assets(assetIds)
    .timeRange(start, stop)
    .execute();
}

/**
 * Convenience function: Get statistics for a single asset
 * @param measurement - Use v4 format: 'occupancy_avg_presence', 'occupancy_median_presence', etc.
 */
export async function getSingleAssetStats(
  measurement: string,
  assetId: string,
  start: string = "-7d",
  stop?: string
): Promise<AssetStatistics | null> {
  const response = await getAssetStatistics(measurement, [assetId], start, stop);
  return response.data[assetId] || null;
}

/**
 * Calculate client-side statistics as fallback
 * Useful if v4/stats returns 504 error
 */
export function calculateStatistics(values: number[]): AssetStatistics {
  if (values.length === 0) {
    return {
      count: 0,
      first: 0,
      last: 0,
      max: 0,
      mean: 0,
      median: 0,
      min: 0,
      stdev: 0,
      sum: 0,
    };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  const mean = sum / values.length;

  // Calculate standard deviation
  const squaredDiffs = values.map((v) => Math.pow(v - mean, 2));
  const variance = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
  const stdev = Math.sqrt(variance);

  // Calculate median
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];

  return {
    count: values.length,
    first: values[0],
    last: values[values.length - 1],
    max: Math.max(...values),
    mean: parseFloat(mean.toFixed(2)),
    median: parseFloat(median.toFixed(2)),
    min: Math.min(...values),
    stdev: parseFloat(stdev.toFixed(2)),
    sum,
  };
}
