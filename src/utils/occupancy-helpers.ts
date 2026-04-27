/**
 * Shared helpers for occupancy tools (butlr_get_current_occupancy, butlr_get_occupancy_timeseries)
 *
 * Extracted from the two occupancy tools to eliminate ~200 lines of duplication.
 * Both tools share: topology fetching, sensor filtering, asset resolution,
 * measurement selection, and recommendation logic.
 */

import { apolloClient } from "../clients/graphql-client.js";
import { GET_ALL_SENSORS, GET_FULL_TOPOLOGY } from "../clients/queries/topology.js";
import type { Sensor, Site, Floor, Building } from "../clients/types.js";
import type { TimezoneMetadata } from "./timezone-helpers.js";
import type { MeasurementRecommendation, BaseMeasurementData } from "../types/responses.js";
import { detectAssetType } from "./asset-helpers.js";
import { isProductionSensor } from "./graphql-helpers.js";
import { getTimezoneForAsset, buildTimezoneMetadata } from "./timezone-helpers.js";
import { rethrowIfGraphQLError } from "./graphql-helpers.js";

/**
 * Topology and sensor data fetched in parallel for occupancy tools.
 */
export interface TopologyContext {
  sites: Site[];
  buildings: Building[];
  floors: Floor[];
  productionSensors: Sensor[];
}

/**
 * Fetch topology and production sensors in a single parallel call.
 * Shared by both current-occupancy and timeseries tools.
 */
export async function fetchTopologyAndSensors(): Promise<TopologyContext> {
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
  } catch (error: unknown) {
    rethrowIfGraphQLError(error);
    throw error;
  }

  const sites = topoResult.data?.sites?.data || [];
  const buildings = sites.flatMap((s) => s.buildings || []);
  const floors = buildings.flatMap((b) => b.floors || []);
  const allSensors = sensorsResult.data?.sensors?.data || [];
  const productionSensors = allSensors.filter(isProductionSensor);

  return { sites, buildings, floors, productionSensors };
}

/**
 * Resolved context for a single asset, including timezone, name, and sensor partitioning.
 */
export interface AssetContext {
  assetType: "floor" | "room" | "zone";
  assetName: string | undefined;
  timezone: string;
  tzMetadata: TimezoneMetadata;
  timezoneFallback: boolean;
  timezoneWarning?: string;
  presenceSensors: Sensor[];
  trafficSensors: Sensor[];
}

/**
 * Resolve full context for an asset ID: type validation, name, timezone, sensor partitioning.
 */
export function resolveAssetContext(assetId: string, ctx: TopologyContext): AssetContext {
  const assetType = detectAssetType(assetId);

  if (!["floor", "room", "zone"].includes(assetType)) {
    throw new Error(`Asset ${assetId} must be a floor, room, or zone. Got: ${assetType}`);
  }

  const typedAssetType = assetType as "floor" | "room" | "zone";

  // Resolve timezone (always returns a value; falls back to UTC if site timezone is null)
  const resolved = getTimezoneForAsset(
    assetId,
    typedAssetType,
    ctx.floors,
    ctx.buildings,
    ctx.sites
  );

  const timezone = resolved.timezone;
  const tzMetadata = buildTimezoneMetadata(timezone);
  const timezoneWarning = resolved.isFallback
    ? `Could not determine site timezone for asset ${assetId}. Using ${timezone} as fallback — timestamps may not reflect the site's actual local time.`
    : undefined;

  // Resolve asset name
  const assetName = findAssetName(assetId, typedAssetType, ctx.floors);

  // Filter sensors for this asset
  const assetSensors = ctx.productionSensors.filter((s) => {
    const sensorFloorId = s.floor_id || s.floorID;
    const sensorRoomId = s.room_id || s.roomID;

    switch (typedAssetType) {
      case "floor":
        return sensorFloorId === assetId;
      case "room":
        return sensorRoomId === assetId;
      case "zone":
        return false; // Zones don't have direct sensor assignments
    }
  });

  // Partition sensors by mode
  const presenceSensors = assetSensors.filter((s) => s.mode === "presence");

  let trafficSensors: Sensor[];
  switch (typedAssetType) {
    case "floor":
      trafficSensors = assetSensors.filter((s) => s.mode === "traffic" && s.is_entrance === true);
      break;
    case "room":
      trafficSensors = assetSensors.filter((s) => s.mode === "traffic" && s.is_entrance === false);
      break;
    default:
      trafficSensors = [];
  }

  return {
    assetType: typedAssetType,
    assetName,
    timezone,
    tzMetadata,
    timezoneFallback: resolved.isFallback,
    timezoneWarning,
    presenceSensors,
    trafficSensors,
  };
}

/**
 * Find the display name for an asset by searching the topology.
 */
function findAssetName(
  assetId: string,
  assetType: "floor" | "room" | "zone",
  floors: Floor[]
): string | undefined {
  switch (assetType) {
    case "floor":
      return floors.find((f) => f.id === assetId)?.name;
    case "room":
      for (const floor of floors) {
        const room = floor.rooms?.find((r) => r.id === assetId);
        if (room) return room.name;
      }
      return undefined;
    case "zone":
      for (const floor of floors) {
        const zone = floor.zones?.find((z) => z.id === assetId);
        if (zone) return zone.name;
      }
      return undefined;
  }
}

/**
 * Get the measurement name for presence data based on asset type.
 */
export function getPresenceMeasurement(assetType: "floor" | "room" | "zone"): string {
  switch (assetType) {
    case "floor":
      return "floor_occupancy";
    case "room":
      return "room_occupancy";
    case "zone":
      return "zone_occupancy";
  }
}

/**
 * Get the measurement name for traffic data based on asset type.
 */
export function getTrafficMeasurement(assetType: "floor" | "room"): string {
  switch (assetType) {
    case "floor":
      return "traffic_floor_occupancy";
    case "room":
      return "traffic_room_occupancy";
  }
}

/**
 * Build coverage note for presence measurement.
 */
export function getPresenceCoverageNote(
  assetType: "floor" | "room" | "zone",
  sensorCount: number
): string {
  if (sensorCount === 0) {
    return assetType === "zone"
      ? "Zones support presence measurement only."
      : `No presence sensors on this ${assetType}.`;
  }
  return assetType === "floor"
    ? `Presence from ${sensorCount} sensors (may not cover entire floor).`
    : `Presence from ${sensorCount} sensors.`;
}

/**
 * Build coverage note for traffic measurement.
 */
export function getTrafficCoverageNote(
  assetType: "floor" | "room" | "zone",
  sensorCount: number
): string {
  if (sensorCount === 0) {
    if (assetType === "zone") return "Zones do not support traffic.";
    if (assetType === "floor") return "No main entrance sensors.";
    return "No traffic sensors.";
  }
  return assetType === "floor"
    ? `Traffic from ${sensorCount} main entrance sensors.`
    : `Traffic from ${sensorCount} sensors.`;
}

/**
 * Build measurement recommendation based on data availability AND query success.
 *
 * Unlike the previous implementation, this checks whether data was actually retrieved,
 * not just whether sensors exist.
 */
export function buildRecommendation(
  presence: BaseMeasurementData,
  traffic: BaseMeasurementData,
  presenceHasData: boolean,
  trafficHasData: boolean
): MeasurementRecommendation {
  const presenceSucceeded = presence.available && presenceHasData && !presence.warning;
  const trafficSucceeded = traffic.available && trafficHasData && !traffic.warning;

  if (presenceSucceeded && trafficSucceeded) {
    return {
      recommended_measurement: "presence",
      recommendation_reason:
        "Both available. Presence shows current occupants; traffic shows flow.",
    };
  }
  if (presenceSucceeded) {
    return {
      recommended_measurement: "presence",
      recommendation_reason: "Presence available (direct occupant count).",
    };
  }
  if (trafficSucceeded) {
    return {
      recommended_measurement: "traffic",
      recommendation_reason: "Traffic available (entry/exit counts).",
    };
  }

  const failureReason = presence.warning || traffic.warning || "No occupancy data available.";
  return {
    recommended_measurement: "none",
    recommendation_reason: failureReason,
  };
}
