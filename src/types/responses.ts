/**
 * Shared response type interfaces for MCP tool outputs
 *
 * These types define the contract between tools and LLM consumers.
 * Every tool response MUST be typed — no `any` on public API surfaces.
 */

import type { Capacity, Area } from "../clients/types.js";
import type { TagMatch, TagName } from "../clients/queries/tags.js";
import type { TimezoneMetadata } from "../utils/timezone-helpers.js";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

/** Base measurement data shared between current-occupancy and timeseries tools */
export interface BaseMeasurementData {
  available: boolean;
  sensor_count?: number;
  entrance_sensor_count?: number;
  coverage_note?: string;
  warning?: string;
}

/** Single timeseries data point */
export interface TimeseriesPoint {
  timestamp: string;
  value: number;
}

/** Measurement data with timeseries array */
export interface TimeseriesMeasurementData extends BaseMeasurementData {
  timeseries: TimeseriesPoint[];
}

/** Measurement data with a single current reading */
export interface CurrentMeasurementData extends BaseMeasurementData {
  current_occupancy?: number;
  timestamp?: string;
}

/** Measurement recommendation output */
export interface MeasurementRecommendation {
  recommended_measurement: "presence" | "traffic" | "none";
  recommendation_reason: string;
}

/** Asset identity block used in occupancy tool responses */
export interface AssetIdentifier {
  asset_id: string;
  asset_type: string;
  asset_name?: string;
}

// ---------------------------------------------------------------------------
// butlr_available_rooms
// ---------------------------------------------------------------------------

export interface AvailableRoom {
  id: string;
  name: string;
  path: string;
  capacity: Capacity;
  area?: Area;
  tags?: string[];
  /** The query window in minutes (NOT how long the room has been empty) */
  data_window_minutes: number;
}

export interface BuildingContext {
  building_name: string;
  total_rooms: number;
  available_rooms: number;
  occupancy_percent: number;
}

export interface AvailableRoomsResponse {
  summary: string;
  available_rooms: AvailableRoom[];
  total_available: number;
  showing: number;
  timestamp: string;
  filtered_by?: Record<string, unknown>;
  building_context?: BuildingContext;
  warning?: string;
  /** Tag names from the request that did not resolve to any tag in this org. */
  unknown_tags?: ReadonlyArray<TagName>;
}

// ---------------------------------------------------------------------------
// butlr_space_busyness
// ---------------------------------------------------------------------------

export interface SpaceBusynessResponse {
  space: {
    id: string;
    name: string;
    type: "room" | "zone";
    path: string;
  };
  current: {
    occupancy: number;
    capacity: Capacity;
    utilization_percent: number | null;
    label: "quiet" | "moderate" | "busy" | null;
    capacity_configured: boolean;
    as_of: string;
  };
  trend?: {
    typical_for_time: number;
    vs_typical_percent: number;
    trend_label: "lighter" | "typical" | "busier";
    historical_context: string;
  };
  recommendation: string;
  summary: string;
  timestamp: string;
  warning?: string;
}

// ---------------------------------------------------------------------------
// butlr_traffic_flow
// ---------------------------------------------------------------------------

export interface HourlyTraffic {
  hour_utc: string;
  entries: number;
  exits: number;
  total_traffic: number;
  net_flow: number;
}

export interface TrafficFlowResponse {
  space: {
    id: string;
    name: string;
    type: "room";
    path: string;
    sensor_mode: "traffic";
  } & TimezoneMetadata;
  traffic: {
    total_entries: number;
    total_exits: number;
    total_traffic: number;
    net_flow: number;
    sensor_count: number;
    period: {
      start_utc: string;
      stop_utc: string;
      description: string;
    };
  };
  hourly_breakdown: HourlyTraffic[];
  peak_hour: HourlyTraffic | null;
  summary: string;
  timestamp: string;
  timezone_note: string;
  warning?: string;
}

// ---------------------------------------------------------------------------
// butlr_list_topology
// ---------------------------------------------------------------------------

/**
 * Ultra-compact tree node: [id, displayName] or [id, displayName, children].
 *
 * The tuple shape is intentionally `readonly`: nodes are emitted as a
 * response surface and consumers should not mutate them.
 */
export type TopologyNode =
  | readonly [string, string]
  | readonly [string, string, ReadonlyArray<TopologyNode>];

/**
 * Structured diagnostic emitted by `butlr_list_topology`. Callers should
 * branch on `kind` instead of parsing the prose `warning` string. The
 * prose `warning` remains the human-readable rendering of the same set —
 * both fields describe the same condition.
 *
 * Every embedded array is `readonly` because diagnostics are part
 * of the public response surface; mutating one would alter the response
 * after `executeListTopology` returns.
 */
export type TopologyDiagnostic =
  /** Upstream returned errors alongside data; tree may be incomplete. */
  | { kind: "partial_topology" }
  /** Every supplied `tag_names` was unknown — no tag-side match possible. */
  | { kind: "tag_no_match"; unknown_names: ReadonlyArray<TagName> }
  /** One or more `tag_names` did not resolve; the resolved subset still applies. */
  | { kind: "unknown_tags"; names: ReadonlyArray<TagName> }
  /**
   * `tag_match='all'` cannot be satisfied because at least one requested
   * tag is unknown. `partial_resolved_count` reports how many of the
   * requested names DID resolve (always >= 1 by construction —
   * all-unknown takes the `tag_no_match` branch instead).
   */
  | {
      kind: "tag_match_all_unsatisfiable";
      unknown_names: ReadonlyArray<TagName>;
      partial_resolved_count: number;
    }
  /** Every supplied tag resolved but none have associated entities. */
  | { kind: "tag_no_associations"; tag_match: TagMatch; tag_names: ReadonlyArray<TagName> }
  /** `asset_ids` did not resolve to any entity in the org. */
  | { kind: "asset_scope_empty"; asset_ids: ReadonlyArray<string> }
  /** `asset_ids` and `tag_names` both resolved but their subtrees do not overlap. */
  | { kind: "asset_tag_disjoint" }
  /** Every tagged-entity association points at entities missing from the active topology. */
  | { kind: "tag_associations_all_ghost"; total: number }
  /** Some tagged-entity associations point at missing entities; others resolved. */
  | { kind: "tag_associations_partial_ghost"; ghost: number; total: number }
  /** Dual-typo path with a cold topology cache — `asset_ids` were not validated. */
  | { kind: "asset_ids_unverified" }
  /** Upstream tag rows had missing/empty id or name fields and were skipped. */
  | { kind: "malformed_tag_rows"; count: number }
  /**
   * `tag_match='all'` — every requested tag resolved AND each carries at
   * least one association, but the per-tag SUBTREE intersection is empty
   * (e.g. tag A on Room X, tag B on Room Y in a different floor, with no
   * common ancestor). Distinct from `tag_no_associations` (no tag has any
   * associations) and `asset_tag_disjoint` (intersection narrowed by a
   * separate `asset_ids` filter).
   */
  | { kind: "tag_match_all_no_overlap"; resolved_names: ReadonlyArray<TagName> }
  /**
   * The composed filter resolved to a non-empty entity set, but every
   * matched entity sits outside the rendered tree window — i.e. the
   * `starting_depth` / `traversal_depth` slice excludes them. The user
   * should widen the depth window to see the matches.
   */
  | { kind: "depth_excludes_matches"; starting_depth: number; traversal_depth: number };

export interface ListTopologyResponse {
  tree: ReadonlyArray<TopologyNode>;
  query_params: {
    starting_depth: number;
    traversal_depth: number;
    asset_filter: ReadonlyArray<string> | "all";
    tag_filter?: {
      names: ReadonlyArray<TagName>;
      match: TagMatch;
    };
  };
  timestamp: string;
  /** Human-readable summary of every diagnostic emitted; back-compat with v0.1.x. */
  warning?: string;
  /** Structured diagnostics — preferred over `warning` for programmatic consumers. */
  warnings?: ReadonlyArray<TopologyDiagnostic>;
  unknown_tags?: ReadonlyArray<TagName>;
}

// ---------------------------------------------------------------------------
// butlr_fetch_entity_details
// ---------------------------------------------------------------------------

export interface EntityResult {
  id: string;
  _type: string;
  error?: string;
  [key: string]: unknown;
}

export interface FetchEntityDetailsResponse {
  entities: EntityResult[];
  requested_count: number;
  fetched_count: number;
  timestamp: string;
  warning?: string;
}

// ---------------------------------------------------------------------------
// butlr_get_occupancy_timeseries
// ---------------------------------------------------------------------------

export type AssetOccupancyTimeseries = AssetIdentifier &
  TimezoneMetadata &
  MeasurementRecommendation & {
    presence: TimeseriesMeasurementData;
    traffic: TimeseriesMeasurementData;
    timezone_warning?: string;
  };

export interface OccupancyTimeseriesResponse {
  assets: AssetOccupancyTimeseries[];
  interval: string;
  start: string;
  stop: string;
  timezone_note: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// butlr_get_current_occupancy
// ---------------------------------------------------------------------------

export type AssetCurrentOccupancy = AssetIdentifier &
  TimezoneMetadata &
  MeasurementRecommendation & {
    presence: CurrentMeasurementData;
    traffic: CurrentMeasurementData;
    timezone_warning?: string;
  };

export interface CurrentOccupancyResponse {
  assets: AssetCurrentOccupancy[];
  timestamp: string;
  timezone_note: string;
}

// ---------------------------------------------------------------------------
// butlr_hardware_snapshot
// ---------------------------------------------------------------------------

export type BatteryStatus = "critical" | "due_soon" | "healthy" | "unknown" | "no_battery";

export interface BatteryDetail {
  sensor_id: string;
  sensor_name: string;
  mac_address: string;
  path: string;
  status: BatteryStatus;
  battery_change_by_date: string;
  days_remaining: number;
  last_battery_change_date?: string;
  next_battery_change_date?: string;
}

export interface FloorBreakdown {
  floor_id: string;
  floor_name: string;
  sensors_online: number;
  sensors_total: number;
  percent_online: number;
  batteries_critical: number;
  batteries_due_soon: number;
}

export interface OfflineDevice {
  type: "sensor" | "hive";
  id: string;
  name: string;
  serial_number?: string;
  mac_address?: string;
  path: string;
  last_heartbeat?: string;
  hours_offline?: number;
}

export interface HardwareSnapshotResponse {
  summary: string;
  sensors: {
    total: number;
    online: number;
    offline: number;
    percent_online: number;
  };
  hives: {
    total: number;
    online: number;
    offline: number;
    percent_online: number;
  };
  battery_health: Record<string, number>;
  scope: {
    type: string;
    id?: string;
    name: string;
  };
  timestamp: string;
  test_devices_excluded?: {
    sensors: { mirror: number; placeholder: number; total: number };
    hives: { fake: number; placeholder: number; total: number };
    note: string;
  };
  battery_details?: BatteryDetail[];
  battery_details_truncated?: boolean;
  battery_details_total?: number;
  breakdown_by_floor?: FloorBreakdown[];
  offline_devices?: OfflineDevice[];
  offline_devices_summary?: {
    sensors_offline: number;
    hives_offline: number;
    total_offline: number;
    showing: number;
  };
  offline_devices_truncated?: boolean;
  offline_devices_total?: number;
}
