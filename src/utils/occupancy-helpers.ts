/**
 * Shared helpers for occupancy tools (butlr_get_current_occupancy, butlr_get_occupancy_timeseries)
 *
 * Extracted from the two occupancy tools to eliminate ~200 lines of duplication.
 * Both tools share: topology fetching, sensor filtering, asset resolution,
 * measurement selection, and recommendation logic.
 */

import { apolloClient } from "../clients/graphql-client.js";
import {
  GET_ALL_SENSORS,
  GET_FULL_TOPOLOGY,
  GET_SENSORS_BY_IDS,
  GET_SENSORS_BY_ROOM_IDS,
} from "../clients/queries/topology.js";
import { queryWithArchiveFallback } from "../clients/archive-fallback.js";
import type { Sensor, Site, Floor, Building, Room, Zone } from "../clients/types.js";
import type { TimezoneMetadata } from "./timezone-helpers.js";
import type {
  MeasurementRecommendation,
  BaseMeasurementData,
  SpaceLifecycle,
} from "../types/responses.js";
import { detectAssetType } from "./asset-helpers.js";
import { isProductionSensor, throwIfGraphQLErrors } from "./graphql-helpers.js";
import { ApiError } from "../clients/reporting-client.js";
import { declaredHistoryEnd, fetchHistoryEnd } from "./history-end.js";
import { debug } from "./debug.js";
import { getCachedHistoryEnd, setCachedHistoryEnd } from "../cache/history-end-cache.js";
import { shareInFlight } from "./in-flight.js";
import { getTimezoneForAsset, buildTimezoneMetadata, isValidTimezone } from "./timezone-helpers.js";
import { rethrowIfGraphQLError } from "./graphql-helpers.js";
import {
  describeSpaceRef,
  findSpace,
  indexReplacements,
  isRetired,
  formatArchiveDate,
  toSpaceRef,
  type SpaceRef,
} from "./archived-spaces.js";

/**
 * The spatial hierarchy on its own, flattened for lookup.
 *
 * Split out from TopologyContext because a caller that resolves ONE known
 * sensor needs the hierarchy but not the org's whole sensor inventory.
 */
export interface TopologyOnly {
  sites: Site[];
  buildings: Building[];
  floors: Floor[];
}

/**
 * Topology and sensor data fetched in parallel for occupancy tools.
 */
export interface TopologyContext extends TopologyOnly {
  productionSensors: Sensor[];
  /**
   * Every sensor row, test/mirror devices and MAC-less placeholders
   * included. Used only to decide whether a room has ANY sensor attributed
   * (a provisioned sensor with no MAC yet is a real device with real
   * reporting rows). Falls back to `productionSensors` when absent.
   */
  allSensors?: Sensor[];
}

/**
 * Fetch and flatten the spatial hierarchy (sites, buildings, floors).
 */
export async function fetchTopology(): Promise<TopologyOnly> {
  let topoResult;

  try {
    topoResult = await queryWithArchiveFallback<{ sites: { data: Site[] } }>(GET_FULL_TOPOLOGY);
    throwIfGraphQLErrors(topoResult);
  } catch (error: unknown) {
    rethrowIfGraphQLError(error);
    throw error;
  }

  const sites = topoResult.data?.sites?.data || [];
  const buildings = sites.flatMap((s) => s.buildings || []);
  const floors = buildings.flatMap((b) => b.floors || []);

  return { sites, buildings, floors };
}

/**
 * Fetch the org's full sensor inventory, test/mirror devices removed.
 */
export async function fetchProductionSensors(): Promise<Sensor[]> {
  return (await fetchAllSensors()).filter(isProductionSensor);
}

/**
 * Fetch the org's full sensor inventory, unfiltered.
 */
async function fetchAllSensors(): Promise<Sensor[]> {
  let sensorsResult;

  try {
    sensorsResult = await apolloClient.query<{ sensors: { data: Sensor[] } }>({
      query: GET_ALL_SENSORS,
      fetchPolicy: "network-only",
    });
    throwIfGraphQLErrors(sensorsResult);
  } catch (error: unknown) {
    rethrowIfGraphQLError(error);
    throw error;
  }

  return sensorsResult.data?.sensors?.data || [];
}

/**
 * Fetch specific sensors by ID.
 *
 * Unlike fetchProductionSensors this does NOT filter test devices: the caller
 * asked for these exact IDs, so a mirror device has to come back so the caller
 * can say so, rather than silently becoming "not found".
 */
export async function fetchSensorsByIds(ids: string[]): Promise<Sensor[]> {
  if (ids.length === 0) return [];

  let result;

  try {
    result = await apolloClient.query<{ sensors: { data: Sensor[] } }>({
      query: GET_SENSORS_BY_IDS,
      variables: { ids },
      fetchPolicy: "network-only",
    });
    throwIfGraphQLErrors(result);
  } catch (error: unknown) {
    rethrowIfGraphQLError(error);
    throw error;
  }

  return result.data?.sensors?.data || [];
}

/**
 * Fetch the sensors bound to specific rooms via `sensors(room_ids:)`.
 *
 * Like fetchSensorsByIds this does NOT filter test devices: the caller scoped
 * the query to rooms it already knows about, and the row set has to be
 * complete so the caller can apply whatever gate fits its use (e.g.
 * isKnownTestSensor for a refusal gate that must not drop MAC-less
 * placeholder rows).
 */
export async function fetchSensorsByRoomIds(roomIds: string[]): Promise<Sensor[]> {
  if (roomIds.length === 0) return [];

  let result;

  try {
    result = await apolloClient.query<{ sensors: { data: Sensor[] } }>({
      query: GET_SENSORS_BY_ROOM_IDS,
      variables: { roomIds },
      fetchPolicy: "network-only",
    });
    throwIfGraphQLErrors(result);
  } catch (error: unknown) {
    rethrowIfGraphQLError(error);
    throw error;
  }

  return result.data?.sensors?.data || [];
}

/**
 * Fetch topology and production sensors in a single parallel call.
 * Shared by both current-occupancy and timeseries tools.
 */
export async function fetchTopologyAndSensors(): Promise<TopologyContext> {
  const [topology, allSensors] = await Promise.all([fetchTopology(), fetchAllSensors()]);

  return { ...topology, productionSensors: allSensors.filter(isProductionSensor), allSensors };
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
  /**
   * Every sensor row attributed to the asset, of any mode, test/mirror and
   * MAC-less rows included. Zero is required for a space to be retired or
   * sensorless (see isRetiredSpace / isSensorlessSpace).
   */
  attributedSensorCount: number;
  /**
   * Whether the asset ID resolved in the fetched topology. False for a typo,
   * a deleted space or another org's ID; such an asset is never treated as
   * sensorless and keeps the plain "not found" handling.
   */
  found: boolean;
  /** RFC 3339 archive time; set only for an archived room/zone. */
  archivedAt?: string;
  /** RFC 3339 start of the current sensorless period (API #3038), when known. */
  sensorsRemovedAt?: string;
  /** `archivedAt` as a site-local YYYY-MM-DD; set with `archivedAt`. */
  archivedOn?: string;
  /** `sensorsRemovedAt` as a site-local YYYY-MM-DD; set with `sensorsRemovedAt`. */
  sensorsRemovedOn?: string;
  /** The space this one replaced, when `replacesID` is set. */
  replaces?: SpaceRef;
  /** Spaces that replaced this one (several after a split). */
  replacedBy?: SpaceRef[];
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

  // One walk over the floors finds the room/zone itself: its name, its
  // zone sensors and its archive fields all come from the same object.
  const space =
    typedAssetType === "floor" ? undefined : findSpace(ctx.floors, typedAssetType, assetId);
  const assetName =
    typedAssetType === "floor" ? ctx.floors.find((f) => f.id === assetId)?.name : space?.name;

  // Filter sensors for this asset. Rooms get sensors via the flat
  // productionSensors list (joined by sensor.room_id). Zones get them
  // via the topology's floor.zones[i].sensors relation — they have
  // their own directly-attributed sensors, NOT inherited from any
  // notional "parent room" (zones and rooms are siblings under a
  // floor; the legacy zone.room_id field is decorative).
  let assetSensors: Sensor[];
  if (typedAssetType === "zone") {
    assetSensors = ((space as Zone | undefined)?.sensors ?? []).filter(isProductionSensor);
  } else {
    assetSensors = ctx.productionSensors.filter((s) => {
      const sensorFloorId = s.floor_id || s.floorID;
      const sensorRoomId = s.room_id || s.roomID;
      return typedAssetType === "floor" ? sensorFloorId === assetId : sensorRoomId === assetId;
    });
  }

  // Whether ANY sensor is attributed, whatever its kind: test/mirror and
  // MAC-less rows count here (a provisioned sensor without a MAC yet is a
  // real device), even though they are left out of the counts above.
  const attributedSensorCount =
    typedAssetType === "zone"
      ? ((space as Zone | undefined)?.sensors ?? []).length
      : (ctx.allSensors ?? ctx.productionSensors).filter((s) =>
          typedAssetType === "floor"
            ? (s.floor_id || s.floorID) === assetId
            : (s.room_id || s.roomID) === assetId
        ).length;

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

  const context: AssetContext = {
    assetType: typedAssetType,
    assetName,
    timezone,
    tzMetadata,
    timezoneFallback: resolved.isFallback,
    timezoneWarning,
    presenceSensors,
    trafficSensors,
    attributedSensorCount,
    found:
      typedAssetType === "floor" ? ctx.floors.some((f) => f.id === assetId) : space !== undefined,
  };

  // Archive state and replaced-space links (rooms and zones only). Absent
  // fields — including every space when the API predates them — leave the
  // context as an active space that replaces nothing.
  if (typedAssetType !== "floor") {
    if (space?.archivedAt) {
      context.archivedAt = space.archivedAt;
      context.archivedOn = formatArchiveDate(space.archivedAt, timezone);
    }
    if (space?.sensorsRemovedAt) {
      context.sensorsRemovedAt = space.sensorsRemovedAt;
      context.sensorsRemovedOn = formatArchiveDate(space.sensorsRemovedAt, timezone);
    }
    if (space?.replacesID) {
      context.replaces = toSpaceRef(
        space.replacesID,
        findSpace(ctx.floors, typedAssetType, space.replacesID)
      );
    }
    const successors = indexReplacements(ctx.floors).get(assetId) ?? [];
    if (successors.length > 0) {
      context.replacedBy = successors.map((s) => toSpaceRef(s.id, s));
    }
  }

  return context;
}

/**
 * Outcome of the history-end probe (see probeHistory).
 * - skipped: no probe was sent (see needsHistoryProbe).
 * - ok: `endDay` is the last full day of recorded history, or null when
 *   none was found since `windowStart` (older history may still exist).
 *   `outsideWindow` marks a declared end older than the window, returned
 *   without a query.
 * - failed: the history end is unknown. `reason` is "lookup" for a
 *   transient failure (worth a retry) or "timezone" when the site timezone
 *   is not recognized (a retry cannot help).
 */
export type HistoryProbe =
  | { status: "skipped" }
  | { status: "ok"; endDay: string | null; windowStart: string; outsideWindow?: boolean }
  | { status: "failed"; reason: "lookup" | "timezone" };

export const SKIPPED_PROBE: HistoryProbe = { status: "skipped" };

/** An AssetContext narrowed to a room or zone. */
export type SpaceAsset = AssetContext & { assetType: "room" | "zone" };

/**
 * Whether a room or zone is RETIRED (shared rule: archived-spaces.ts
 * `isRetired`): no sensor of any kind attributed AND archived or with its
 * sensors removed. A retired space is never read live by any tool, and its
 * history end comes from those dates and the data (history-end.ts). A
 * space that still has sensors is live, whatever its archive fields say.
 * The asset must have resolved in the topology.
 */
export function isRetiredSpace(asset: AssetContext): asset is SpaceAsset {
  return (
    asset.found &&
    asset.assetType !== "floor" &&
    isRetired(
      { archivedAt: asset.archivedAt, sensorsRemovedAt: asset.sensorsRemovedAt },
      asset.attributedSensorCount
    )
  );
}

/**
 * Whether a ROOM has no sensor of any kind attributed (the 0.6.2
 * "speculative" case, retired or not). Room attribution is direct
 * (`sensors.room_id`), so zero means zero; a room whose only sensors are
 * traffic-mode, test/mirror or MAC-less is not sensorless. Zones never count:
 * a live zone can get `zone_occupancy` from overlapping floor sensors, so
 * zero attributed sensors is no evidence for a zone; only `isRetiredSpace`
 * retires one. The asset must have resolved in the topology.
 */
export function isSensorlessSpace(asset: AssetContext): asset is SpaceAsset {
  return asset.found && asset.assetType === "room" && asset.attributedSensorCount === 0;
}

/**
 * Whether `tool` sends the history-end probe for this asset. Current
 * occupancy probes retired spaces only (a floor of rooms that have no
 * sensors yet would otherwise cost one query per room); the timeseries tool
 * also probes a sensorless room, where the end comes from the data.
 */
export function needsHistoryProbe(
  asset: AssetContext,
  tool: "timeseries" | "current"
): asset is SpaceAsset {
  return isRetiredSpace(asset) || (tool === "timeseries" && isSensorlessSpace(asset));
}

/**
 * Whether a reporting failure is transient (429, 5xx, or a non-HTTP error
 * such as a timeout), and so reported on its asset alone rather than
 * failing the call. Auth and other 4xx errors are not.
 */
export function isTransientReportingError(error: unknown): boolean {
  return !(error instanceof ApiError) || error.statusCode === 429 || error.statusCode >= 500;
}

/**
 * Find where a room's or zone's recorded history ends (history-end.ts).
 * A transient failure is reported as `failed` so the caller can warn on
 * that asset alone; any other error (auth, a 400) fails the call, the same
 * as on the range query. Successful answers are cached for a few minutes
 * (src/cache/history-end-cache.ts), and concurrent lookups for the same
 * space (a batch naming it twice) share one query. Callers decide eligibility with
 * `needsHistoryProbe`.
 */
export async function probeHistory(asset: SpaceAsset, assetId: string): Promise<HistoryProbe> {
  if (!isValidTimezone(asset.timezone)) return { status: "failed", reason: "timezone" };
  const declared = declaredHistoryEnd(asset, asset.timezone);
  const cacheKey = `${asset.timezone}|${declared ?? ""}`;
  const cached = getCachedHistoryEnd(assetId, cacheKey);
  if (cached) return { status: "ok", ...cached };
  try {
    // A batch that names the same space twice shares one lookup.
    const end = await shareInFlight(`history-end:${assetId}:${cacheKey}`, () =>
      fetchHistoryEnd(asset.assetType, assetId, asset.timezone, declared)
    );
    setCachedHistoryEnd(assetId, cacheKey, end);
    return { status: "ok", ...end };
  } catch (error: unknown) {
    if (!isTransientReportingError(error)) throw error;
    debug("occupancy-helpers", `History-end probe failed for ${assetId}:`, error);
    return { status: "failed", reason: "lookup" };
  }
}

/**
 * "Recorded history runs up to <day>." / "No recorded history since
 * <window start>." / "" when unknown. A declared end older than the window
 * says it was not checked against the data.
 */
function historyClause(probe: HistoryProbe): string {
  if (probe.status !== "ok") return "";
  if (!probe.endDay) return `No recorded history since ${probe.windowStart}.`;
  return `Recorded history runs up to ${historyEndPhrase(probe)}.`;
}

/** The end day, flagged when it is a declared end older than the lookup window. */
function historyEndPhrase(probe: HistoryProbe & { status: "ok" }): string {
  return probe.outsideWindow
    ? `${probe.endDay} (before the lookup window, so not checked against the data)`
    : `${probe.endDay}`;
}

/** "N sensor(s)" */
function sensorsPhrase(n: number): string {
  return `${n} sensor${n === 1 ? "" : "s"}`;
}

/** " (archived on D)" / " (sensors removed on D)" / "". */
function retiredParenthetical(asset: AssetContext): string {
  if (asset.archivedOn) return ` (archived on ${asset.archivedOn})`;
  if (asset.sensorsRemovedOn) return ` (sensors removed on ${asset.sensorsRemovedOn})`;
  return "";
}

/**
 * Coverage note for a retired or sensorless space:
 * "No sensors assigned (archived on <date>). Recorded history runs up to <day>."
 * The parenthetical names the archive (or sensor removal) date when there is
 * one; the history part is dropped when the probe failed. In current
 * occupancy, a note without a history end points at the timeseries tool.
 */
export function sensorlessCoverageNote(
  asset: AssetContext,
  probe: HistoryProbe,
  tool: "timeseries" | "current"
): string {
  const lead = `No sensors assigned${retiredParenthetical(asset)}.`;
  // Current occupancy has no history of its own, so without a history end
  // (no probe, or a failed one) it points at the timeseries tool.
  const tail =
    probe.status === "ok"
      ? historyClause(probe)
      : tool === "current"
        ? "Use butlr_get_occupancy_timeseries for any history it recorded."
        : "";
  return [lead, tail].filter(Boolean).join(" ");
}

/** Asset-level warning when the probe failed, or undefined. */
export function historyProbeWarning(asset: AssetContext, probe: HistoryProbe): string | undefined {
  if (probe.status !== "failed") return undefined;
  const subject = `Could not determine where this ${asset.assetType}'s recorded history ends`;
  return probe.reason === "timezone"
    ? `${subject}: the site timezone "${asset.timezone}" is not a recognized IANA timezone. Retrying will not help; the site's timezone needs to be corrected.`
    : `${subject}; the lookup failed. Retry to check.`;
}

/**
 * Lifecycle fields for an occupancy response: archive state, replaced-space
 * links, the probed history end, and a `history_note` telling the caller
 * where the rest of the history lives. Series are never merged across a
 * replacement; the note names the other ID so the caller can fetch it.
 *
 * `tool` picks the wording: a timeseries covers a range, while current
 * occupancy is a live reading a retired space never has.
 */
export function buildSpaceLifecycle(
  asset: AssetContext,
  assetId: string,
  tool: "timeseries" | "current",
  probe: HistoryProbe = SKIPPED_PROBE
): SpaceLifecycle {
  const lifecycle: SpaceLifecycle = {};
  const notes: string[] = [];
  const kind = asset.assetType;

  if (probe.status === "ok" && probe.endDay) lifecycle.history_end = probe.endDay;
  const warning = historyProbeWarning(asset, probe);
  if (warning) lifecycle.history_warning = warning;
  if (asset.archivedAt) lifecycle.archived_at = asset.archivedAt;

  const retired = isRetiredSpace(asset);
  if (retired) {
    const what = asset.archivedOn
      ? `This ${kind} was archived on ${asset.archivedOn}`
      : `This ${kind}'s sensors were removed on ${asset.sensorsRemovedOn}`;
    notes.push(
      [
        tool === "timeseries" ? `${what}.` : `${what}; it has no live data.`,
        historyClause(probe),
        tool === "current" ? "Use butlr_get_occupancy_timeseries for its history." : "",
      ]
        .filter(Boolean)
        .join(" ")
    );
  } else if (asset.archivedOn && asset.attributedSensorCount > 0) {
    notes.push(
      `This ${kind} was archived on ${asset.archivedOn} but still has ${sensorsPhrase(asset.attributedSensorCount)} attributed (a data-integrity issue), so it is read like an active ${kind}.`
    );
  }

  if (asset.replacedBy && asset.replacedBy.length > 0) {
    lifecycle.replaced_by = asset.replacedBy;
    const list = asset.replacedBy.map(describeSpaceRef).join(", ");
    notes.push(
      tool === "timeseries"
        ? `Replaced by ${list}; query ${asset.replacedBy.length === 1 ? "it" : "them"} for data after the switch-over.`
        : `For current occupancy, query its replacement${asset.replacedBy.length === 1 ? "" : "s"}: ${list}.`
    );
  }

  if (asset.replaces) {
    lifecycle.replaces = asset.replaces;
    const predecessorArchived = asset.replaces.archived_at
      ? `, archived on ${formatArchiveDate(asset.replaces.archived_at, asset.timezone)}`
      : "";
    notes.push(
      `This ${kind} replaces ${describeSpaceRef(asset.replaces)}${predecessorArchived}. ` +
        (tool === "timeseries"
          ? `This series covers ${assetId} only; for history before the switch-over, query ${asset.replaces.id} separately.`
          : `For history before the switch-over, query ${asset.replaces.id} with butlr_get_occupancy_timeseries.`)
    );
  }

  if (notes.length > 0) lifecycle.history_note = notes.join(" ");
  return lifecycle;
}

/**
 * Recommendation reason for a retired or sensorless space with no usable
 * reading, or undefined to keep the generic copy. Always set for a retired
 * space; set for an active sensorless room only when the probe found
 * history (with none, "instrument it" is still the right advice).
 *
 * The wording states what is known without inferring a cause: an empty
 * range can fall inside the recorded history (an outage, say), so it is not
 * blamed on the missing sensors. Like buildFailureReason, it avoids the
 * phrase "no occupancy data".
 */
export function sensorlessRecommendationReason(
  asset: AssetContext,
  tool: "timeseries" | "current",
  probe: HistoryProbe
): string | undefined {
  const retired = isRetiredSpace(asset);
  if (!retired && !isSensorlessSpace(asset)) return undefined;
  const foundHistory = probe.status === "ok" && probe.endDay !== null;
  if (!retired && !foundHistory) return undefined;

  const state = `This ${asset.assetType} has no sensors assigned${retiredParenthetical(asset)}`;
  const parts = [
    tool === "timeseries"
      ? `No readings in the requested time range. ${state}.`
      : `${state}, so it has no live readings.`,
  ];
  if (probe.status === "ok") {
    if (probe.endDay) {
      parts.push(
        tool === "timeseries"
          ? `Its recorded history runs up to ${historyEndPhrase(probe)}.`
          : `Its recorded history runs up to ${historyEndPhrase(probe)}; use butlr_get_occupancy_timeseries for it.`
      );
    } else {
      parts.push(
        tool === "timeseries"
          ? `It has no recorded history since ${probe.windowStart}; query an older range to check for earlier history.`
          : `It has no recorded history since ${probe.windowStart}; use butlr_get_occupancy_timeseries to check older ranges.`
      );
    }
  }
  const successors = asset.replacedBy ?? [];
  if (successors.length > 0) {
    parts.push(
      `Its replacement${successors.length === 1 ? " is" : "s are"} ${successors
        .map(describeSpaceRef)
        .join(", ")}.`
    );
  }
  return parts.join(" ");
}

/**
 * Resolved context for a single sensor: display name, timezone, and the
 * breadcrumb path to it.
 *
 * Lives next to resolveAssetContext so there is ONE definition of how a
 * sensor's timezone and path are derived. Sensors are not an asset type
 * resolveAssetContext handles (it partitions an enclosing space's sensors by
 * mode, which is not meaningful for a single device), but they resolve
 * against the same topology by the same rules, and a second copy of those
 * rules in a tool is how the two drifted apart before.
 */
export interface SensorContext {
  name: string;
  timezone: string;
  tzMetadata: TimezoneMetadata;
  timezoneFallback: boolean;
  path: string;
  room?: Room;
  floor?: Floor;
  building?: Building;
}

/**
 * Resolve a single sensor's display name, timezone and breadcrumb path.
 *
 * Room first, floor second, for BOTH timezone and path. The room's own floor
 * is authoritative: `sensor.floor_id` can be unset while `room_id` still
 * resolves, and it can disagree with the room's actual floor. Keying the path
 * off `floor_id` (while keying the timezone off `room_id`) drops every path
 * segment in the first case and names the wrong floor in the second.
 *
 * Only snake_case linkage fields are read. Both queries that feed this
 * (GET_ALL_SENSORS, GET_SENSORS_BY_IDS) select `floor_id`/`room_id` and not
 * the camelCase resolvers, which are buggy for NULL values.
 */
export function resolveSensorContext(sensor: Sensor, ctx: TopologyOnly): SensorContext {
  const roomId = sensor.room_id || undefined;
  const floorId = sensor.floor_id || undefined;

  const floorByRoom = roomId
    ? ctx.floors.find((f) => f.rooms?.some((r) => r.id === roomId))
    : undefined;
  const room = floorByRoom?.rooms?.find((r) => r.id === roomId);
  const floor = floorByRoom ?? (floorId ? ctx.floors.find((f) => f.id === floorId) : undefined);
  const building = floor ? ctx.buildings.find((b) => b.id === floor.building_id) : undefined;

  // A dangling room reference (deleted room) falls through to the floor, and
  // an unassigned sensor falls through to the UTC fallback with isFallback set.
  const resolved = room
    ? getTimezoneForAsset(room.id, "room", ctx.floors, ctx.buildings, ctx.sites)
    : getTimezoneForAsset(floor?.id ?? "", "floor", ctx.floors, ctx.buildings, ctx.sites);

  const name = sensor.name || sensor.id;

  return {
    name,
    timezone: resolved.timezone,
    tzMetadata: buildTimezoneMetadata(resolved.timezone),
    timezoneFallback: resolved.isFallback,
    path: [building?.name, floor?.name, room?.name, name].filter(Boolean).join(" > "),
    room,
    floor,
    building,
  };
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
 * Caller context threaded through recommendation building. `assetType` decides
 * structural applicability (zones don't support traffic); `windowLabel` is a
 * human-readable description of the query window so failure copy doesn't claim
 * a window the caller never queried (the current-occupancy tool uses a fixed
 * 5-minute snapshot; the timeseries tool uses a caller-supplied range).
 */
export interface RecommendationContext {
  assetType: "floor" | "room" | "zone";
  windowLabel: string;
  /**
   * Reason to give when an archived space yielded no usable reading. Without
   * it the generic copy says "no sensors configured ... contact facilities to
   * instrument it", which is wrong for a space that was retired on purpose.
   */
  archivedReason?: string;
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
  trafficHasData: boolean,
  ctx: RecommendationContext
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
    recommendation_reason: buildFailureReason(presence, traffic, ctx),
  };
}

/**
 * Number of sensors configured for a measurement, regardless of which field
 * the caller populated: floors report traffic via `entrance_sensor_count`;
 * rooms and zones use `sensor_count`.
 */
function configuredSensorCount(data: BaseMeasurementData): number {
  return data.sensor_count ?? data.entrance_sensor_count ?? 0;
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
  ctx: RecommendationContext
): string {
  // An archived space has no sensors by design. Unless a lookup failed (the
  // warning is more useful then), say so instead of "instrument it".
  if (ctx.archivedReason && !presence.warning && !traffic.warning) {
    return ctx.archivedReason;
  }

  const presenceReason = describeMeasurementFailure("presence", presence, ctx);
  const trafficReason = describeMeasurementFailure("traffic", traffic, ctx);

  // Prefer the measurement type carrying real signal: one with sensors
  // configured, or whose call errored mid-flight. Without this, a floor with
  // working entrance sensors but zero presence sensors would surface
  // presence's "no sensors configured" copy and read as uninstrumented.
  // Presence wins ties — it's the more informative signal when both
  // measurement types are instrumented but quiet.
  const presenceHasSignal = configuredSensorCount(presence) > 0 || Boolean(presence.warning);
  const trafficHasSignal = configuredSensorCount(traffic) > 0 || Boolean(traffic.warning);
  if (presenceReason && presenceHasSignal) return presenceReason;
  if (trafficReason && trafficHasSignal) return trafficReason;

  // Neither measurement type has sensors: the space is uninstrumented.
  // Presence first — it applies to every asset type.
  if (presenceReason) return presenceReason;
  if (trafficReason) return trafficReason;

  // Defensive fallback for totality only. Unreachable today: presence is
  // applicable to every asset type, so `presenceReason` is always set.
  return "No recent occupancy reads. Check butlr_hardware_snapshot for sensor health.";
}

/**
 * Returns a customer-facing explanation of why a measurement type produced no
 * usable reading, or `undefined` if the measurement type is structurally
 * inapplicable to this asset (traffic on a zone). Only called for measurements
 * that yielded no usable reading, so "sensors configured" below means
 * configured-but-quiet.
 */
function describeMeasurementFailure(
  kind: "presence" | "traffic",
  data: BaseMeasurementData,
  ctx: RecommendationContext
): string | undefined {
  // Traffic on a zone is the only structurally-N/A combination. The caller's
  // coverage_note already explains why; surfacing it here would be redundant.
  if (kind === "traffic" && ctx.assetType === "zone") return undefined;

  // The call errored. Surface the warning verbatim so the customer (and any
  // LLM reading the response) gets the actual failure mode.
  if (data.warning) {
    return `Tried to retrieve ${kind} occupancy but the request failed: ${data.warning}. Retry with a smaller asset set, or check butlr_hardware_snapshot for sensor health.`;
  }

  // Sensors are configured but the Reporting API had no reads in the query
  // window. Honest: we don't know if the space is empty or if the sensors
  // are stuck — point at hardware_snapshot for the health-check answer.
  if (configuredSensorCount(data) > 0) {
    return `Sensor(s) configured but no ${kind} reads in ${ctx.windowLabel}. The asset may currently be empty, or the sensor(s) may need a health check via butlr_hardware_snapshot.`;
  }

  // No sensors at all. The space is uninstrumented for this measurement type.
  return `No ${kind} sensors configured for this asset. Contact facilities to instrument it before requesting ${kind} occupancy.`;
}
