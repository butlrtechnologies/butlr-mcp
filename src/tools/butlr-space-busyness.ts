import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { gql } from "@apollo/client";
import { queryWithArchiveFallback } from "../clients/archive-fallback.js";
import { SPACE_ARCHIVE_FIELDS } from "../clients/queries/archive-fields.js";
import { fetchTopology } from "../utils/occupancy-helpers.js";
import {
  describeSpaceRef,
  findReplacements,
  formatArchiveDate,
  isArchived,
  toSpaceRef,
  type SpaceRef,
} from "../utils/archived-spaces.js";
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
  "Archived spaces: an archived room or zone has no live busyness. If it has exactly one replacement that is not archived, the tool reports the replacement and says so in `warning`; otherwise it returns the archived space with `space.archived_at`, `current: null`, any successors in `space.replaced_by`, and a `history_note` pointing at `history_end` from the occupancy tools.\n\n" +
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
 * Fetch a room or zone by ID, including its archive fields (stripped and
 * retried on an API that predates them, see archive-fallback.ts).
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
  const siteTimezone = building?.site?.timezone;
  return {
    space,
    path: building ? `${building.name} > ${floor.name} > ${space.name}` : space.name,
    timezone: siteTimezone || process.env.BUTLR_TIMEZONE || "UTC",
    timezoneFallback: !siteTimezone,
  };
}

/**
 * Response for an archived space that was not redirected to a replacement:
 * no live busyness (`current: null`), flagged as archived, pointing at the
 * occupancy tools for its history and listing any successors.
 */
function buildArchivedResponse(
  fetched: FetchedSpace,
  spaceType: "room" | "zone",
  successors: SpaceRef[],
  warnings: string[]
): SpaceBusynessResponse {
  const { space } = fetched;
  const archivedAt = space.archivedAt as string;
  const archivedOn = formatArchiveDate(archivedAt, fetched.timezone);
  const successorText =
    successors.length > 0
      ? ` It was replaced by ${successors.map(describeSpaceRef).join(", ")}; query ${successors.length === 1 ? "that space" : "one of those"} for live busyness.`
      : "";
  const response: SpaceBusynessResponse = {
    space: {
      id: space.id,
      name: space.name,
      type: spaceType,
      path: fetched.path,
      archived_at: archivedAt,
      ...(successors.length > 0 ? { replaced_by: successors } : {}),
    },
    current: null,
    recommendation: `This ${spaceType} was archived on ${archivedOn} and has no live busyness.${successorText}`,
    history_note:
      `Archived on ${archivedOn}. Its recorded history can end earlier than that: ` +
      `butlr_get_occupancy_timeseries and butlr_get_current_occupancy return the last recorded day as history_end for ${space.id}.`,
    summary: `${space.name} is archived (since ${archivedOn}) and has no live occupancy.`,
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

    debug("space-busyness", `Using best match: ${bestMatch.name} (${spaceId})`);
  } else {
    // Determine type from ID prefix
    spaceType = spaceId.startsWith("room_") ? "room" : "zone";
  }

  let fetched = await fetchSpace(spaceType, spaceId);

  // An archived space has no live busyness. Follow its replacement only when
  // that is unambiguous: exactly one successor, itself not archived. A split
  // (several successors) or an archived successor returns the archived space
  // itself, flagged, with its successors listed.
  if (fetched.space.archivedAt) {
    const topology = await fetchTopology();
    const successors = findReplacements(topology.floors, spaceType, spaceId);
    const successorRefs = successors.map((s) => toSpaceRef(s.id, s));
    if (successors.length === 1 && !isArchived(successors[0])) {
      const archived = fetched.space;
      fetched = await fetchSpace(spaceType, successors[0].id);
      spaceId = fetched.space.id;
      warnings.push(
        `"${archived.name}" (${archived.id}) is archived; showing its replacement ${describeSpaceRef(toSpaceRef(fetched.space.id, fetched.space))}.`
      );
    }
    if (fetched.space.archivedAt) {
      if (fetched.timezoneFallback) {
        warnings.push(
          `Could not determine site timezone for this space. Using ${fetched.timezone} as fallback for the archive date.`
        );
      }
      return buildArchivedResponse(fetched, spaceType, successorRefs, warnings);
    }
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
