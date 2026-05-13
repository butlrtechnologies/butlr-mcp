/**
 * Shared helpers for occupancy tools (butlr_get_current_occupancy, butlr_get_occupancy_timeseries)
 *
 * Extracted from the two occupancy tools to eliminate ~200 lines of duplication.
 * Both tools share: topology fetching, sensor filtering, asset resolution,
 * measurement selection, and recommendation logic.
 */

import { apolloClient } from "../clients/graphql-client.js";
import { GET_ALL_SENSORS, GET_FULL_TOPOLOGY } from "../clients/queries/topology.js";
import type { Sensor, Site, Floor, Building, Zone } from "../clients/types.js";
import type { TimezoneMetadata } from "./timezone-helpers.js";
import type { MeasurementRecommendation, BaseMeasurementData } from "../types/responses.js";
import { detectAssetType } from "./asset-helpers.js";
import { isProductionSensor, throwIfGraphQLErrors } from "./graphql-helpers.js";
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
    throwIfGraphQLErrors(topoResult);
    throwIfGraphQLErrors(sensorsResult);
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

  // Filter sensors for this asset. Rooms get sensors via the flat
  // productionSensors list (joined by sensor.room_id). Zones get them
  // via the topology's floor.zones[i].sensors relation — they have
  // their own directly-attributed sensors, NOT inherited from any
  // notional "parent room" (zones and rooms are siblings under a
  // floor; the legacy zone.room_id field is decorative).
  let assetSensors: Sensor[];
  if (typedAssetType === "zone") {
    const zone = findZone(assetId, ctx.floors);
    assetSensors = (zone?.sensors ?? []).filter(isProductionSensor);
  } else {
    assetSensors = ctx.productionSensors.filter((s) => {
      const sensorFloorId = s.floor_id || s.floorID;
      const sensorRoomId = s.room_id || s.roomID;
      return typedAssetType === "floor" ? sensorFloorId === assetId : sensorRoomId === assetId;
    });
  }

  // Partition sensors by mode
  const presenceSensors = assetSensors.filter((s) => s.mode === "presence");

  let trafficSensors: Sensor[];
  switch (typedAssetType) {
    case "floor":
      // Floor-level traffic comes from the building/floor entrances.
      trafficSensors = assetSensors.filter((s) => s.mode === "traffic" && s.is_entrance === true);
      break;
    case "room":
      // Room-level traffic includes every traffic-mode sensor bound to the
      // room. `is_entrance` is a semantic flag indicating the sensor sits at
      // a building/floor entrance — it is not a routing flag. The Reporting
      // API aggregates by `room_id` regardless, so filtering on
      // `is_entrance === false` here would silently drop counts for rooms
      // whose sensors are all entrances (e.g. a café occupying the floor's
      // entry area).
      trafficSensors = assetSensors.filter((s) => s.mode === "traffic");
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
 * Find a zone object in the topology by id. Returns undefined if the zone
 * isn't present (e.g. stale id or topology that didn't include zones).
 */
function findZone(zoneId: string, floors: Floor[]): Zone | undefined {
  for (const floor of floors) {
    const zone = floor.zones?.find((z) => z.id === zoneId);
    if (zone) return zone;
  }
  return undefined;
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
 * not just whether sensors exist. When both measurement types fail, the reason
 * distinguishes three sub-cases (no sensors / sensors-but-quiet / call errored)
 * so downstream LLMs don't conflate "uninstrumented space" with "no recent reads."
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

  return {
    recommended_measurement: "none",
    recommendation_reason: buildFailureReason(presence, traffic, presenceHasData, trafficHasData),
  };
}

/**
 * Compose the recommendation_reason when neither presence nor traffic yielded a
 * usable reading. Prefers the more actionable of the two measurement types,
 * giving the customer something concrete to do next (instrument the space,
 * wait for the next read, check sensor health, or retry the call).
 *
 * Avoids the literal phrase "no occupancy data" — downstream LLMs were quoting
 * it verbatim and turning "quiet but instrumented" into "the space is
 * unmonitored," which is the opposite of true.
 */
function buildFailureReason(
  presence: BaseMeasurementData,
  traffic: BaseMeasurementData,
  presenceHasData: boolean,
  trafficHasData: boolean
): string {
  const presenceReason = describeMeasurementFailure("presence", presence, presenceHasData);
  const trafficReason = describeMeasurementFailure("traffic", traffic, trafficHasData);

  // Prefer presence when it's applicable to this asset (zones in particular
  // have traffic permanently unavailable, so the traffic reason is noise).
  // For non-zone assets, also prefer presence — it's the more informative
  // signal when both measurement types are configured but quiet.
  if (presenceReason) return presenceReason;
  if (trafficReason) return trafficReason;

  // Defensive fallback: neither measurement type was applicable to this asset
  // at all. Shouldn't happen in practice (an asset always has at least one
  // applicable measurement type), but the type system can't guarantee it.
  return "No recent occupancy reads. Check butlr_hardware_snapshot for sensor health.";
}

/**
 * Returns a customer-facing explanation of why a measurement type produced no
 * usable reading, or `undefined` if the measurement type is not applicable to
 * this asset (e.g. traffic on a zone).
 */
function describeMeasurementFailure(
  kind: "presence" | "traffic",
  data: BaseMeasurementData,
  hasData: boolean
): string | undefined {
  // Not applicable to this asset (e.g. traffic on a zone). The caller's
  // coverage_note already explains why; surfacing it here would be redundant.
  if (!data.available && !data.warning) return undefined;

  // The call errored. Surface the warning verbatim so the customer (and any
  // LLM reading the response) gets the actual failure mode.
  if (data.warning) {
    return `Tried to retrieve ${kind} occupancy but the request failed: ${data.warning}. Retry with a smaller asset set, or check butlr_hardware_snapshot for sensor health.`;
  }

  const sensorCount = data.sensor_count ?? 0;

  // Sensors are configured but the Reporting API had no reads in the query
  // window. Honest: we don't know if the space is empty or if the sensors
  // are stuck — point at hardware_snapshot for the health-check answer.
  if (sensorCount > 0 && !hasData) {
    return `Sensor(s) configured but no ${kind} reads in the last 5 minutes. The asset may currently be empty, or the sensor(s) may need a health check via butlr_hardware_snapshot.`;
  }

  // No sensors at all. The space is uninstrumented for this measurement type.
  return `No ${kind} sensors configured for this asset. Contact facilities to instrument it before requesting ${kind} occupancy.`;
}
