import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { gql } from "@apollo/client";
import { queryWithArchiveFallback } from "../clients/archive-fallback.js";
import { SPACE_ARCHIVE_FIELDS } from "../clients/queries/archive-fields.js";
import { fetchTopology } from "../utils/occupancy-helpers.js";
import {
  describeSpaceRef,
  findSpace,
  formatArchiveDate,
  indexReplacements,
  isRetired,
  toSpaceRef,
  type SpaceRef,
} from "../utils/archived-spaces.js";
import { resolveTimezone } from "../utils/timezone-helpers.js";
import { floorsOf, getCachedMergedTopology } from "../cache/topology-cache.js";
import { z } from "zod";
import type { Room, Zone, Floor } from "../clients/types.js";
import { getCurrentOccupancy, ApiError } from "../clients/reporting-client.js";
import { getSingleAssetStats } from "../clients/stats-client.js";
import { executeSearchAssets } from "./butlr-search-assets.js";
import {
  buildBusynessSummary,
  getOccupancyLabel,
  getTrendLabel,
  getBusinessRecommendation,
  formatDayAndTime,
} from "../utils/natural-language.js";
import { getCachedOccupancy, setCachedOccupancy } from "../cache/occupancy-cache.js";
import { rethrowIfGraphQLError, throwIfGraphQLErrors } from "../utils/graphql-helpers.js";
import { debug } from "../utils/debug.js";
import { withToolErrorHandling } from "../errors/mcp-errors.js";
import type { SpaceBusynessResponse } from "../types/responses.js";

/** Room with floor populated via GraphQL (includes building/site for timezone). */
type RoomWithFloor = Room & {
  floor: Floor & {
    building: {
      id: string;
      name: string;
      site_id: string;
      // `site.id` must remain in the GraphQL selection — see GET_ROOM below.
      site?: { id: string; timezone: string };
    };
  };
};

/** Zone with floor populated via GraphQL (includes building/site for timezone). */
type ZoneWithFloor = Zone & {
  floor: Floor & {
    building: {
      id: string;
      name: string;
      site_id: string;
      // `site.id` must remain in the GraphQL selection — see GET_ZONE below.
      site?: { id: string; timezone: string };
    };
  };
};

/** Shared shape -- used by both registerTool (SDK schema) and full validation */
const spaceBusynessInputShape = {
  space_id_or_name: z
    .string()
    .min(1, "space_id_or_name cannot be empty")
    .max(200, "space_id_or_name too long (max: 200 chars)")
    .trim()
    .describe("Space ID (room_123) or search term ('café', 'lobby')"),

  include_trend: z
    .boolean()
    .default(true)
    .describe("Compare to typical occupancy for this day/time"),
};

export const SpaceBusynessArgsSchema = z.object(spaceBusynessInputShape).strict();

const SPACE_BUSYNESS_DESCRIPTION =
  "Get current occupancy busyness for any room or zone with qualitative labels (quiet/moderate/busy) and trend comparison vs. typical usage. Designed for employee experience apps, wayfinding kiosks, and workplace analytics. Helps employees make real-time decisions about where to work and helps workplace teams understand space demand patterns.\n\n" +
  "Primary Users:\n" +
  "- Workplace Manager: Monitor amenity usage (cafés, focus rooms, lounges), optimize space allocation, improve employee experience\n" +
  "- Employee/End User: Decide whether to visit café, find quiet focus areas, avoid crowded collaboration spaces\n" +
  "- Facilities Coordinator: Validate HVAC/cleaning schedules match actual occupancy patterns\n" +
  "- Portfolio Manager: Understand space demand during different times for densification analysis\n\n" +
  "Example Queries:\n" +
  '1. "How busy is the café right now? Should I go?"\n' +
  '2. "Is the 3rd floor collaboration zone crowded?"\n' +
  '3. "How full is the main lobby?"\n' +
  '4. "Is the fitness center busy compared to usual?"\n' +
  '5. "Check occupancy for Conference Room 401"\n' +
  '6. "Is the outdoor terrace busier than normal for Friday afternoon?"\n' +
  '7. "How crowded is the co-working area on Floor 2?"\n' +
  '8. "Is the cafeteria quiet enough for a phone call right now?"\n\n' +
  "When to Use:\n" +
  "- Real-time 'should I go there now?' recommendations for employees\n" +
  "- Understand if a space is busier or quieter than typical for this day/time\n" +
  "- Troubleshooting complaints about crowded amenities (café, gym, lounge)\n" +
  "- Validating right-sizing decisions ('Is this space too large/small for actual demand?')\n" +
  "- Optimizing cleaning or HVAC schedules based on actual occupancy\n\n" +
  "When NOT to Use:\n" +
  "- Precise occupancy counts for capacity planning → use butlr_get_current_occupancy for exact numbers\n" +
  "- Historical utilization patterns → use butlr_get_occupancy_timeseries for time series data\n" +
  "- Entry/exit traffic counts (lobby, building entrance) → use butlr_traffic_flow instead\n" +
  "- Searching for a space first → use butlr_search_assets to find room/zone ID by name\n\n" +
  "Qualitative Labels: Quiet (<30% utilized), Moderate (30-70%), Busy (>=70%)\n\n" +
  "Retired spaces: a room or zone with no sensors that is archived (or had its sensors removed) has no live busyness. If it has exactly one replacement that is not retired, the tool reports the replacement and says so in `warning`; otherwise it returns the retired space with `current: null`, `space.archived_at` when archived, any successors in `space.replaced_by`, and a `history_note` pointing at `history_end` from the occupancy tools. An archived space that still has sensors is read live, with a warning.\n\n" +
  "See Also: butlr_get_current_occupancy, butlr_traffic_flow, butlr_search_assets, butlr_get_occupancy_timeseries";

export type SpaceBusynessArgs = z.output<typeof SpaceBusynessArgsSchema>;

// The `site { id ... }` selection is load-bearing. graphql-client.ts declares
// `Site: { keyFields: ['id'] }` on the Apollo cache; a Site returned without
// its `id` cannot be normalized, and under `errorPolicy: 'all'` Apollo then
// resolves with `result.data === undefined` and no thrown error. The same
// rule applies to Building and Floor (already selected here).
const GET_ROOM = gql`
  query GetRoom($roomId: ID!) {
    room(id: $roomId) {
      id
      name
      floorID
      roomType
      ${SPACE_ARCHIVE_FIELDS}
      sensors {
        id
      }
      capacity {
        max
        mid
      }
      floor {
        id
        name
        building_id
        building {
          id
          name
          site_id
          site {
            id
            timezone
          }
        }
      }
    }
  }
`;

const GET_ZONE = gql`
  query GetZone($zoneId: ID!) {
    zone(id: $zoneId) {
      id
      name
      floorID
      ${SPACE_ARCHIVE_FIELDS}
      sensors {
        id
      }
      capacity {
        max
        mid
      }
      floor {
        id
        name
        building_id
        building {
          id
          name
          site_id
          site {
            id
            timezone
          }
        }
      }
    }
  }
`;

interface FetchedSpace {
  space: RoomWithFloor | ZoneWithFloor;
  path: string;
  timezone: string;
  timezoneFallback: boolean;
}

/**
 * Fetch a room or zone by ID, with its archive fields (stripped when the
 * API lacks them, see archive-fallback.ts) and its attributed sensor IDs.
 */
async function fetchSpace(spaceType: "room" | "zone", spaceId: string): Promise<FetchedSpace> {
  let space: RoomWithFloor | ZoneWithFloor | undefined;
  try {
    if (spaceType === "room") {
      const result = await queryWithArchiveFallback<{ room: RoomWithFloor }>(GET_ROOM, {
        roomId: spaceId,
      });
      throwIfGraphQLErrors(result);
      space = result.data?.room;
      if (!space) throw new Error(`Room ${spaceId} not found`);
    } else {
      const result = await queryWithArchiveFallback<{ zone: ZoneWithFloor }>(GET_ZONE, {
        zoneId: spaceId,
      });
      throwIfGraphQLErrors(result);
      space = result.data?.zone;
      if (!space) throw new Error(`Zone ${spaceId} not found`);
    }
  } catch (error: unknown) {
    rethrowIfGraphQLError(error);
    throw error;
  }

  const floor = space.floor;
  const building = floor?.building;
  const tz = resolveTimezone(building?.site?.timezone);
  return {
    space,
    path: building ? `${building.name} > ${floor.name} > ${space.name}` : space.name,
    timezone: tz.timezone,
    timezoneFallback: tz.isFallback,
  };
}

/** Every sensor attributed to the fetched space (`sensors { id }`). */
function attributedCount(space: RoomWithFloor | ZoneWithFloor): number {
  return (space.sensors ?? []).length;
}

/**
 * Successors of a retired space. Search results and the cached topology are
 * trusted only when that same source already had the space archived with at
 * least one successor: a source that predates the re-draw would otherwise
 * turn "no successor info yet" into "no successor". Otherwise the topology
 * is fetched; if that fails, `known` is false and the caller still answers
 * (a retired response without successors beats an error). This refetches
 * the whole topology for a retired space with no successor even when the
 * cache is warm: a deliberate freshness-over-cost tradeoff, since a stale
 * cache cannot tell "no successor" from "re-drawn since".
 */
async function findSuccessors(
  spaceId: string,
  fromSearch: { archived_at?: string; replaced_by?: SpaceRef[] } | undefined
): Promise<{ refs: SpaceRef[]; known: boolean }> {
  if (fromSearch?.archived_at && fromSearch.replaced_by?.length) {
    return { refs: fromSearch.replaced_by, known: true };
  }
  const cachedSites = getCachedMergedTopology();
  if (cachedSites) {
    const floors = floorsOf(cachedSites);
    const cachedSpace = findSpace(floors, "room", spaceId) ?? findSpace(floors, "zone", spaceId);
    const successors = indexReplacements(floors).get(spaceId) ?? [];
    if (cachedSpace?.archivedAt && successors.length > 0) {
      return { refs: successors.map((s) => toSpaceRef(s.id, s)), known: true };
    }
  }
  try {
    const floors = (await fetchTopology()).floors;
    const successors = indexReplacements(floors).get(spaceId) ?? [];
    return { refs: successors.map((s) => toSpaceRef(s.id, s)), known: true };
  } catch (error: unknown) {
    debug("space-busyness", "Could not load the topology to find replacements:", error);
    return { refs: [], known: false };
  }
}

/** Error text for a warning: the MCP-formatted message, e.g. "[RATE_LIMITED] ...". */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Response for a retired space (no sensors, and archived or with its
 * sensors removed) that was not redirected to a replacement: no live
 * busyness (`current: null`), pointing at the occupancy tools for its
 * history and listing any successors.
 */
function buildRetiredResponse(
  fetched: FetchedSpace,
  spaceType: "room" | "zone",
  successors: SpaceRef[],
  warnings: string[],
  /**
   * What is known about a single successor: "live" (fetched, not retired),
   * "retired" (fetched, retired too), or "unknown" (not fetched or failed).
   */
  singleSuccessor: "retired" | "unknown" = "unknown"
): SpaceBusynessResponse {
  const { space } = fetched;
  const archivedOn = space.archivedAt
    ? formatArchiveDate(space.archivedAt, fetched.timezone)
    : undefined;
  const removedOn = space.sensorsRemovedAt
    ? formatArchiveDate(space.sensorsRemovedAt, fetched.timezone)
    : undefined;
  const when = archivedOn
    ? `was archived on ${archivedOn}`
    : `had its sensors removed on ${removedOn}`;
  // Only point at a successor for live busyness when it is not known to be
  // retired itself (shared rule `isRetired`, not its archive flag alone).
  const list = successors.map(describeSpaceRef).join(", ");
  const successorText =
    successors.length === 0
      ? ""
      : successors.length === 1 && singleSuccessor === "retired"
        ? ` It was replaced by ${list}, which has no sensors and is retired too.`
        : successors.length === 1
          ? ` It was replaced by ${list}.`
          : ` It was replaced by ${list}; query one of those for live busyness.`;
  const response: SpaceBusynessResponse = {
    space: {
      id: space.id,
      name: space.name,
      type: spaceType,
      path: fetched.path,
      ...(space.archivedAt ? { archived_at: space.archivedAt } : {}),
      ...(successors.length > 0 ? { replaced_by: successors } : {}),
    },
    current: null,
    recommendation: `This ${spaceType} ${when}, has no sensors assigned and has no live busyness.${successorText}`,
    history_note:
      `No live data. The last full day of its recorded history comes back as history_end from ` +
      `butlr_get_occupancy_timeseries and butlr_get_current_occupancy for ${space.id}; it is no later than ` +
      `the day before ${archivedOn ? "the archive date" : "its sensors were removed"}, and can be much earlier.`,
    summary: `${space.name} ${archivedOn ? `is archived (since ${archivedOn})` : `has had no sensors since ${removedOn}`} and has no live occupancy.`,
    timestamp: new Date().toISOString(),
  };
  if (warnings.length > 0) response.warning = warnings.join(" ");
  return response;
}

/**
 * Execute space busyness tool
 */
export async function executeSpaceBusyness(
  args: SpaceBusynessArgs
): Promise<SpaceBusynessResponse> {
  let spaceId = args.space_id_or_name;
  let spaceType: "room" | "zone" = "room";
  const warnings: string[] = [];
  // The best name match as the search saw it (archive state, successors).
  let searchMatch: { archived_at?: string; replaced_by?: SpaceRef[] } | undefined;

  // If not an ID, search for the space
  if (!spaceId.match(/^(room|zone)_/)) {
    debug("space-busyness", `Searching for space: "${args.space_id_or_name}"`);

    const searchResults = await executeSearchAssets({
      query: args.space_id_or_name,
      asset_types: ["room", "zone"],
      max_results: 5,
    });

    if (searchResults.matches.length === 0) {
      throw new Error(
        `No spaces found matching "${args.space_id_or_name}". Try a different search term.`
      );
    }

    // Use the best match. An archived best match is NOT swapped for a weaker
    // non-archived one; it gets the archived handling below, like an
    // archived space passed by ID.
    const bestMatch = searchResults.matches[0];
    spaceId = bestMatch.id;
    spaceType = bestMatch.type as "room" | "zone";
    searchMatch = bestMatch;

    debug("space-busyness", `Using best match: ${bestMatch.name} (${spaceId})`);
  } else {
    // Determine type from ID prefix
    spaceType = spaceId.startsWith("room_") ? "room" : "zone";
  }

  let fetched = await fetchSpace(spaceType, spaceId);

  // A retired space (no sensors attributed, and archived or with its sensors
  // removed; shared rule `isRetired`) has no live busyness. Follow its
  // replacement only when that is unambiguous: exactly one successor, and
  // that successor is not retired itself. A split, a retired successor, or
  // one that cannot be loaded returns the retired space, with successors
  // listed. An archived space that still has sensors is read live.
  if (isRetired(fetched.space, attributedCount(fetched.space))) {
    const retired = fetched;
    const { refs, known } = await findSuccessors(spaceId, searchMatch);
    if (!known) {
      warnings.push("Could not look up this space's replacements; it may have been replaced.");
    }
    // Follow a single successor whenever it is live by the shared rule
    // (`isRetired`): an archived successor that still has sensors is live.
    let singleSuccessor: "retired" | "unknown" = "unknown";
    if (refs.length === 1) {
      let successor: FetchedSpace | undefined;
      try {
        successor = await fetchSpace(spaceType, refs[0].id);
      } catch (error: unknown) {
        debug("space-busyness", "Could not load the replacement:", error);
        warnings.push(
          `Could not load its replacement ${describeSpaceRef(refs[0])}: ${errorText(error)}`
        );
      }
      if (successor && !isRetired(successor.space, attributedCount(successor.space))) {
        fetched = successor;
        spaceId = successor.space.id;
        warnings.push(
          `"${retired.space.name}" (${retired.space.id}) is ${retired.space.archivedAt ? "archived" : "retired"}; showing its replacement ${describeSpaceRef(toSpaceRef(successor.space.id, successor.space))}.`
        );
      } else if (successor) {
        // The successor is retired too: list it as such, don't follow it.
        singleSuccessor = "retired";
        refs[0] = {
          ...refs[0],
          ...(successor.space.archivedAt ? { archived_at: successor.space.archivedAt } : {}),
        };
      }
    }
    if (fetched === retired) {
      if (retired.timezoneFallback) {
        warnings.push(
          `Could not determine site timezone for this space. Using ${retired.timezone} as fallback for dates.`
        );
      }
      return buildRetiredResponse(retired, spaceType, refs, warnings, singleSuccessor);
    }
  } else if (fetched.space.archivedAt) {
    const n = attributedCount(fetched.space);
    warnings.push(
      `"${fetched.space.name}" was archived on ${formatArchiveDate(fetched.space.archivedAt, fetched.timezone)} but still has ${n} sensor${n === 1 ? "" : "s"} attributed (a data-integrity issue), so it is read live.`
    );
  }

  const space = fetched.space;
  const spaceTimezone = fetched.timezone;
  const timezoneFallback = fetched.timezoneFallback;

  // Get current occupancy (check cache first)
  const now = new Date();
  let currentOccupancy = 0;

  const cached = getCachedOccupancy(spaceId, now);
  if (cached) {
    currentOccupancy = cached.occupancy;
    debug("space-busyness", `Using cached occupancy: ${currentOccupancy}`);
  } else {
    try {
      const occupancyData = await getCurrentOccupancy(spaceType, [spaceId]);
      if (occupancyData.length > 0) {
        currentOccupancy = occupancyData[0].value;
        setCachedOccupancy(spaceId, currentOccupancy, spaceType, now);
      }
    } catch (error: unknown) {
      debug("space-busyness", "Failed to get occupancy:", error);
      if (error instanceof ApiError && error.statusCode >= 400) {
        throw error;
      }
      throw new Error(
        `Failed to get current occupancy for ${space.name}. The space may not have active sensors.`
      );
    }
  }

  // Calculate utilization (null when capacity is not configured)
  const maxCapacity = space.capacity?.max;
  const capacityConfigured = !!(maxCapacity && maxCapacity > 0);
  const utilizationPercent = capacityConfigured ? (currentOccupancy / maxCapacity) * 100 : null;
  const label = utilizationPercent !== null ? getOccupancyLabel(utilizationPercent) : null;

  // Build response
  if (timezoneFallback) {
    warnings.push(
      `Could not determine site timezone for this space. Using ${spaceTimezone} as fallback — time-based comparisons may not reflect the site's actual local time.`
    );
  }
  if (!capacityConfigured) {
    warnings.push(
      "Capacity is not configured for this space. Utilization percentage and busyness label are unavailable. Configure capacity in the Butlr dashboard for richer insights."
    );
  }

  const response: SpaceBusynessResponse = {
    space: {
      id: space.id,
      name: space.name,
      type: spaceType,
      path: fetched.path,
    },
    current: {
      occupancy: Math.round(currentOccupancy),
      capacity: space.capacity,
      utilization_percent:
        utilizationPercent !== null ? parseFloat(utilizationPercent.toFixed(1)) : null,
      label,
      capacity_configured: capacityConfigured,
      as_of: now.toISOString(),
    },
    recommendation: label
      ? getBusinessRecommendation(label)
      : "Unable to assess busyness without configured capacity.",
    summary: "", // Populated below
    timestamp: now.toISOString(),
  };

  // Get trend if requested
  if (args.include_trend !== false) {
    try {
      // Query last 4 weeks of data (v4 Stats API uses occupancy_avg_presence for both rooms and zones).
      // The v4 Stats API requires ISO-8601 absolute timestamps and rejects relative formats
      // like "-4w" (stats-client's parseRelativeTime only handles m/h/d, not weeks).
      const measurement = "occupancy_avg_presence";
      const trendStart = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000).toISOString();
      const stats = await getSingleAssetStats(measurement, spaceId, trendStart, now.toISOString());

      if (stats) {
        const typical = stats.mean;
        let vsTypicalPercent: number;
        if (typical > 0) {
          vsTypicalPercent = ((currentOccupancy - typical) / typical) * 100;
        } else if (currentOccupancy > 0) {
          vsTypicalPercent = 100;
        } else {
          vsTypicalPercent = 0;
        }
        const trendLabel = getTrendLabel(vsTypicalPercent);

        response.trend = {
          typical_for_time: parseFloat(typical.toFixed(1)),
          vs_typical_percent: parseFloat(vsTypicalPercent.toFixed(1)),
          trend_label: trendLabel,
          historical_context: `${formatDayAndTime(now, spaceTimezone)} avg: ${Math.round(typical)} people (last 4 weeks)`,
        };
      }
    } catch (error: unknown) {
      debug("space-busyness", "Failed to get trend data:", error);
      if (error instanceof ApiError && error.statusCode >= 400) {
        throw error;
      }
      warnings.push("Could not retrieve historical trend data. Trend comparison is unavailable.");
    }
  }

  // Build summary
  if (capacityConfigured && utilizationPercent !== null) {
    response.summary = buildBusynessSummary({
      spaceName: space.name,
      occupancy: Math.round(currentOccupancy),
      capacity: maxCapacity,
      utilizationPercent,
      trendLabel: response.trend?.trend_label,
      dayTime: formatDayAndTime(now, spaceTimezone),
    });
  } else {
    response.summary = `${space.name}: ${Math.round(currentOccupancy)} people (capacity not configured)`;
  }

  if (warnings.length > 0) {
    response.warning = warnings.join(" ");
  }

  return response;
}

/**
 * Register butlr_space_busyness with an McpServer instance
 */
export function registerSpaceBusyness(server: McpServer): void {
  server.registerTool(
    "butlr_space_busyness",
    {
      title: "Space Busyness",
      description: SPACE_BUSYNESS_DESCRIPTION,
      inputSchema: spaceBusynessInputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    withToolErrorHandling(async (args) => {
      const validated = SpaceBusynessArgsSchema.parse(args);
      const result = await executeSpaceBusyness(validated);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    })
  );
}
