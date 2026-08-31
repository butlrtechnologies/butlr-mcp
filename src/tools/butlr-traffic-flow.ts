import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apolloClient } from "../clients/graphql-client.js";
import { gql } from "@apollo/client";
import { z } from "zod";
import type { Room, Sensor } from "../clients/types.js";
import { ReportingRequestBuilder } from "../clients/reporting-client.js";
import { executeSearchAssets } from "./butlr-search-assets.js";
import {
  getTimezoneForAsset,
  buildTimezoneMetadata,
  getLocalMidnight,
} from "../utils/timezone-helpers.js";
import type { TimezoneMetadata } from "../utils/timezone-helpers.js";
import { createValidationError, withToolErrorHandling } from "../errors/mcp-errors.js";
import { resolveTimeToIso } from "../utils/time-resolver.js";
import {
  rethrowIfGraphQLError,
  throwIfGraphQLErrors,
  isKnownTestSensor,
} from "../utils/graphql-helpers.js";
import {
  fetchTopology,
  fetchSensorsByIds,
  fetchSensorsByRoomIds,
  resolveSensorContext,
} from "../utils/occupancy-helpers.js";
import { detectAssetType } from "../utils/asset-helpers.js";
import { debug } from "../utils/debug.js";
import type { TrafficFlowResponse } from "../types/responses.js";

const timeStringSchema = z.string().refine(
  (val) => {
    const isoMatch = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z?$/.test(val);
    const relativeMatch = /^-\d+[dhm]$/.test(val);
    const isNow = val === "now";
    return isoMatch || relativeMatch || isNow;
  },
  {
    message:
      "Time must be ISO-8601 format (2025-01-15T10:00:00Z), relative (-24h, -7d, -30m), or 'now'",
  }
);

/** Shared shape — used by both registerTool (SDK schema) and full validation */
const trafficFlowInputShape = {
  space_id_or_name: z
    .string()
    .min(1, "space_id_or_name cannot be empty")
    .max(200)
    .trim()
    .describe(
      "Room ID (room_...), sensor ID (sensor_...) for per-access-point counts, or a name search term (matches rooms and traffic sensors)"
    ),

  time_window: z
    .enum(["20m", "1h", "today", "custom"])
    .default("today")
    .describe("Time period for traffic count"),

  custom_start: z
    .string()
    .pipe(timeStringSchema)
    .optional()
    .describe("Custom start time (ISO-8601 or relative '-24h'). Required if time_window='custom'"),

  custom_stop: z
    .string()
    .pipe(timeStringSchema)
    .optional()
    .describe("Custom stop time. Defaults to 'now'"),
};

export const TrafficFlowArgsSchema = z
  .object(trafficFlowInputShape)
  .strict()
  .refine(
    (data) => {
      if (data.time_window === "custom" && !data.custom_start) {
        return false;
      }
      return true;
    },
    {
      message: "custom_start is required when time_window='custom'",
      path: ["custom_start"],
    }
  );

const TRAFFIC_FLOW_DESCRIPTION =
  "Get entry and exit counts for spaces equipped with traffic-mode sensors (typically lobbies, building entrances, elevator banks). Returns total movements, net flow (entries - exits), and hourly breakdown in the space's local timezone. Designed for space activation analysis, security/compliance, and amenity demand forecasting.\n\n" +
  "Accepts a room ID (counts aggregate across the room's traffic sensors), a single sensor ID (sensor_...) for per-access-point counts, or a name to search. Sensors do not need to be assigned to a room to be queried directly, and a name search matches sensors as well as rooms, so an access point does not have to be modeled as a room. (Name search covers devices assigned to a floor; a floor-less or not-yet-MAC-bound sensor is still queryable by its sensor_... ID.)\n\n" +
  "Primary Users:\n" +
  "- Facilities Manager: Monitor building entry/exit patterns, optimize security staffing, validate badge system accuracy\n" +
  "- Workplace Manager: Understand amenity traffic (café, gym, event spaces), measure activation of new spaces\n" +
  "- Portfolio Manager: Analyze building utilization patterns for lease negotiations, assess occupancy vs. leased capacity\n" +
  "- Security/Compliance: Validate occupancy limits for fire code compliance, monitor after-hours access\n\n" +
  "Example Queries:\n" +
  '1. "How many people entered the main lobby today?"\n' +
  '2. "Show me entry/exit counts for the café in the last hour"\n' +
  '3. "What was the peak traffic hour for Building 3 entrance today?"\n' +
  '4. "How many people visited the fitness center yesterday?"\n' +
  '5. "Show me lobby traffic for the last 20 minutes"\n' +
  '6. "What\'s the net flow (entries - exits) for Floor 2 today?"\n' +
  '7. "How many people entered the event space during lunch hour (12-1pm)?"\n' +
  '8. "Compare today\'s building entrance traffic to typical Monday"\n' +
  '9. "How many people came through the north elevator door today?" (a single sensor, by name or by sensor_... ID)\n\n' +
  "When to Use:\n" +
  "- Entry/exit counts for lobbies, building entrances, elevator banks, or amenities\n" +
  "- Understand peak traffic hours for security, cleaning, or HVAC planning\n" +
  "- Validate badge system accuracy against actual sensor counts\n" +
  "- Measure activation/adoption of new spaces or amenities\n" +
  "- Analyze compliance with occupancy limits (fire code, COVID density restrictions)\n\n" +
  "When NOT to Use:\n" +
  "- Current occupancy count (people currently in space) → use butlr_get_current_occupancy or butlr_space_busyness\n" +
  "- Rooms without traffic-mode sensors → use butlr_get_current_occupancy (presence mode)\n" +
  "- Spaces that don't have entry/exit chokepoints → traffic mode requires defined entrances\n\n" +
  "CRE Context: Traffic counts are movements, not unique people - one person exiting/re-entering counts as 2 movements. Net flow helps detect sensor calibration issues (large negative net flow might indicate misconfigured entry/exit sensors).\n\n" +
  "See Also: butlr_get_current_occupancy, butlr_space_busyness, butlr_search_assets, butlr_get_asset_details";

export type TrafficFlowArgs = z.output<typeof TrafficFlowArgsSchema>;

const GET_ROOM_SENSORS = gql`
  query GetRoomSensors($roomId: ID!) {
    room(id: $roomId) {
      id
      name
      floorID
      sensors {
        id
        mode
      }
      floor {
        id
        name
        building {
          id
          name
        }
      }
    }
  }
`;

/**
 * Fetch a room and its floor/building context. Kept separate from the shared
 * topology fetch so it can run in parallel with it.
 */
async function fetchRoom(roomId: string) {
  try {
    const result = await apolloClient.query<{ room: Room }>({
      query: GET_ROOM_SENSORS,
      variables: { roomId },
      fetchPolicy: "network-only",
    });
    throwIfGraphQLErrors(result);
    return result;
  } catch (error: unknown) {
    rethrowIfGraphQLError(error);
    throw error;
  }
}

/**
 * Execute traffic flow tool
 */
export async function executeTrafficFlow(args: TrafficFlowArgs) {
  let spaceId = args.space_id_or_name;

  // One prefix detector for both branches. `asset-helpers.ts` is the single
  // place that encodes ID prefixes, so re-testing the string with a local
  // regex here would be a second thing to keep in sync with it.
  let assetType = detectAssetType(spaceId);

  // If it is neither a room nor a sensor ID, treat it as a search term.
  // Direct sensor queries skip room resolution entirely: the reporting API
  // serves sensor-level traffic via the sensors filter, so a sensor does not
  // need a room wrapper to be queryable.
  if (assetType !== "sensor" && assetType !== "room") {
    debug("traffic-flow", `Searching for space: "${args.space_id_or_name}"`);

    // Both types, so a natural-language query can reach the sensor path too.
    // The customer ask behind sensor support was to stop modeling each door as
    // a room; searching rooms only would leave the capability reachable solely
    // by callers who already know the sensor ID.
    const searchResults = await executeSearchAssets({
      query: args.space_id_or_name,
      asset_types: ["room", "sensor"],
      max_results: 5,
    });

    if (searchResults.matches.length === 0) {
      throw new Error(
        `No rooms or sensors found matching "${args.space_id_or_name}". Try a different search term, or pass a room ID (room_...) or sensor ID (sensor_...) directly. butlr_search_assets finds both by name or MAC; butlr_hardware_snapshot lists sensors with their health.`
      );
    }

    // Take the highest-ranked candidate that can actually serve traffic: any
    // room (validated downstream), or a traffic-mode sensor. Taking
    // matches[0] unconditionally let a presence sensor whose name outranks
    // the intended room dead-end the whole query with the right room sitting
    // at index 1.
    const viable = searchResults.matches.find(
      (m) => m.type === "room" || (m.type === "sensor" && m.mode === "traffic")
    );
    if (!viable) {
      throw new Error(
        `"${args.space_id_or_name}" matched only presence-mode sensors, which have no entry/exit counts. Try butlr_get_current_occupancy for occupancy data, or search for a room or traffic-mode sensor.`
      );
    }

    spaceId = viable.id;
    assetType = detectAssetType(spaceId);

    debug("traffic-flow", `Using best viable match: ${viable.name} (${spaceId}, ${assetType})`);
  }

  const isSensorQuery = assetType === "sensor";

  // Query asset details, topology for timezone, and sensors
  let displayName = "";
  let roomPath = "";
  let timezone: string;
  let tzMetadata: TimezoneMetadata;
  let timezoneFallback = false;
  let trafficSensors: Sensor[] = [];

  if (isSensorQuery) {
    // One sensor by ID, not the org's whole inventory: the `sensors` root
    // field accepts an `ids` argument, and nothing on this branch needs the
    // full list. A capped or paged `sensors` field would otherwise turn a real
    // sensor past the cap into a bogus "not found".
    const [topology, sensors] = await Promise.all([fetchTopology(), fetchSensorsByIds([spaceId])]);

    const sensor = sensors.find((s) => s.id === spaceId);
    if (!sensor) {
      throw new Error(`Sensor ${spaceId} not found`);
    }

    // Resolved up front so the rejections below can consult real topology
    // rather than pointing the caller at an ID that may not resolve.
    const sensorContext = resolveSensorContext(sensor, topology);

    // Only a KNOWN test device is refused. isProductionSensor is stricter (it
    // also drops MAC-less placeholder rows) and is the right filter for the
    // room path's aggregate below, but applying it to a caller's explicit
    // request would tell the owner of a real, not yet MAC bound sensor that
    // their device is fake and leave them no way to query it.
    if (isKnownTestSensor(sensor)) {
      throw new Error(
        `Sensor "${sensor.name}" (${spaceId}) is a test/mirror device, not a production sensor — it has no real traffic data.`
      );
    }
    if (sensor.mode !== "traffic") {
      // Only name the room when it actually resolves. A dangling room_id (the
      // room was deleted) would otherwise send the caller to a second dead
      // end: butlr_get_current_occupancy accepts the room_ prefix, finds no
      // room, and answers "no sensors configured".
      const suggestion = sensorContext.room
        ? `Try butlr_get_current_occupancy with its room (${sensorContext.room.id}) instead.`
        : `Try butlr_get_asset_details or butlr_hardware_snapshot to inspect it.`;
      throw new Error(
        `Sensor "${sensor.name}" is ${
          sensor.mode ? `a ${sensor.mode}-mode sensor` : "not a traffic-mode sensor"
        }, so it has no entry/exit counts. ${suggestion}`
      );
    }

    trafficSensors = [sensor];
    displayName = sensorContext.name;
    roomPath = sensorContext.path;
    timezone = sensorContext.timezone;
    tzMetadata = sensorContext.tzMetadata;
    timezoneFallback = sensorContext.timezoneFallback;

    debug("traffic-flow", `Direct sensor query: ${displayName} (${spaceId})`);
  } else {
    // The room's own sensor rows via `sensors(room_ids:)` rather than the
    // org-wide inventory. The rows arrive unfiltered and only KNOWN test
    // devices (mirror/fake prefixes) are dropped: this list drives the
    // refusal gate and sensor_count, never the totals (the reporting API
    // aggregates by room_id server-side), so a provisioned-but-MAC-less
    // sensor must not disqualify its room the way the stricter
    // isProductionSensor aggregate filter would.
    const [topology, roomResult, roomSensorRows] = await Promise.all([
      fetchTopology(),
      fetchRoom(spaceId),
      fetchSensorsByRoomIds([spaceId]),
    ]);

    if (!roomResult?.data?.room) {
      throw new Error(`Room ${spaceId} not found`);
    }

    const room = roomResult.data.room;
    displayName = room.name;
    const floor = room.floor;
    const building = floor?.building;
    roomPath = building ? `${building.name} > ${floor.name} > ${room.name}` : room.name;

    const resolved = getTimezoneForAsset(
      spaceId,
      "room",
      topology.floors,
      topology.buildings,
      topology.sites
    );

    timezone = resolved.timezone;
    timezoneFallback = resolved.isFallback;
    tzMetadata = buildTimezoneMetadata(timezone);

    const roomSensors = roomSensorRows.filter((s) => !isKnownTestSensor(s));
    // Room-level traffic counts every traffic-mode sensor bound to the room.
    // See `resolveAssetContext` in occupancy-helpers.ts for the canonical
    // rationale: `is_entrance` is a semantic flag, not a routing one, and the
    // Reporting API aggregates by `room_id` regardless.
    trafficSensors = roomSensors.filter((s) => s.mode === "traffic");

    if (trafficSensors.length === 0) {
      throw new Error(
        `Room "${room.name}" does not have traffic-mode sensors. Try butlr_get_current_occupancy for occupancy data instead.`
      );
    }

    debug("traffic-flow", `Found ${trafficSensors.length} traffic sensors for room`);
  }

  // Calculate time range
  const timeWindow = args.time_window || "today";
  let start: string;
  let stop: string = "now";
  let periodDescription: string;
  let usedUtcFallback = timezoneFallback;

  if (timeWindow === "custom") {
    if (!args.custom_start) {
      throw createValidationError("custom_start is required when time_window='custom'");
    }
    start = args.custom_start;
    stop = args.custom_stop || "now";
    periodDescription = "custom period";
  } else if (timeWindow === "20m") {
    start = "-20m";
    periodDescription = "last 20 minutes";
  } else if (timeWindow === "1h") {
    start = "-1h";
    periodDescription = "last hour";
  } else {
    // today - use site's timezone for local midnight
    const localMidnight = getLocalMidnight(new Date(), timezone);

    if (isNaN(localMidnight.getTime())) {
      // getLocalMidnight returns UTC midnight as fallback on error
      usedUtcFallback = true;
    }

    // Detect if getLocalMidnight silently fell back to UTC by comparing
    // the result against a plain UTC midnight (which is what the internal fallback does)
    const utcMidnight = new Date();
    utcMidnight.setUTCHours(0, 0, 0, 0);
    if (timezone !== "UTC" && Math.abs(localMidnight.getTime() - utcMidnight.getTime()) < 1000) {
      // The result suspiciously matches UTC midnight for a non-UTC timezone —
      // likely the internal fallback fired
      usedUtcFallback = true;
    }

    start = localMidnight.toISOString();
    periodDescription = usedUtcFallback
      ? "today (UTC fallback)"
      : `today (${tzMetadata.timezone_abbr})`;

    debug(
      "traffic-flow",
      `Today starts at ${start} (midnight ${usedUtcFallback ? "UTC fallback" : tzMetadata.timezone_abbr})`
    );
  }

  // Resolve relative forms ("-20m", "now") to absolute timestamps: the
  // ETL-backed reporting API requires RFC3339, and the response period
  // metadata should carry real timestamps rather than relative strings.
  start = resolveTimeToIso(start);
  stop = resolveTimeToIso(stop);

  // Pick window granularity from the range length. The ETL backend only
  // returns fully-closed, end-labeled buckets that fit inside [start, stop]:
  // a 1h window over a short recent range drops the in-progress hour
  // entirely (its bucket doesn't exist until the hour closes). Querying 1m
  // buckets for short ranges keeps edge loss to at most the current minute;
  // results are rolled back up to hours below.
  const durationMs = new Date(stop).getTime() - new Date(start).getTime();
  const windowEvery = durationMs <= 2 * 60 * 60 * 1000 ? "1m" : "1h";

  debug("traffic-flow", `Querying traffic from ${start} to ${stop} (window ${windowEvery})`);

  // Query traffic data with timezone
  interface TrafficDataPoint {
    time: string;
    sensor_id: string;
    field: "in" | "out";
    value: number;
  }

  // `fine` marks 1m-bucket points whose timestamps must be rolled up to the
  // enclosing hour; native 1h bucket labels pass through untouched (they may
  // sit on a non-UTC-aligned local grid, e.g. :30-offset timezones).
  let trafficData: Array<TrafficDataPoint & { fine: boolean }> = [];

  const queryAssetType = isSensorQuery ? "sensor" : "room";

  try {
    const response = await new ReportingRequestBuilder()
      .assets(queryAssetType, [spaceId])
      .measurements(["traffic"])
      .timeRange(start, stop)
      .window(windowEvery, "sum", timezone) // Sum traffic per bucket, aligned to local timezone
      .execute();

    // Parse flat array response
    // Traffic returns TWO data points per hour per sensor: "in" and "out"
    if (!Array.isArray(response.data)) {
      throw new Error("Expected array response from traffic query");
    }

    trafficData = (response.data as TrafficDataPoint[]).map((p) => ({
      ...p,
      fine: windowEvery === "1m",
    }));

    debug(
      "traffic-flow",
      `Received ${trafficData.length} data points from ${trafficSensors.length} sensors`
    );

    // A 1h bucket only exists once its hour closes AND the ETL has written
    // it, so a range ending at/near now silently misses the in-progress hour
    // and possibly the just-closed one. Re-query the trailing 2 hours at 1m
    // granularity and merge; hours already covered by a returned 1h bucket
    // are deduplicated in the rollup below. The tail exists solely to
    // recover those not-yet-materialized recent hours (materialization lag
    // measured at up to ~1h), so it is skipped when the range's stop is old
    // enough that every hourly bucket has long since landed.
    if (windowEvery === "1h") {
      const stopDate = new Date(stop);
      const startDate = new Date(start);
      const twoHoursMs = 2 * 60 * 60 * 1000;
      const tailStartMs = Math.max(startDate.getTime(), stopDate.getTime() - twoHoursMs);
      const recentStopMs = 3 * 60 * 60 * 1000;
      if (tailStartMs < stopDate.getTime() && Date.now() - stopDate.getTime() < recentStopMs) {
        try {
          const tailResponse = await new ReportingRequestBuilder()
            .assets(queryAssetType, [spaceId])
            .measurements(["traffic"])
            .timeRange(new Date(tailStartMs).toISOString(), stop)
            .window("1m", "sum", timezone)
            .execute();
          if (Array.isArray(tailResponse.data)) {
            trafficData = trafficData.concat(
              (tailResponse.data as TrafficDataPoint[]).map((p) => ({ ...p, fine: true }))
            );
            debug("traffic-flow", `Merged ${tailResponse.data.length} tail data points (1m)`);
          }
        } catch (tailError: unknown) {
          // The closed-hour data is still valid without the tail
          debug("traffic-flow", "Partial-hour tail query failed:", tailError);
        }
      }
    }
  } catch (error: unknown) {
    rethrowIfGraphQLError(error);
    debug("traffic-flow", "Failed to get traffic data:", error);
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to get traffic data for ${displayName}. ${msg}`);
  }

  // Parse traffic data: group by time, then by sensor, then aggregate
  // Store time separately to preserve full ISO timestamp. The fine flag is
  // part of the key: a 1m tail bucket ending exactly on an hour boundary
  // carries the same label as that hour's native 1h bucket, and must not
  // share (and overwrite) the native bucket's entry.
  const byHourSensor = new Map<
    string,
    { time: string; sensor_id: string; fine: boolean; in: number; out: number }
  >();

  for (const point of trafficData) {
    const key = `${point.time}:${point.sensor_id}:${point.fine}`;
    if (!byHourSensor.has(key)) {
      byHourSensor.set(key, {
        time: point.time,
        sensor_id: point.sensor_id,
        fine: point.fine,
        in: 0,
        out: 0,
      });
    }

    const counts = byHourSensor.get(key)!;
    if (point.field === "in") {
      counts.in = point.value || 0;
    } else if (point.field === "out") {
      counts.out = point.value || 0;
    }
  }

  // Roll a bucket timestamp up to its enclosing hour. Bucket timestamps are
  // end-labeled (a 1m bucket "17:29" covers 17:28–17:29), so ceil to the
  // hour to stay on the same end-labeled convention the API uses for 1h
  // buckets.
  const toHourEnd = (iso: string): string => {
    const d = new Date(iso);
    if (d.getUTCMinutes() !== 0 || d.getUTCSeconds() !== 0 || d.getUTCMilliseconds() !== 0) {
      d.setUTCMinutes(0, 0, 0);
      d.setUTCHours(d.getUTCHours() + 1);
    }
    return d.toISOString().replace(".000Z", "Z");
  };

  // Native (closed) 1h buckets are authoritative for the interval they
  // cover, so fine-grained tail minutes falling inside any of them are
  // dropped to avoid double counting. Coverage is checked on the bucket
  // intervals themselves — an end-labeled 1h bucket T covers (T-1h, T] —
  // rather than on labels, so it also holds for sites whose local hour grid
  // is not UTC-aligned (e.g. :30-offset timezones). Coverage is tracked
  // per sensor: bucket materialization is a per-series flush, so one
  // sensor's landed hour must not suppress another sensor's tail minutes
  // for that same hour.
  const HOUR_MS = 60 * 60 * 1000;
  const nativeEndsBySensor = new Map<string, number[]>();
  for (const [, data] of byHourSensor) {
    if (!data.fine) {
      const ends = nativeEndsBySensor.get(data.sensor_id) || [];
      ends.push(new Date(data.time).getTime());
      nativeEndsBySensor.set(data.sensor_id, ends);
    }
  }
  const coveredByNative = (sensorId: string, iso: string): boolean => {
    const t = new Date(iso).getTime();
    const ends = nativeEndsBySensor.get(sensorId);
    return ends ? ends.some((end) => t <= end && t > end - HOUR_MS) : false;
  };

  // Aggregate across sensors by hour (group by time only)
  const byHour = new Map<string, { in: number; out: number }>();
  for (const [_key, data] of byHourSensor) {
    if (data.fine && coveredByNative(data.sensor_id, data.time)) {
      continue;
    }
    const time = data.fine ? toHourEnd(data.time) : data.time;
    if (!byHour.has(time)) {
      byHour.set(time, { in: 0, out: 0 });
    }

    const hourCounts = byHour.get(time)!;
    hourCounts.in += data.in;
    hourCounts.out += data.out;
  }

  // Build hourly breakdown (keep UTC timestamps like unified tools)
  const hourlyBreakdown = Array.from(byHour.entries())
    .map(([time, counts]) => ({
      hour_utc: time, // Full ISO timestamp from API
      entries: Math.round(counts.in),
      exits: Math.round(counts.out),
      total_traffic: Math.round(counts.in + counts.out),
      net_flow: Math.round(counts.in - counts.out),
    }))
    .sort((a, b) => a.hour_utc.localeCompare(b.hour_utc));

  // Calculate totals
  const totalEntries = hourlyBreakdown.reduce((sum, h) => sum + h.entries, 0);
  const totalExits = hourlyBreakdown.reduce((sum, h) => sum + h.exits, 0);
  const totalTraffic = totalEntries + totalExits;
  const netFlow = totalEntries - totalExits;

  // Find peak hour (by total traffic)
  let peakHour = hourlyBreakdown.length > 0 ? hourlyBreakdown[0] : null;
  for (const hour of hourlyBreakdown) {
    if (hour.total_traffic > (peakHour?.total_traffic || 0)) {
      peakHour = hour;
    }
  }

  // Build enhanced summary
  const netFlowStr = netFlow >= 0 ? `+${netFlow}` : `${netFlow}`;
  const summary = `${displayName}: ${totalTraffic.toLocaleString()} movements ${periodDescription} (${totalEntries.toLocaleString()} entries, ${totalExits.toLocaleString()} exits, net flow: ${netFlowStr})`;

  // Compose the response warning. Two independent conditions can raise one and
  // both matter, so they are joined rather than one silently shadowing the other.
  const warnings: string[] = [];
  // Offline warning — computed here, after the totals, because it must only
  // qualify a zero the outage can actually explain. `is_online` is the
  // liveness signal (NOT `installation_status`, a provisioning-workflow
  // checkbox that nothing in the data pipeline reads and fleets routinely
  // never flip). Truthiness matches butlr_hardware_snapshot: null/absent
  // counts as offline. A last heartbeat at/after the window's stop means the
  // outage began after the queried range, so the zero is real data — no
  // warning. Sensors that dropped and reconnected inside the window can't be
  // detected from a point-in-time heartbeat; that gap is documented, not
  // guessed at.
  const allSensorsOffline = trafficSensors.length > 0 && trafficSensors.every((s) => !s.is_online);
  if (allSensorsOffline && totalTraffic === 0) {
    const stopMs = new Date(stop).getTime();
    const latestHeartbeatMs =
      Math.max(0, ...trafficSensors.map((s) => s.last_heartbeat || 0)) * 1000;
    const outageBeganAfterWindow = latestHeartbeatMs >= stopMs;
    if (!outageBeganAfterWindow) {
      const lastSeen =
        latestHeartbeatMs > 0 ? ` (last seen ${new Date(latestHeartbeatMs).toISOString()})` : "";
      warnings.push(
        isSensorQuery
          ? `Sensor "${displayName}" is currently offline${lastSeen}. The zero count for this window may reflect the outage rather than actual traffic. Check butlr_get_asset_details for its current status.`
          : `All ${trafficSensors.length} traffic sensor(s) in this room are currently offline${lastSeen}. The zero count for this window may reflect the outage rather than actual traffic. Check butlr_get_asset_details for their status.`
      );
    }
  }
  if (usedUtcFallback) {
    // Window-aware copy. The midnight sentence is only true on the `today`
    // branch. The unassigned-sensor path sets timezoneFallback for every
    // room-less, floor-less sensor, so on a 20m/1h/custom window the old text
    // fired routinely and sent the reader chasing a day-alignment problem that
    // no part of the query involved.
    // `timezone` holds whatever the fallback actually resolved to — UTC, or
    // BUTLR_TIMEZONE when configured — so the copy names it rather than
    // asserting UTC for a query that may have used something else.
    warnings.push(
      timeWindow === "today"
        ? `Could not determine local timezone for this space; timestamps use midnight in the fallback timezone (${timezone}). 'Today' may not align with the site's actual local day.`
        : `Could not determine local timezone for this space; hourly bucket alignment falls back to ${timezone}, so buckets may not line up with the site's local hours. The queried range itself is unaffected.`
    );
  }

  // Build response with timezone metadata and in/out breakdown
  const response: TrafficFlowResponse = {
    space: {
      id: spaceId,
      name: displayName,
      type: isSensorQuery ? "sensor" : "room",
      path: roomPath,
      sensor_mode: "traffic",
      ...tzMetadata,
    },
    traffic: {
      total_entries: totalEntries,
      total_exits: totalExits,
      total_traffic: totalTraffic,
      net_flow: netFlow,
      sensor_count: trafficSensors.length,
      period: {
        start_utc: start,
        stop_utc: stop,
        description: periodDescription,
      },
    },
    hourly_breakdown: hourlyBreakdown,
    peak_hour: peakHour
      ? {
          hour_utc: peakHour.hour_utc,
          total_traffic: peakHour.total_traffic,
          entries: peakHour.entries,
          exits: peakHour.exits,
          net_flow: peakHour.net_flow,
        }
      : null,
    summary,
    timestamp: new Date().toISOString(),
    timezone_note:
      "All timestamps are UTC (ISO-8601). Use site_timezone to interpret in local time.",
    // Traffic events take ~5-6 minutes to land in the reporting store, so a
    // window ending at/near now structurally undercounts the trailing minutes
    ...(Date.now() - new Date(stop).getTime() < 10 * 60 * 1000 && {
      freshness_note:
        "Traffic data becomes available roughly 5-10 minutes after events occur. Counts for the most recent ~10 minutes may still be incomplete; re-query later for final numbers.",
    }),
    ...(warnings.length > 0 && { warning: warnings.join(" ") }),
  };

  return response;
}

/**
 * Register butlr_traffic_flow with an McpServer instance
 */
export function registerTrafficFlow(server: McpServer): void {
  server.registerTool(
    "butlr_traffic_flow",
    {
      title: "Traffic Flow",
      description: TRAFFIC_FLOW_DESCRIPTION,
      inputSchema: trafficFlowInputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    withToolErrorHandling(async (args) => {
      const validated = TrafficFlowArgsSchema.parse(args);
      const result = await executeTrafficFlow(validated);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    })
  );
}
