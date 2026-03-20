import { authClient } from "./auth-client.js";
import { debug } from "../utils/debug.js";

/**
 * Structured API error with status code for proper error translation
 */
export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const BASE_URL = process.env.BUTLR_BASE_URL || "https://api.butlr.io";
const REPORTING_ENDPOINT = `${BASE_URL}/api/v3/reporting`;

/**
 * Field mapping: Asset type → v3 API filter field
 * Corrected based on API_CONSTRAINTS.md analysis
 */
const FILTER_FIELD_MAP: Record<string, string> = {
  site: "clients", // Organizations/clients
  building: "buildings",
  floor: "spaces", // Floors are called "spaces" in v3 API
  room: "rooms",
  zone: "zones",
  sensor: "sensors",
  hive: "hives",
};

/**
 * Measurement mapping: Asset type → v3 API measurement name
 */
const MEASUREMENT_MAP: Record<string, string> = {
  room: "room_occupancy",
  zone: "zone_occupancy",
  floor: "floor_occupancy",
  traffic: "traffic", // For traffic-mode sensors
};

/**
 * v3 Reporting API Request Structure
 * Based on butlr-api-container/pkg/reporting/models/request.go
 */
export interface ReportingRequest {
  group_by?: {
    order?: string[]; // e.g., ['room_id', 'building_id']
    raw?: boolean; // true = raw points, false = nested grouping
  };
  window?: {
    every: string; // '1m', '5m', '15m', '30m', '1h', '6h', '12h', '1d'
    function: string; // 'mean', 'max', 'min', 'sum', 'first', 'last'
    offset?: string;
    timezone?: string; // 'America/Los_Angeles', 'UTC'
    create_empty?: boolean;
    fill?: {
      use_previous?: boolean;
      value?: number;
    };
  };
  filter: {
    measurements: string[]; // Required: ['room_occupancy', 'traffic']
    start: string; // ISO-8601 or relative '-24h'
    stop?: string; // Defaults to 'now'
    spaces?: { eq: string[] }; // Floors
    rooms?: { eq: string[] };
    zones?: { eq: string[] };
    tags?: { eq: string[] };
    clients?: { eq: string[] }; // Sites/orgs
    buildings?: { eq: string[] };
    value?: {
      gte?: number;
      lte?: number;
      gt?: number;
      lt?: number;
    };
    calibrated?: string; // 'yes' or 'no'
    time_constraints?: {
      time_ranges?: Array<{ start: string; stop: string }>;
      exclude_days_of_week?: string[]; // ['saturday', 'sunday']
    };
  };
  options?: {
    format?: "json" | "csv";
    precision?: "s" | "ms" | "us" | "ns";
    timestamp?: "RFC3339";
    includeCalibrationPoints?: boolean;
  };
  paginate?: {
    page: number; // 1-indexed
    limit: number;
  };
  calibrationPoints?: Array<{
    timestamp: string;
    occupancy: number;
    type: "user_provided" | "pir_zero";
  }>;
}

/**
 * v3 Reporting API Response Structure
 */
export interface ReportingResponse {
  data: Array<{
    field: string;
    measurement: string;
    time: string; // RFC3339
    value: number;
    timezone_offset?: string;
    building_id?: string;
    building_name?: string;
    space_id?: string; // Floor ID
    space_name?: string; // Floor name
    room_id?: string;
    room_name?: string;
    zone_id?: string;
    hive_id?: string;
    sensor_id?: string;
    mac_address?: string;
    [key: string]: unknown;
  }>;
  page_info?: {
    page: number;
    page_item_count: number;
    total_item_count: number;
    total_pages: number;
  };
  calibrationPoints?: unknown[];
}

/**
 * Normalized data point (RFC3339 → ISO-8601)
 */
export interface NormalizedDataPoint {
  start: string; // ISO-8601
  stop?: string; // ISO-8601
  measurement: string;
  value: number;
  asset_id?: string;
  asset_name?: string;
  [key: string]: unknown;
}

/**
 * Helper to get filter field name for asset type
 */
export function getFilterField(assetType: string): string {
  const field = FILTER_FIELD_MAP[assetType];
  if (!field) {
    throw new Error(
      `Unknown asset type: ${assetType}. Valid types: ${Object.keys(FILTER_FIELD_MAP).join(", ")}`
    );
  }
  return field;
}

/**
 * Helper to get measurement name for asset type
 */
export function getMeasurement(assetType: string): string {
  const measurement = MEASUREMENT_MAP[assetType];
  if (!measurement) {
    throw new Error(
      `No measurement mapping for asset type: ${assetType}. Valid types: ${Object.keys(MEASUREMENT_MAP).join(", ")}`
    );
  }
  return measurement;
}

/**
 * Normalize RFC3339 timestamp to ISO-8601
 */
export function normalizeTimestamp(rfc3339: string): string {
  if (!rfc3339) {
    debug("reporting-client", `Invalid timestamp received: ${rfc3339}`);
    return "";
  }
  try {
    const date = new Date(rfc3339);
    if (isNaN(date.getTime())) {
      debug("reporting-client", `Invalid timestamp received: ${rfc3339}`);
      return "";
    }
    return date.toISOString();
  } catch (error) {
    debug("reporting-client", `Failed to normalize timestamp ${rfc3339}:`, error);
    return "";
  }
}

/**
 * Query v3 Reporting API
 */
export async function queryReporting(requestBody: ReportingRequest): Promise<ReportingResponse> {
  debug("reporting-client", `POST ${REPORTING_ENDPOINT}`, JSON.stringify(requestBody, null, 2));

  try {
    // Get auth token
    const token = await authClient.getToken();

    // Make request
    const response = await fetch(REPORTING_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      debug("reporting-client", `API error body: ${errorBody}`);
      throw new ApiError(
        response.status,
        `Butlr API error (${response.status}). Enable DEBUG=butlr-mcp for details.`
      );
    }

    const data = (await response.json()) as ReportingResponse;

    debug("reporting-client", `Response: ${data.data?.length || 0} data points`);

    return data;
  } catch (error: any) {
    debug("reporting-client", "Request failed:", error);

    // Translate common errors using structured ApiError
    if (error instanceof ApiError) {
      if (error.statusCode === 401 || error.statusCode === 403) {
        authClient.clearToken();
        throw new ApiError(
          error.statusCode,
          "Authentication failed. Check BUTLR_CLIENT_ID and BUTLR_CLIENT_SECRET."
        );
      }

      if (error.statusCode === 429) {
        throw new ApiError(429, "Rate limit exceeded. Please retry after a few seconds.");
      }

      if (error.statusCode === 400) {
        throw new ApiError(400, "Invalid request parameters. Check your filter configuration.");
      }
    }

    throw error;
  }
}

/**
 * Request builder for common occupancy queries
 */
export class ReportingRequestBuilder {
  private request: ReportingRequest;

  constructor() {
    this.request = {
      filter: {
        measurements: [],
        start: "-24h", // Default to last 24 hours
      },
      options: {
        format: "json",
        timestamp: "RFC3339",
      },
    };
  }

  /**
   * Set asset IDs to query
   */
  assets(assetType: string, ids: string[]): this {
    const filterField = getFilterField(assetType);
    this.request.filter[filterField as keyof typeof this.request.filter] = {
      eq: ids,
    } as any;
    return this;
  }

  /**
   * Set measurements (auto-mapped from asset type if not provided)
   */
  measurements(measurements: string[]): this {
    this.request.filter.measurements = measurements;
    return this;
  }

  /**
   * Auto-set measurement based on asset type
   */
  measurementForAssetType(assetType: string): this {
    const measurement = getMeasurement(assetType);
    this.request.filter.measurements = [measurement];
    return this;
  }

  /**
   * Set time range (ISO-8601 or relative like '-24h')
   */
  timeRange(start: string, stop?: string): this {
    this.request.filter.start = start;
    // Only set stop if it's not "now" (API doesn't accept "now" as stop value)
    if (stop && stop !== "now") {
      this.request.filter.stop = stop;
    }
    return this;
  }

  /**
   * Set window aggregation
   */
  window(
    every: string,
    func: "mean" | "max" | "min" | "sum" | "first" | "last" | "median",
    timezone?: string
  ): this {
    this.request.window = {
      every,
      function: func,
      timezone: timezone || process.env.BUTLR_TIMEZONE || "UTC",
    };
    return this;
  }

  /**
   * Set grouping
   */
  groupBy(order: string[], raw: boolean = true): this {
    this.request.group_by = { order, raw };
    return this;
  }

  /**
   * Set pagination
   */
  paginate(page: number, limit: number): this {
    this.request.paginate = { page, limit };
    return this;
  }

  /**
   * Set tags filter
   */
  tags(tags: string[]): this {
    this.request.filter.tags = { eq: tags };
    return this;
  }

  /**
   * Build and return the request
   */
  build(): ReportingRequest {
    // Validation
    if (!this.request.filter.measurements.length) {
      throw new Error("At least one measurement is required");
    }

    return this.request;
  }

  /**
   * Build and execute the query
   */
  async execute(): Promise<ReportingResponse> {
    return queryReporting(this.build());
  }
}

/**
 * Convenience function: Get current occupancy for assets
 * Implements fallback strategy: presence first, then traffic (matches dashboard behavior)
 */
export async function getCurrentOccupancy(
  assetType: string,
  assetIds: string[]
): Promise<NormalizedDataPoint[]> {
  if (assetType !== "room" && assetType !== "zone" && assetType !== "floor") {
    throw new Error(`getCurrentOccupancy only supports room, zone, or floor. Got: ${assetType}`);
  }

  // Calculate time range: 5 minutes ago to now
  // Matches dashboard approach: recent window with median for noise reduction
  const now = new Date();
  const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);

  const start = fiveMinAgo.toISOString();
  const stop = now.toISOString();

  // Try presence data first (room_occupancy, zone_occupancy, floor_occupancy)
  const presenceMeasurement = getMeasurement(assetType);

  const presenceRequest = new ReportingRequestBuilder()
    .assets(assetType, assetIds)
    .measurements([presenceMeasurement])
    .timeRange(start, stop)
    .window("60s", "median") // Use median to smooth noise (matches dashboard)
    .build();

  // Add value filter and raw grouping (no order field - simpler response)
  presenceRequest.filter.value = { gte: 0 };
  presenceRequest.group_by = { raw: true };

  // Build traffic request in parallel with presence
  const trafficMeasurement = `traffic_${presenceMeasurement}`;

  const trafficRequest = new ReportingRequestBuilder()
    .assets(assetType, assetIds)
    .measurements([trafficMeasurement])
    .timeRange(start, stop)
    .window("60s", "median") // Use median to smooth noise
    .build();

  trafficRequest.filter.calibrated = "true";
  trafficRequest.filter.value = { gte: 0 };
  trafficRequest.group_by = { raw: true };

  // Run both queries in parallel — they're independent
  const [presenceResult, trafficResult] = await Promise.allSettled([
    queryReporting(presenceRequest),
    queryReporting(trafficRequest),
  ]);

  const presenceResponse =
    presenceResult.status === "fulfilled" ? presenceResult.value : { data: [] };
  const trafficResponse = trafficResult.status === "fulfilled" ? trafficResult.value : { data: [] };

  if (trafficResult.status === "rejected") {
    debug(
      "reporting-client",
      "Traffic query failed (may not have traffic sensors):",
      trafficResult.reason
    );
  }

  // Normalize presence data
  // Response structure: { "room_123": { "2025-10-10T00:00:00Z": { "max": 5 } } }
  const presenceData: Record<string, NormalizedDataPoint> = {};

  if (presenceResponse.data && typeof presenceResponse.data === "object") {
    for (const [assetId, timeSeriesData] of Object.entries(presenceResponse.data)) {
      if (!timeSeriesData || typeof timeSeriesData !== "object") continue;

      const timestamps = Object.keys(timeSeriesData).sort();
      if (timestamps.length === 0) continue;

      const latestTimestamp = timestamps[timestamps.length - 1];
      const latestData = (timeSeriesData as Record<string, unknown>)[latestTimestamp] as
        | Record<string, number>
        | undefined;

      if (latestData && typeof latestData === "object") {
        const value =
          latestData.median ?? latestData.max ?? latestData.mean ?? latestData.last ?? 0;

        presenceData[assetId] = {
          start: normalizeTimestamp(latestTimestamp),
          measurement: presenceMeasurement,
          value: value,
          asset_id: assetId,
          asset_name: undefined,
        };
      }
    }
  }

  // Parse traffic data (different structure - timestamps map to arrays)
  const trafficData: Record<string, NormalizedDataPoint> = {};

  if (trafficResponse.data && typeof trafficResponse.data === "object") {
    for (const [assetId, timeSeriesData] of Object.entries(trafficResponse.data)) {
      if (!timeSeriesData || typeof timeSeriesData !== "object") continue;

      // Get all timestamps for this asset
      const timestamps = Object.keys(timeSeriesData).sort();
      if (timestamps.length === 0) continue;

      // Get the latest timestamp
      const latestTimestamp = timestamps[timestamps.length - 1];
      const latestData = (timeSeriesData as any)[latestTimestamp];

      // Traffic response can be array or object
      let value = 0;
      if (Array.isArray(latestData) && latestData.length > 0) {
        // Extract value from array
        value = latestData[0]?.value ?? 0;
      } else if (latestData && typeof latestData === "object") {
        // Extract median (smoothed value)
        value = latestData.median ?? latestData.max ?? latestData.mean ?? latestData.last ?? 0;
      }

      trafficData[assetId] = {
        start: normalizeTimestamp(latestTimestamp),
        measurement: trafficMeasurement,
        value: value,
        asset_id: assetId,
        asset_name: undefined,
      };
    }
  }

  // Merge results: Use HIGHEST value from either source
  const result: NormalizedDataPoint[] = [];
  const allAssetIds = new Set([...Object.keys(presenceData), ...Object.keys(trafficData)]);

  for (const assetId of allAssetIds) {
    const presencePoint = presenceData[assetId];
    const trafficPoint = trafficData[assetId];

    // Use whichever has higher value (or exists if only one does)
    if (presencePoint && trafficPoint) {
      // Both exist - use higher value
      result.push(presencePoint.value >= trafficPoint.value ? presencePoint : trafficPoint);
    } else if (presencePoint) {
      result.push(presencePoint);
    } else if (trafficPoint) {
      result.push(trafficPoint);
    }
  }

  return result;
}
