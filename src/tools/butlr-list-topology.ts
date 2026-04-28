import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apolloClient } from "../clients/graphql-client.js";
import { GET_FULL_TOPOLOGY, GET_ALL_SENSORS, GET_ALL_HIVES } from "../clients/queries/topology.js";
import { GET_TAGS_WITH_USAGE, type RawTagWithUsage } from "../clients/queries/tags.js";
import type {
  SitesResponse,
  Site,
  Building,
  Floor,
  Room,
  Zone,
  Sensor,
  Hive,
} from "../clients/types.js";
import { z } from "zod";
import {
  getCachedTopology,
  setCachedTopology,
  generateTopologyCacheKey,
} from "../cache/topology-cache.js";
import { formatTopologyTree } from "../utils/tree-formatter.js";
import {
  isProductionSensor,
  isProductionHive,
  rethrowIfGraphQLError,
  throwIfGraphQLErrors,
} from "../utils/graphql-helpers.js";
import { resolveTagNames } from "../utils/tag-resolver.js";
import { debug } from "../utils/debug.js";
import { withToolErrorHandling } from "../errors/mcp-errors.js";
import type { ListTopologyResponse } from "../types/responses.js";

const LIST_TOPOLOGY_DESCRIPTION =
  "Display org hierarchy tree with flexible depth control. Can show full tree, specific subtrees, or flat lists. " +
  "Supports filtering by parent asset IDs and by tag names. Depth levels: 0=sites, 1=buildings, 2=floors, 3=rooms/zones, 4=hives, 5=sensors. " +
  "Use starting_depth to choose which level to show, and traversal_depth to control how many levels below to include.\n\n" +
  "Tag filter:\n" +
  "- Pass tag_names (case-insensitive) to scope the tree to subtrees containing rooms, zones, or floors with those tags. Combines AND-style with asset_ids when both are supplied.\n" +
  "- tag_match defaults to 'any' (entity tagged with at least one of the names) — note this differs from butlr_available_rooms, which defaults to 'all' because it filters a single entity type.\n" +
  "- Use butlr_list_tags to discover what tag vocabulary exists in this org.\n\n" +
  "Diagnostics:\n" +
  "- The response includes a `warning` field when a filter input doesn't fully resolve — typo'd asset_ids, unknown tag_names, asset_ids and tag_names scoping disjoint subtrees, or tag associations pointing at deleted entities. Read it before retrying.\n" +
  "- `unknown_tags` lists any tag names that didn't resolve, for the caller to surface or correct.\n\n" +
  "When NOT to Use:\n" +
  "- Searching for assets by name or keyword → use butlr_search_assets for fuzzy name-based lookups\n" +
  "- Need detailed info for a specific asset you already have an ID for → use butlr_get_asset_details instead\n" +
  "- Need only specific fields for known entity IDs → use butlr_fetch_entity_details for selective field fetching\n" +
  "- Want every tagged entity (not the surrounding hierarchy) → use butlr_list_tags with include_entities=true";

/** Shared shape — used by both registerTool (SDK schema) and full validation */
const listTopologyInputShape = {
  asset_ids: z
    .array(z.string())
    .optional()
    .describe(
      "Optional: Parent asset IDs to show tree for. If empty, shows all sites. " +
        "Examples: ['site_123'], ['building_456'], ['floor_789']"
    ),

  starting_depth: z
    .number()
    .default(0)
    .describe(
      "Depth level to start showing assets. 0=sites, 1=buildings, 2=floors, 3=rooms/zones, 4=hives, 5=sensors. " +
        "Use with traversal_depth=0 to show only assets at this level (flat list)."
    ),

  traversal_depth: z
    .number()
    .default(0)
    .describe(
      "How many levels below starting_depth to traverse. 0=starting level only, 1=one level below, etc. " +
        "Default is 0 to minimize token usage. Use 10 for full tree."
    ),

  tag_names: z
    .array(z.string().min(1, "Tag cannot be empty").trim())
    .min(1, "tag_names array cannot be empty")
    .optional()
    .describe(
      "Filter tree to subtrees containing rooms, zones, or floors with these tag names (case-insensitive). " +
        "Combines AND-style with asset_ids. Use butlr_list_tags to discover available tag names."
    ),

  tag_match: z
    .enum(["all", "any"])
    .default("any")
    .describe(
      "Multi-tag semantics when tag_names has more than one entry: 'any' (default) keeps entities tagged with at least one of the names, 'all' keeps only entities tagged with every name (within the same entity type). Defaults to 'any' here, unlike butlr_available_rooms which defaults to 'all'."
    ),
};

export const ListTopologyArgsSchema = z.object(listTopologyInputShape).strict();

type ListTopologyArgs = z.output<typeof ListTopologyArgsSchema>;

/**
 * Build the union/intersection of tagged-entity IDs across resolved tag rows.
 * Intersection (`all`) is taken per entity type — a single entity can only be
 * tagged within its own type — and the resulting per-type sets are unioned
 * into a flat ID set suitable for `filterTopologyByAssets`.
 */
function collectTaggedEntityIds(
  resolvedRows: RawTagWithUsage[],
  match: "all" | "any"
): Set<string> {
  const matched = new Set<string>();
  if (resolvedRows.length === 0) return matched;

  const kinds = ["rooms", "zones", "floors"] as const;
  for (const kind of kinds) {
    // Per R1 §2.2: drop refs whose `id` is null/undefined (stale tag→entity
    // associations after a hard delete, or partial GraphQL responses) so
    // they can't pollute the matched-id Set.
    const sets = resolvedRows.map(
      (row) =>
        new Set(
          (row[kind] ?? []).flatMap((e) =>
            typeof e.id === "string" && e.id.length > 0 ? [e.id] : []
          )
        )
    );
    let acc: Set<string>;
    if (match === "all") {
      acc = new Set(sets[0]);
      for (let i = 1; i < sets.length; i++) {
        for (const id of acc) if (!sets[i].has(id)) acc.delete(id);
      }
    } else {
      acc = new Set();
      for (const s of sets) for (const id of s) acc.add(id);
    }
    for (const id of acc) matched.add(id);
  }
  return matched;
}

/**
 * Walk the topology and collect every entity ID that is descendant of (or
 * equal to) the supplied `rootIds`. Used to compose `asset_ids` with
 * `tag_names` as a true subtree-overlap AND.
 *
 * Per R3 §1 (initial fix) and R4 (symmetric expansion): closure must be
 * applied to BOTH asset_ids AND tagged-entity IDs because a tag can sit on
 * an ancestor of an asset (e.g. tag on Floor 1, asset_ids=[room_001]) — the
 * room is then inside the tagged subtree even though their raw IDs don't
 * intersect. Closure-vs-closure intersection captures that overlap.
 *
 * Coverage by entity type:
 *   site      → site + every building/floor/room/zone/hive/sensor under it
 *   building  → building + every floor/room/zone/hive/sensor under it
 *   floor     → floor + its rooms, zones, hives, sensors
 *   room      → room + sensors/hives whose room_id points at it (devices
 *               are attached to floors in the in-memory topology, but
 *               logically belong to their room_id room when one is set)
 *   zone      → zone alone
 *   hive      → hive alone
 *   sensor    → sensor alone
 */
function expandToSubtreeClosure(sites: Site[], rootIds: string[]): Set<string> {
  const target = new Set(rootIds);
  const closure = new Set<string>();

  const addFloor = (floor: Floor) => {
    closure.add(floor.id);
    for (const room of floor.rooms ?? []) closure.add(room.id);
    for (const zone of floor.zones ?? []) closure.add(zone.id);
    for (const hive of floor.hives ?? []) closure.add(hive.id);
    for (const sensor of floor.sensors ?? []) closure.add(sensor.id);
  };
  const addBuilding = (building: Building) => {
    closure.add(building.id);
    for (const floor of building.floors ?? []) addFloor(floor);
  };

  for (const site of sites) {
    if (target.has(site.id)) {
      closure.add(site.id);
      for (const building of site.buildings ?? []) addBuilding(building);
      continue;
    }
    for (const building of site.buildings ?? []) {
      if (target.has(building.id)) {
        addBuilding(building);
        continue;
      }
      for (const floor of building.floors ?? []) {
        if (target.has(floor.id)) {
          addFloor(floor);
          continue;
        }
        // Floor-level leaf scan: rooms, zones, hives, sensors. A targeted
        // room also pulls in its room_id-bound zones, sensors, and hives —
        // a tag-on-room implicitly applies to children of that room, and
        // the formatter renders those entities under the room. Both
        // snake_case (`room_id`) and camelCase (`roomID`) link fields are
        // checked because the upstream API and cached payloads can carry
        // either shape (per R5 §2; mirrors src/utils/tree-formatter.ts).
        for (const room of floor.rooms ?? []) {
          if (!target.has(room.id)) continue;
          closure.add(room.id);
          for (const zone of floor.zones ?? []) {
            if ((zone.room_id ?? zone.roomID) === room.id) closure.add(zone.id);
          }
          for (const sensor of floor.sensors ?? []) {
            if ((sensor.room_id ?? sensor.roomID) === room.id) closure.add(sensor.id);
          }
          // Per R6: sensors reach a room two ways — directly via room_id, or
          // transitively through a room-bound hive (sensor.hive_serial ===
          // hive.serialNumber). The formatter renders both shapes under the
          // room (tree-formatter.ts:310 nests sensors under hives by
          // hive_serial, and a hive nests under its room by room_id), so
          // closure must follow the same chain. Otherwise a sensor with no
          // direct room link but attached to a room-bound hive falls out
          // of the room's tag closure entirely.
          for (const hive of floor.hives ?? []) {
            if ((hive.room_id ?? hive.roomID) !== room.id) continue;
            closure.add(hive.id);
            if (!hive.serialNumber) continue;
            for (const sensor of floor.sensors ?? []) {
              if (sensor.hive_serial === hive.serialNumber) closure.add(sensor.id);
            }
          }
        }
        for (const zone of floor.zones ?? []) {
          if (target.has(zone.id)) closure.add(zone.id);
        }
        for (const hive of floor.hives ?? []) {
          if (!target.has(hive.id)) continue;
          closure.add(hive.id);
          // Per R3 §3.2: defensive symmetry with the room→hive→sensor
          // chain above. Tags can't currently attach to sensors per the
          // GraphQL schema, so this branch has no observable effect on
          // current data, but it closes the symmetric-closure invariant
          // claimed in the comment block above and matches what the
          // formatter renders under a hive (formatHive children).
          if (!hive.serialNumber) continue;
          for (const sensor of floor.sensors ?? []) {
            if (sensor.hive_serial === hive.serialNumber) closure.add(sensor.id);
          }
        }
        for (const sensor of floor.sensors ?? []) {
          if (target.has(sensor.id)) closure.add(sensor.id);
        }
      }
    }
  }
  return closure;
}

/**
 * Execute butlr_list_topology tool
 */
export async function executeListTopology(
  args: ListTopologyArgs = {} as ListTopologyArgs
): Promise<ListTopologyResponse> {
  const startingDepth = args.starting_depth ?? 0;
  const traversalDepth = args.traversal_depth ?? 0;
  const assetIds = args.asset_ids ?? [];
  const tagNames = args.tag_names ?? [];
  // Per R2 §2.4: default is "any" here, in contrast to butlr_available_rooms
  // which defaults to "all". The asymmetry is intentional — list-topology
  // filters across rooms/zones/floors where intersection is rarely
  // satisfied; available-rooms filters a single entity type. Don't unify.
  const tagMatch = args.tag_match ?? "any";

  debug(
    "butlr-list-topology",
    `Fetching topology: starting_depth=${startingDepth}, traversal_depth=${traversalDepth}, assets=${assetIds.length || "all"}, tags=${tagNames.length ? `${tagMatch}:${tagNames.join(",")}` : "none"}`
  );

  // Resolve tag filter (if any) up-front so we can short-circuit on
  // unsatisfiable / no-match cases without paying for the topology fetch.
  let taggedEntityIds: Set<string> | undefined;
  let unknownTagNames: string[] = [];
  let tagWarning: string | undefined;

  if (tagNames.length > 0) {
    let tagsRaw: RawTagWithUsage[] = [];
    try {
      const tagsResult = await apolloClient.query<{ tags: RawTagWithUsage[] | null }>({
        query: GET_TAGS_WITH_USAGE,
        fetchPolicy: "network-only",
      });
      throwIfGraphQLErrors(tagsResult);
      tagsRaw = tagsResult.data?.tags ?? [];
    } catch (error: unknown) {
      rethrowIfGraphQLError(error);
      throw error;
    }

    const { resolvedRows, unknownNames, unsatisfiable } = resolveTagNames({
      allTags: tagsRaw,
      requestedNames: tagNames,
      match: tagMatch,
    });
    unknownTagNames = unknownNames;

    const baseQueryParams = {
      starting_depth: startingDepth,
      traversal_depth: traversalDepth,
      asset_filter: assetIds.length > 0 ? assetIds : ("all" as const),
      tag_filter: { names: tagNames, match: tagMatch },
    };

    if (resolvedRows.length === 0) {
      // When asset_ids was also supplied, opportunistically validate it
      // against a warm topology cache so a dual-typo input (tag wrong AND
      // asset_ids wrong) surfaces both diagnostics in a single round-trip.
      // We deliberately read only from the merged-devices cache — that is
      // the cache key `butlr_list_topology` itself writes — so the lookup
      // is authoritative for sensor/hive ids. `butlr_search_assets` writes
      // a separate, device-incomplete shape under a different key (see
      // `generateTopologyCacheKey(..., devicesMerged)`); reading that here
      // would false-positive a real device id as missing.
      //
      // Cache miss is treated as "couldn't verify" — an explicit
      // unverified-asset hint is appended instead so the caller knows the
      // asset typo (if any) wasn't checked. Paying for a full topology
      // fetch on the dual-typo path would dwarf the actual short-circuit.
      let assetHint = "";
      if (assetIds.length > 0) {
        const cacheKey = generateTopologyCacheKey(
          process.env.BUTLR_ORG_ID || "default",
          true,
          true,
          true, // devicesMerged: only the merged-shape cache is authoritative for device ids
          undefined
        );
        const cached = getCachedTopology(cacheKey);
        const cachedSites = cached?.data?.sites as Site[] | undefined;
        if (cachedSites) {
          if (expandToSubtreeClosure(cachedSites, assetIds).size === 0) {
            assetHint =
              " asset_ids also matched no entities in the org — verify those IDs with butlr_search_assets.";
          }
        } else {
          assetHint =
            " asset_ids were not validated (topology not yet cached) — re-run after correcting the tag names to confirm they exist.";
        }
      }
      return {
        tree: [],
        query_params: baseQueryParams,
        timestamp: new Date().toISOString(),
        warning:
          `No matching tags found in this org for: ${unknownNames.join(", ")}. ` +
          "Use butlr_list_tags to see available tag names." +
          assetHint,
        unknown_tags: unknownNames,
      };
    }

    if (unsatisfiable) {
      return {
        tree: [],
        query_params: baseQueryParams,
        timestamp: new Date().toISOString(),
        warning:
          `Cannot satisfy tag_match='all': unknown tag(s) ${unknownNames.join(", ")}. ` +
          "Use butlr_list_tags to see available tag names, or pass tag_match='any' to match entities tagged with any of the supplied tags.",
        unknown_tags: unknownNames,
      };
    }

    taggedEntityIds = collectTaggedEntityIds(resolvedRows, tagMatch);

    if (taggedEntityIds.size === 0) {
      // Per R1 §2.7.3: "any of [tag1]" reads awkwardly for the single-tag
      // case — drop the all/any preamble when there's only one name.
      const tagList =
        tagNames.length === 1
          ? `"${tagNames[0]}"`
          : `${tagMatch === "all" ? "all of" : "any of"} [${tagNames.join(", ")}]`;
      return {
        tree: [],
        query_params: baseQueryParams,
        timestamp: new Date().toISOString(),
        warning:
          `No rooms, zones, or floors are currently tagged with ${tagList}. ` +
          "Use butlr_list_tags { include_entities: true } to see what is tagged.",
        unknown_tags: unknownNames.length > 0 ? unknownNames : undefined,
      };
    }

    if (unknownNames.length > 0) {
      tagWarning =
        `Unknown tag(s) ignored: ${unknownNames.join(", ")}. ` +
        "Use butlr_list_tags to see available tag names.";
    }
  }

  // tag_filter (tag_names / tag_match) and asset_ids are intentionally
  // excluded from the cache key. The cache stores raw org-scoped topology
  // only; both filters are applied client-side post-fetch via
  // filterTopologyByAssets, so different filter shapes share one cached
  // tree. Do not extend this key with filter inputs without first
  // separating the cache layers.
  //
  // `devicesMerged: true` because this read path requires every floor to
  // carry its `sensors`/`hives` arrays (post-mergeSensorsAndHivesIntoTopology).
  // `butlr_search_assets` writes a separate device-incomplete shape under a
  // distinct key — the two consumers can never collide.
  const cacheKey = generateTopologyCacheKey(
    process.env.BUTLR_ORG_ID || "default",
    true, // include devices
    true, // include zones
    true, // devicesMerged: list-topology requires merged sensors/hives
    undefined
  );

  // Try to get cached topology
  let sites: Site[] = [];
  let partialData = false;
  const cached = getCachedTopology(cacheKey);

  if (cached && cached.data && cached.data.sites) {
    debug("butlr-list-topology", "Using cached topology");
    sites = cached.data.sites as Site[];
  } else {
    // Fetch fresh topology
    debug("butlr-list-topology", "Fetching fresh topology");

    try {
      const result = await apolloClient.query<{ sites: SitesResponse }>({
        query: GET_FULL_TOPOLOGY,
        fetchPolicy: "network-only",
      });

      // Apollo can return both data and errors - only fail if we have no data
      if (!result.data || !result.data.sites || !result.data.sites.data) {
        // If we have error but no data, throw
        if (result.error) {
          throw result.error;
        }
        throw new Error("Invalid response structure from API");
      }

      // Track whether the topology data is partial (errors alongside data)
      partialData = !!result.error;
      if (partialData) {
        debug("butlr-list-topology", "Warning: GraphQL errors present, data may be partial");
      }

      sites = result.data.sites.data;

      // Query all sensors and hives separately (nested fields are broken)
      debug("butlr-list-topology", "Fetching all sensors and hives...");

      const [sensorsResult, hivesResult] = await Promise.all([
        apolloClient.query<{ sensors: { data: Sensor[] } }>({
          query: GET_ALL_SENSORS,
          fetchPolicy: "network-only",
        }),
        apolloClient.query<{ hives: { data: Hive[] } }>({
          query: GET_ALL_HIVES,
          fetchPolicy: "network-only",
        }),
      ]);

      // Filter out test/placeholder devices from topology listing
      // (Note: These filters are ONLY for topology display, not occupancy queries)
      const allSensors = (sensorsResult.data?.sensors?.data || []).filter(isProductionSensor);
      const allHives = (hivesResult.data?.hives?.data || []).filter(isProductionHive);

      debug(
        "butlr-list-topology",
        `Got ${allSensors.length} production sensors, ${allHives.length} production hives (test/placeholder devices filtered)`
      );

      // Merge sensors and hives into topology by floor_id
      sites = mergeSensorsAndHivesIntoTopology(sites, allSensors, allHives);

      // Only cache complete topology data — partial results should be re-fetched
      if (!partialData) {
        setCachedTopology(cacheKey, { sites });
        debug("butlr-list-topology", `Cached topology with ${sites.length} sites`);
      } else {
        debug("butlr-list-topology", "Skipping cache — topology data is partial");
      }
    } catch (error: unknown) {
      rethrowIfGraphQLError(error);
      throw error;
    }
  }

  // Per R3 §1 + R4: compose asset_ids and tag_names as a true AND via
  // subtree-overlap intersection. Both sides are expanded to their full
  // descendant closure (including sensors/hives, plus devices bound to a
  // targeted room via room_id). Two surviving closures are then intersected
  // — this catches the case where a tag sits on an ancestor of an asset
  // (e.g. tag on a floor, asset_ids=[room_001] within that floor) which a
  // raw-ID intersection would miss.
  //
  // assetScopeEmpty / assetTagDisjoint are tracked separately so the
  // empty-tree warning can distinguish "asset_ids didn't resolve in this
  // org" from "filters scope disjoint subtrees" (R3 §2).
  let filterIds: string[] | undefined;
  let assetScopeEmpty = false;
  let assetTagDisjoint = false;

  if (assetIds.length > 0) {
    const assetClosure = expandToSubtreeClosure(sites, assetIds);
    assetScopeEmpty = assetClosure.size === 0;

    if (taggedEntityIds && taggedEntityIds.size > 0) {
      const tagClosure = expandToSubtreeClosure(sites, [...taggedEntityIds]);
      const intersection: string[] = [];
      for (const id of assetClosure) if (tagClosure.has(id)) intersection.push(id);
      if (!assetScopeEmpty && intersection.length === 0) {
        assetTagDisjoint = true;
      }
      filterIds = intersection;
    } else {
      filterIds = assetIds;
    }
  } else if (taggedEntityIds && taggedEntityIds.size > 0) {
    filterIds = [...taggedEntityIds];
  }

  let filteredSites = sites;
  if (filterIds !== undefined) {
    filteredSites = filterTopologyByAssets(filteredSites, filterIds);
  }

  // Format as tree with depth controls
  const tree = formatTopologyTree(filteredSites, startingDepth, traversalDepth);

  const response: ListTopologyResponse = {
    tree,
    query_params: {
      starting_depth: startingDepth,
      traversal_depth: traversalDepth,
      asset_filter: assetIds.length > 0 ? assetIds : "all",
      ...(tagNames.length > 0 ? { tag_filter: { names: tagNames, match: tagMatch } } : {}),
    },
    timestamp: new Date().toISOString(),
  };

  const warnings: string[] = [];
  if (partialData) {
    warnings.push(
      "Topology data may be incomplete — the API returned partial results due to upstream errors."
    );
  }
  if (tagWarning) {
    warnings.push(tagWarning);
  }

  // Per R4 §3: compute how many tagged-entity IDs aren't present in the
  // active topology. Used both for the full-empty diagnostic below and for
  // a softer partial-ghost warning when the tree is non-empty (some tag
  // links resolve to real entities, some don't). Without this, a partially
  // dangling tag silently includes the real entries and hides the ghosts.
  let ghostTagCount = 0;
  if (taggedEntityIds && taggedEntityIds.size > 0) {
    const presentIds = new Set<string>();
    for (const site of sites) {
      presentIds.add(site.id);
      for (const building of site.buildings ?? []) {
        presentIds.add(building.id);
        for (const floor of building.floors ?? []) {
          presentIds.add(floor.id);
          for (const room of floor.rooms ?? []) presentIds.add(room.id);
          for (const zone of floor.zones ?? []) presentIds.add(zone.id);
          for (const hive of floor.hives ?? []) presentIds.add(hive.id);
          for (const sensor of floor.sensors ?? []) presentIds.add(sensor.id);
        }
      }
    }
    for (const id of taggedEntityIds) {
      if (!presentIds.has(id)) ghostTagCount++;
    }
  }

  // Per R3 §2: distinguish "asset_ids didn't resolve to anything in the
  // org" from "asset_ids and tag_names scope disjoint subtrees" — the
  // earlier blanket disjoint warning misdiagnosed typos in asset_ids.
  if (tree.length === 0 && assetIds.length > 0) {
    if (assetScopeEmpty) {
      warnings.push(
        "asset_ids matched no entities in the org — verify the IDs exist " +
          "(use butlr_search_assets if unsure)."
      );
    } else if (assetTagDisjoint) {
      warnings.push(
        "No tree node satisfies both asset_ids and tag_names — the two filters scope disjoint subtrees. " +
          "Try removing one filter or use butlr_list_tags { include_entities: true } to see where the tags live."
      );
    }
  } else if (
    tree.length === 0 &&
    assetIds.length === 0 &&
    taggedEntityIds &&
    taggedEntityIds.size > 0
  ) {
    // Per R3 §3.1 + R4 §2/§7: tag-only path can produce an empty tree when
    // the tag's associations point at entities that aren't present in the
    // active topology — typically deleted rooms/zones/floors whose tag link
    // survived. Tags only attach to rooms/zones/floors (not sensors/hives)
    // per the GraphQL schema, so device filters aren't a source of ghosts.
    // Without this branch the user gets `tree: []` with no diagnostic.
    warnings.push(
      `Tag matched ${taggedEntityIds.size} entit${taggedEntityIds.size === 1 ? "y" : "ies"} ` +
        "in tag associations, but none are present in the active topology — " +
        "they may have been deleted. " +
        "Use butlr_list_tags { include_entities: true } to inspect the raw associations."
    );
  } else if (taggedEntityIds && ghostTagCount > 0 && ghostTagCount < taggedEntityIds.size) {
    // Per R4 §3: softer warning for the partial-ghost case — some tag
    // associations resolved (so the tree isn't empty) but others point at
    // entities outside the active topology. The user gets the real subset
    // PLUS visibility into the dangling links instead of silent loss.
    warnings.push(
      `${ghostTagCount} of ${taggedEntityIds.size} tag associations point at ` +
        "entities outside the active topology (likely deleted) and were skipped. " +
        "Use butlr_list_tags { include_entities: true } to inspect the raw associations."
    );
  }
  if (warnings.length > 0) {
    response.warning = warnings.join(" ");
  }
  if (unknownTagNames.length > 0) {
    response.unknown_tags = unknownTagNames;
  }

  return response;
}

/**
 * Merge sensors and hives into topology structure
 * Groups by floor_id and nests under appropriate floors
 */
function mergeSensorsAndHivesIntoTopology(
  sites: Site[],
  allSensors: Sensor[],
  allHives: Hive[]
): Site[] {
  // Group sensors by floor_id
  const sensorsByFloor: Record<string, Sensor[]> = {};
  for (const sensor of allSensors) {
    const floorId = sensor.floor_id || sensor.floorID;
    if (floorId) {
      if (!sensorsByFloor[floorId]) {
        sensorsByFloor[floorId] = [];
      }
      sensorsByFloor[floorId].push(sensor);
    }
  }

  // Group hives by floor_id
  const hivesByFloor: Record<string, Hive[]> = {};
  for (const hive of allHives) {
    const floorId = hive.floor_id || hive.floorID;
    if (floorId) {
      if (!hivesByFloor[floorId]) {
        hivesByFloor[floorId] = [];
      }
      hivesByFloor[floorId].push(hive);
    }
  }

  // Merge into topology
  for (const site of sites) {
    for (const building of site.buildings || []) {
      for (const floor of building.floors || []) {
        // Add sensors and hives to this floor
        floor.sensors = sensorsByFloor[floor.id] || [];
        floor.hives = hivesByFloor[floor.id] || [];
      }
    }
  }

  return sites;
}

/**
 * Filter topology to only include assets matching the provided IDs.
 *
 * Pruning is strict at every level so untargeted siblings do not leak
 * through (a regression vector for `asset_ids` ∩ `tag_names` composition,
 * where `expandToSubtreeClosure` precomputes a leaf-level intersection):
 *   - If a site/building/floor id is itself in `assetIds`, the whole
 *     subtree is preserved (caller asked for that branch as a whole).
 *   - Otherwise the floor is shallow-cloned with each child collection
 *     filtered to ids in `assetIds`.
 *
 * Rendering ancestors are pulled back in after pruning so the tree
 * formatter can place each matched leaf at its expected position. Without
 * this, a matched zone/sensor whose parent room wasn't itself targeted
 * would silently fall out of the tree (the formatter renders zones and
 * room-bound sensors under their parent room, and hive-bound sensors
 * under their hive — none of which appear if the parent isn't present).
 * The added ancestors are always parents of an already-matched node, so
 * sibling leakage cannot occur.
 */
function filterTopologyByAssets(sites: Site[], assetIds: string[]): Site[] {
  const idSet = new Set(assetIds);
  const filtered: Site[] = [];

  for (const site of sites) {
    if (idSet.has(site.id)) {
      filtered.push(site);
      continue;
    }

    const matchedBuildings: Building[] = [];
    for (const building of site.buildings || []) {
      if (idSet.has(building.id)) {
        matchedBuildings.push(building);
        continue;
      }

      const matchedFloors: Floor[] = [];
      for (const floor of building.floors || []) {
        if (idSet.has(floor.id)) {
          matchedFloors.push(floor);
          continue;
        }

        const prunedFloor = pruneFloorToMatches(floor, idSet);
        if (prunedFloor) matchedFloors.push(prunedFloor);
      }

      if (matchedFloors.length > 0) {
        matchedBuildings.push({ ...building, floors: matchedFloors });
      }
    }

    if (matchedBuildings.length > 0) {
      filtered.push({ ...site, buildings: matchedBuildings });
    }
  }

  return filtered;
}

/**
 * Build a shallow-cloned floor containing only matched leaves and their
 * rendering ancestors. Returns `undefined` when nothing on the floor matched.
 */
function pruneFloorToMatches(floor: Floor, idSet: Set<string>): Floor | undefined {
  const matchedRooms: Room[] = (floor.rooms ?? []).filter((r) => idSet.has(r.id));
  const matchedZones: Zone[] = (floor.zones ?? []).filter((z) => idSet.has(z.id));
  const matchedHives: Hive[] = (floor.hives ?? []).filter((h) => idSet.has(h.id));
  const matchedSensors: Sensor[] = (floor.sensors ?? []).filter((s) => idSet.has(s.id));

  if (
    matchedRooms.length === 0 &&
    matchedZones.length === 0 &&
    matchedHives.length === 0 &&
    matchedSensors.length === 0
  ) {
    return undefined;
  }

  const ancestorRoomIds = new Set<string>();
  const collectRoomAncestor = (entity: { roomID?: string; room_id?: string }) => {
    const roomId = entity.roomID ?? entity.room_id;
    if (roomId) ancestorRoomIds.add(roomId);
  };
  matchedZones.forEach(collectRoomAncestor);
  matchedHives.forEach(collectRoomAncestor);
  matchedSensors.forEach(collectRoomAncestor);

  const matchedHiveIds = new Set(matchedHives.map((h) => h.id));
  const ancestorHiveSerials = new Set<string>();
  for (const sensor of matchedSensors) {
    if (sensor.hive_serial) ancestorHiveSerials.add(sensor.hive_serial);
  }
  const ancestorHives: Hive[] = [];
  for (const hive of floor.hives ?? []) {
    if (matchedHiveIds.has(hive.id)) continue;
    if (hive.serialNumber && ancestorHiveSerials.has(hive.serialNumber)) {
      ancestorHives.push(hive);
      collectRoomAncestor(hive);
    }
  }

  const matchedRoomIds = new Set(matchedRooms.map((r) => r.id));
  const ancestorRooms: Room[] = [];
  for (const room of floor.rooms ?? []) {
    if (matchedRoomIds.has(room.id)) continue;
    if (ancestorRoomIds.has(room.id)) ancestorRooms.push(room);
  }

  return {
    ...floor,
    rooms: [...matchedRooms, ...ancestorRooms],
    zones: matchedZones,
    hives: [...matchedHives, ...ancestorHives],
    sensors: matchedSensors,
  };
}

/**
 * Register butlr_list_topology with an McpServer instance
 */
export function registerListTopology(server: McpServer): void {
  server.registerTool(
    "butlr_list_topology",
    {
      title: "List Topology",
      description: LIST_TOPOLOGY_DESCRIPTION,
      inputSchema: listTopologyInputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    withToolErrorHandling(async (args) => {
      const validated = ListTopologyArgsSchema.parse(args);
      const result = await executeListTopology(validated);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    })
  );
}
