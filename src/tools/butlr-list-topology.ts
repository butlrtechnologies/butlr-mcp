import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apolloClient } from "../clients/graphql-client.js";
import { GET_FULL_TOPOLOGY, GET_ALL_SENSORS, GET_ALL_HIVES } from "../clients/queries/topology.js";
import {
  GET_TAGS_WITH_USAGE,
  asTagName,
  type RawTagWithUsage,
  type TagMatch,
  type TagName,
} from "../clients/queries/tags.js";
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
import { resolveTagNames, projectValidRefs } from "../utils/tag-resolver.js";
import { debug } from "../utils/debug.js";
import { withToolErrorHandling, throwInternalError } from "../errors/mcp-errors.js";
import type { ListTopologyResponse, TopologyDiagnostic } from "../types/responses.js";

const LIST_TOPOLOGY_DESCRIPTION =
  "Display org hierarchy tree with flexible depth control. Can show full tree, specific subtrees, or flat lists. " +
  "Supports filtering by parent asset IDs and by tag names. Depth levels: 0=sites, 1=buildings, 2=floors, 3=rooms/zones, 4=hives, 5=sensors. " +
  "Use starting_depth to choose which level to show, and traversal_depth to control how many levels below to include.\n\n" +
  "Tag filter:\n" +
  "- Pass tag_names (case-insensitive) to scope the tree to subtrees containing rooms, zones, or floors with those tags. Combines AND-style with asset_ids when both are supplied.\n" +
  "- tag_match defaults to 'any' (entity is in any tagged subtree). 'all' intersects per-tag SUBTREES — e.g. a tag on Floor 1 AND a tag on a room inside Floor 1 yields the room (it's in both subtrees), not the empty set. Note this 'any' default differs from butlr_available_rooms, which defaults to 'all' because it filters a single entity type.\n" +
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
    .array(z.string().trim().min(1, "asset_ids entries cannot be empty"))
    .optional()
    .describe(
      "Optional: Parent asset IDs to show tree for. If empty, shows all sites. " +
        "Examples: ['site_123'], ['building_456'], ['floor_789']"
    ),

  starting_depth: z
    .number()
    .int("starting_depth must be an integer")
    .min(0, "starting_depth must be >= 0 (0=sites)")
    .max(5, "starting_depth must be <= 5 (5=sensors)")
    .default(0)
    .describe(
      "Depth level to start showing assets. 0=sites, 1=buildings, 2=floors, 3=rooms/zones, 4=hives, 5=sensors. " +
        "Use with traversal_depth=0 to show only assets at this level (flat list)."
    ),

  traversal_depth: z
    .number()
    .int("traversal_depth must be an integer")
    .min(0, "traversal_depth must be >= 0")
    .max(10, "traversal_depth must be <= 10")
    .default(0)
    .describe(
      "How many levels below starting_depth to traverse. 0=starting level only, 1=one level below, etc. " +
        "Default is 0 to minimize token usage. Use 10 for full tree."
    ),

  tag_names: z
    .array(z.string().trim().min(1, "Tag cannot be empty"))
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
      "Multi-tag semantics when tag_names has more than one entry: 'any' (default) keeps entities whose subtree is covered by at least one of the named tags. 'all' keeps entities whose subtree is covered by EVERY named tag — e.g. a floor-tag combined with a room-tag on a room inside that floor yields the room (it's in both subtrees), not the empty intersection. Defaults to 'any' here, unlike butlr_available_rooms which defaults to 'all' because it filters a single entity type."
    ),
};

export const ListTopologyArgsSchema = z.object(listTopologyInputShape).strict();

type ListTopologyArgs = z.output<typeof ListTopologyArgsSchema>;

/**
 * Union of every directly-tagged entity ID across the resolved tag rows,
 * regardless of `match`. Used for:
 *   1. Early "tag_no_associations" empty check (before topology fetch)
 *   2. Ghost-association detection (count of direct IDs absent from topology)
 *
 * `match`-aware filtering — including the closure-of-each-tag intersection
 * needed for `match='all'` across hierarchically-related tags (e.g. a tag
 * on a floor and a tag on a room inside that floor) — happens later in
 * `collectMatchAwareClosure`, which requires the topology to already be
 * fetched.
 */
function collectDirectTaggedIds(resolvedRows: RawTagWithUsage[]): Set<string> {
  const matched = new Set<string>();
  // `projectValidRefs` drops refs whose `id` is null/undefined (stale
  // tag→entity associations after a hard delete, or partial GraphQL
  // responses) so they can't pollute the matched-id Set. Sharing the
  // helper with `butlr_list_tags` keeps the validity predicate in one
  // place — counts and entity arrays produced from the same filtered
  // list cannot disagree across tools.
  for (const row of resolvedRows) {
    for (const r of projectValidRefs(row.rooms)) matched.add(r.id);
    for (const z of projectValidRefs(row.zones)) matched.add(z.id);
    for (const f of projectValidRefs(row.floors)) matched.add(f.id);
  }
  return matched;
}

/**
 * Compute the match-aware closure of the resolved tag rows
 * against the active topology. Each tag's directly-tagged entity IDs are
 * expanded to their full subtree closure (rooms→sensors-via-room_id,
 * floors→all descendants, etc.) BEFORE applying the match operator. This
 * makes `tag_match='all'` work across hierarchical levels — a tag on
 * Floor 1 and a tag on Room A inside Floor 1 now intersect to
 * {Room A + its descendants}, not the empty set the per-type literal
 * intersection used to produce.
 *
 * Why split from `collectDirectTaggedIds`: the direct IDs are needed
 * before the topology is fetched (to short-circuit on no-associations
 * and to drive ghost detection); the closure-aware set requires sites.
 * Splitting also keeps the ghost-count stable — closure entities are
 * by construction in the topology walk, so basing ghosts on closure
 * would always report zero.
 */
function collectMatchAwareClosure(
  sites: Site[],
  resolvedRows: RawTagWithUsage[],
  match: TagMatch
): Set<string> {
  if (resolvedRows.length === 0) return new Set();

  const perTagClosures = resolvedRows.map((row) => {
    const rootIds: string[] = [];
    for (const r of projectValidRefs(row.rooms)) rootIds.push(r.id);
    for (const z of projectValidRefs(row.zones)) rootIds.push(z.id);
    for (const f of projectValidRefs(row.floors)) rootIds.push(f.id);
    return expandToSubtreeClosure(sites, rootIds);
  });

  if (match === "all") {
    // Build a fresh Set per fold step rather than mutating `acc` mid-
    // iteration. JS allows Set.delete during iteration and the previous
    // implementation was correct, but the immutable form is more obvious
    // to a future reader and removes a fragile language-spec dependency.
    let acc = new Set(perTagClosures[0]);
    for (let i = 1; i < perTagClosures.length; i++) {
      const next = perTagClosures[i];
      const intersected = new Set<string>();
      for (const id of acc) if (next.has(id)) intersected.add(id);
      acc = intersected;
    }
    return acc;
  }
  const acc = new Set<string>();
  for (const c of perTagClosures) for (const id of c) acc.add(id);
  return acc;
}

/**
 * Walk the topology and collect every entity ID that is descendant of (or
 * equal to) the supplied `rootIds`. Used to compose `asset_ids` with
 * `tag_names` as a true subtree-overlap AND.
 *
 * The closure is applied to BOTH asset_ids AND tagged-entity IDs because a
 * tag can sit on an ancestor of an asset (e.g. tag on Floor 1,
 * `asset_ids=[room_001]`) — the room is then inside the tagged subtree even
 * though their raw IDs don't intersect. A literal-id intersection would
 * silently miss this overlap; closure-vs-closure intersection catches it.
 *
 * Coverage by entity type:
 *   site      → site + every building/floor/room/zone/hive/sensor under it
 *   building  → building + every floor/room/zone/hive/sensor under it
 *   floor     → floor + its rooms, zones, hives, sensors
 *   room      → room + room_id-bound zones, sensors, hives — and
 *               transitively, every sensor whose `hive_serial` matches a
 *               room-bound hive's `serialNumber` (devices live in floor
 *               arrays but logically belong to their room when bound)
 *   zone      → zone alone (zones are leaves under rooms in the
 *                topology and don't own descendants in our schema)
 *   hive      → hive + sensors with matching `hive_serial`
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
        // either shape (mirrors `formatRoom` in src/utils/tree-formatter.ts).
        for (const room of floor.rooms ?? []) {
          if (!target.has(room.id)) continue;
          closure.add(room.id);
          for (const zone of floor.zones ?? []) {
            if ((zone.room_id ?? zone.roomID) === room.id) closure.add(zone.id);
          }
          for (const sensor of floor.sensors ?? []) {
            if ((sensor.room_id ?? sensor.roomID) === room.id) closure.add(sensor.id);
          }
          // Sensors reach a room two ways: directly via room_id, or
          // transitively through a room-bound hive (sensor.hive_serial ===
          // hive.serialNumber). The formatter renders both shapes under the
          // room (`formatHive`'s `hiveSensors` filter nests sensors under
          // hives by `hive_serial`, and a hive nests under its room by
          // `room_id`), so the closure must follow the same chain.
          // Otherwise a sensor with no direct room link but attached to a
          // room-bound hive falls out of the room's tag closure entirely.
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
          // Defensive symmetry with the room→hive→sensor chain above.
          // Tags can't currently attach to sensors per the GraphQL schema,
          // so this branch has no observable effect on current data — but
          // it closes the symmetric-closure invariant claimed in the
          // doc-block and matches what `formatHive` renders under a hive.
          // Do NOT delete thinking it's vestigial.
          //
          // If the GraphQL schema later supports sensor-level tags, drop
          // the "no observable effect" phrasing — the branch becomes
          // load-bearing and a regression here would silently miss
          // sensor-targeted tag composition.
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
export async function executeListTopology(args: ListTopologyArgs): Promise<ListTopologyResponse> {
  const startingDepth = args.starting_depth ?? 0;
  const traversalDepth = args.traversal_depth ?? 0;
  const assetIds = args.asset_ids ?? [];
  // Brand the input tag names at the boundary so the response surface
  // keeps the `TagName` brand. Zod gives us plain strings; downstream
  // consumers benefit from the brand surviving onto `tag_filter.names`,
  // `unknown_tags`, and the diagnostic union.
  const tagNames: TagName[] = (args.tag_names ?? []).map((n) => asTagName(n));
  // Default is "any" here, in contrast to butlr_available_rooms which
  // defaults to "all". The asymmetry is intentional — list-topology
  // filters across rooms/zones/floors where intersection is rarely
  // satisfied; available-rooms filters a single entity type. Do not
  // unify these defaults via a shared helper.
  const tagMatch = args.tag_match ?? "any";

  debug(
    "butlr-list-topology",
    `Fetching topology: starting_depth=${startingDepth}, traversal_depth=${traversalDepth}, assets=${assetIds.length || "all"}, tags=${tagNames.length ? `${tagMatch}:${tagNames.join(",")}` : "none"}`
  );

  // Resolve tag filter (if any) up-front so we can short-circuit on
  // unsatisfiable / no-match cases without paying for the topology fetch.
  let taggedEntityIds: Set<string> | undefined;
  // Carry resolvedRows through to the composition phase so collectMatchAwareClosure
  // can expand each tag's subtree before applying the match operator (per R7 §I1).
  // The previous flow computed a literal per-type intersection up-front, which
  // missed hierarchically-related tag pairs.
  let resolvedTagRows: RawTagWithUsage[] | undefined;
  // Defaults to [] for the no-tag-filter path; only the live tag-resolution
  // branch reads from `resolution.unknownNames` (passed directly into
  // buildTopologyResponse on early-return) so we don't keep an alias here.
  // Typed as `TagName[]` to preserve the brand from the resolver through
  // to the response surface. `ListTopologyResponse.unknown_tags` declares
  // ReadonlyArray<string> so the brand erodes at the boundary today (a
  // separate type-design item), but at least the in-flight binding doesn't
  // launder it any earlier than necessary.
  let unknownTagNames: TagName[] = [];
  let tagWarning: TopologyDiagnostic | undefined;
  let malformedTagRowCount = 0;

  if (tagNames.length > 0) {
    let tagsRaw: RawTagWithUsage[] = [];
    try {
      const tagsResult = await apolloClient.query<{ tags: RawTagWithUsage[] | null }>({
        query: GET_TAGS_WITH_USAGE,
        fetchPolicy: "network-only",
      });
      throwIfGraphQLErrors(tagsResult);
      // Same null-is-violation rule as butlr-list-tags — see comment there.
      const tags = tagsResult.data?.tags;
      if (!Array.isArray(tags)) {
        throwInternalError(
          "Unexpected response shape from tags query (expected array, got " +
            `${tags === null ? "null" : typeof tags}). Please retry; if persistent, the upstream API contract may have changed.`
        );
      }
      tagsRaw = tags;
    } catch (error: unknown) {
      rethrowIfGraphQLError(error);
      throw error;
    }

    const resolution = resolveTagNames({
      allTags: tagsRaw,
      requestedNames: tagNames,
      match: tagMatch,
    });

    const baseQueryParams = {
      starting_depth: startingDepth,
      traversal_depth: traversalDepth,
      asset_filter: assetIds.length > 0 ? assetIds : ("all" as const),
      tag_filter: { names: tagNames, match: tagMatch },
    };

    // Surface upstream contract violations (rows missing a usable id/name)
    // alongside whichever primary diagnostic fires. Threading it through a
    // shared starting list ensures it cannot be silently dropped on any
    // early-return branch.
    const earlyDiagnostics: TopologyDiagnostic[] = [];
    if (resolution.droppedRowCount > 0) {
      earlyDiagnostics.push({
        kind: "malformed_tag_rows",
        count: resolution.droppedRowCount,
      });
    }
    malformedTagRowCount = resolution.droppedRowCount;

    if (resolution.kind === "no_match") {
      const diagnostics: TopologyDiagnostic[] = [
        { kind: "tag_no_match", unknown_names: resolution.unknownNames },
      ];
      // When asset_ids was also supplied, opportunistically validate it
      // against a warm topology cache so the user sees both diagnostics in
      // one round-trip. The lookup reads only from the merged-devices cache
      // (the key `butlr_list_topology` writes) so it is authoritative for
      // device ids; `butlr_search_assets` writes a separate device-incomplete
      // shape under a different key. Cache miss → emit `asset_ids_unverified`
      // so the caller knows the asset typo (if any) wasn't checked. Paying
      // for a full topology fetch here would dwarf the actual short-circuit.
      //
      // Skip the probe entirely when BUTLR_ORG_ID is unset: the cache key
      // would fall back to "default", which is shared across every org a
      // multi-tenant process talks to. Reading authoritative asset-scope
      // diagnostics against a tree from a different org would emit
      // `asset_scope_empty` for IDs that exist in the caller's actual org.
      if (assetIds.length > 0) {
        const orgId = process.env.BUTLR_ORG_ID;
        if (!orgId) {
          diagnostics.push({ kind: "asset_ids_unverified" });
        } else {
          const cached = getCachedTopology(
            generateTopologyCacheKey(orgId, true, true, true, undefined)
          );
          const cachedSites = cached?.data?.sites as Site[] | undefined;
          if (cachedSites) {
            if (expandToSubtreeClosure(cachedSites, assetIds).size === 0) {
              diagnostics.push({ kind: "asset_scope_empty", asset_ids: assetIds });
            }
          } else {
            diagnostics.push({ kind: "asset_ids_unverified" });
          }
        }
      }
      diagnostics.push(...earlyDiagnostics);
      return buildTopologyResponse({
        tree: [],
        queryParams: baseQueryParams,
        diagnostics,
        unknownTagNames: resolution.unknownNames,
      });
    }

    if (resolution.kind === "unsatisfiable") {
      return buildTopologyResponse({
        tree: [],
        queryParams: baseQueryParams,
        diagnostics: [
          {
            kind: "tag_match_all_unsatisfiable",
            unknown_names: resolution.unknownNames,
            partial_resolved_count: resolution.partialResolvedCount,
          },
          ...earlyDiagnostics,
        ],
        unknownTagNames: resolution.unknownNames,
      });
    }

    // resolution.kind === "ok" — safe to read resolvedRows / resolvedIds.
    const { resolvedRows, unknownNames } = resolution;
    unknownTagNames = unknownNames;
    resolvedTagRows = resolvedRows;

    taggedEntityIds = collectDirectTaggedIds(resolvedRows);

    if (taggedEntityIds.size === 0) {
      return buildTopologyResponse({
        tree: [],
        queryParams: baseQueryParams,
        diagnostics: [
          { kind: "tag_no_associations", tag_match: tagMatch, tag_names: tagNames },
          ...earlyDiagnostics,
        ],
        unknownTagNames: unknownNames,
      });
    }

    if (unknownNames.length > 0) {
      tagWarning = { kind: "unknown_tags", names: unknownNames };
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

      // Apollo can return both data and errors - only fail if we have no
      // data. Route the error through `throwIfGraphQLErrors` so it lands
      // as a translated MCP error (AUTH_EXPIRED, RATE_LIMITED, etc.)
      // rather than as a raw `result.error` shape that downstream
      // duck-typing might or might not recognise.
      if (!result.data || !result.data.sites || !result.data.sites.data) {
        throwIfGraphQLErrors(result);
        throwInternalError("Invalid response structure from API (missing data.sites.data)");
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

      throwIfGraphQLErrors(sensorsResult);
      throwIfGraphQLErrors(hivesResult);

      // Mirror the tags-fetch shape contract: only an explicit array survives;
      // `null` / `undefined` / non-array shapes throw as upstream contract
      // violations. `|| []` here would silently launder a serialisation
      // regression into an empty-devices topology.
      const rawSensors = sensorsResult.data?.sensors?.data;
      if (!Array.isArray(rawSensors)) {
        throwInternalError(
          "Unexpected response shape from sensors query (expected array, got " +
            `${rawSensors === null ? "null" : typeof rawSensors}). Please retry; if persistent, the upstream API contract may have changed.`
        );
      }
      const rawHives = hivesResult.data?.hives?.data;
      if (!Array.isArray(rawHives)) {
        throwInternalError(
          "Unexpected response shape from hives query (expected array, got " +
            `${rawHives === null ? "null" : typeof rawHives}). Please retry; if persistent, the upstream API contract may have changed.`
        );
      }

      // Filter out test/placeholder devices from topology listing
      // (Note: These filters are ONLY for topology display, not occupancy queries)
      const allSensors = rawSensors.filter(isProductionSensor);
      const allHives = rawHives.filter(isProductionHive);

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

  // Compose asset_ids and tag_names as a true AND via subtree-overlap
  // intersection. Both sides are expanded to their full descendant closure
  // (including sensors/hives, plus devices bound to a targeted room via
  // room_id). The two surviving closures are intersected — this catches
  // the case where a tag sits on an ancestor of an asset (e.g. tag on a
  // floor, `asset_ids=[room_001]` within that floor) which a raw-ID
  // intersection would miss.
  //
  // `assetScopeEmpty` and `assetTagDisjoint` are tracked separately so
  // the empty-tree warning can distinguish "asset_ids didn't resolve in
  // this org" from "filters scope disjoint subtrees" — the former is a
  // typo, the latter is a legitimate disagreement.
  let filterIds: string[] | undefined;
  let assetScopeEmpty = false;
  let assetTagDisjoint = false;

  // Both single-filter paths use the closure too — `pruneFloorToMatches`
  // strict-prunes by raw IDs, so passing only `room_001` would return the
  // room with empty zones/hives/sensors. Closure-expand to include the
  // descendants the formatter would render (zones bound to the room,
  // sensors via room_id, sensors via the hive_serial chain, etc.).
  //
  // Tag-side closure uses `collectMatchAwareClosure` — for tag_match='all'
  // it intersects per-tag subtree closures (R7 §I1), which makes
  // hierarchical AND work correctly. For 'any' it unions them.
  if (assetIds.length > 0) {
    const assetClosure = expandToSubtreeClosure(sites, assetIds);
    assetScopeEmpty = assetClosure.size === 0;

    if (resolvedTagRows && resolvedTagRows.length > 0) {
      const tagClosure = collectMatchAwareClosure(sites, resolvedTagRows, tagMatch);
      const intersection: string[] = [];
      for (const id of assetClosure) if (tagClosure.has(id)) intersection.push(id);
      if (!assetScopeEmpty && intersection.length === 0) {
        assetTagDisjoint = true;
      }
      filterIds = intersection;
    } else {
      filterIds = [...assetClosure];
    }
  } else if (resolvedTagRows && resolvedTagRows.length > 0) {
    filterIds = [...collectMatchAwareClosure(sites, resolvedTagRows, tagMatch)];
  }

  let filteredSites = sites;
  if (filterIds !== undefined) {
    filteredSites = filterTopologyByAssets(filteredSites, filterIds);
  }

  // Format as tree with depth controls
  const tree = formatTopologyTree(filteredSites, startingDepth, traversalDepth);

  const diagnostics: TopologyDiagnostic[] = [];
  if (partialData) diagnostics.push({ kind: "partial_topology" });
  if (tagWarning) diagnostics.push(tagWarning);
  if (malformedTagRowCount > 0) {
    diagnostics.push({ kind: "malformed_tag_rows", count: malformedTagRowCount });
  }

  // Compute how many tagged-entity IDs aren't present in the active
  // topology. Used both for the all-ghost diagnostic (tree empty, every
  // association dangling) and for the partial-ghost diagnostic (tree
  // non-empty, some associations dangling). Without this a partially
  // dangling tag silently includes the real entries and hides the ghosts.
  let ghostTagCount = 0;
  if (taggedEntityIds && taggedEntityIds.size > 0) {
    const presentIds = collectAllTopologyIds(sites);
    for (const id of taggedEntityIds) {
      if (!presentIds.has(id)) ghostTagCount++;
    }
  }

  // Tag-side ghost diagnostic — evaluated independently of the asset-side
  // branch so a dual-cause empty tree (bad asset_ids AND ghost tag) doesn't
  // mask the underlying ghost-association problem behind a misleading
  // "disjoint subtrees" warning.
  //
  // Gate emission on `!partialData`: when the topology fetch returned
  // partial results, `presentIds` is built off a truncated tree, so an
  // entity could appear "ghost" purely because its enclosing site/floor
  // was missing from this response. Surfacing tag_associations_*_ghost
  // in that state would be a false positive — the partial_topology
  // diagnostic already alerts the caller that the data is incomplete.
  // Hoist into a single narrowed binding so neither the gate nor the
  // emission needs `!` non-null assertions. TS narrows `taggedSize`
  // structurally — a future refactor that drops the early return on
  // `taggedEntityIds.size === 0` cannot accidentally re-introduce the
  // unsound `!.size` reads.
  const taggedSize = taggedEntityIds?.size ?? 0;
  const ghostKind: "all" | "partial" | "none" =
    taggedSize > 0
      ? ghostTagCount === taggedSize
        ? "all"
        : ghostTagCount > 0
          ? "partial"
          : "none"
      : "none";
  if (!partialData) {
    if (ghostKind === "all") {
      diagnostics.push({
        kind: "tag_associations_all_ghost",
        total: taggedSize,
      });
    } else if (ghostKind === "partial") {
      diagnostics.push({
        kind: "tag_associations_partial_ghost",
        ghost: ghostTagCount,
        total: taggedSize,
      });
    }
  }

  // Asset-side diagnostics — `asset_scope_empty` and `asset_tag_disjoint`
  // are mutually exclusive within `assetIds.length>0`.
  //
  // `asset_scope_empty` is an INDEPENDENT root cause: a typo'd asset_id
  // is still wrong even if the tag is also dangling. Surface both so the
  // user can fix them in one round-trip.
  //
  // `asset_tag_disjoint` IS a downstream symptom of an all-ghost tag —
  // the disjointness only exists because the tag's closure has nothing
  // to intersect with. Suppress it under all-ghost so the user gets the
  // actionable root cause ("your tag is dangling"), not the symptom.
  //
  // Suppress disjoint also under `partialData`: the disjointness was
  // computed against a truncated topology, so it's a false signal — the
  // tag's subtree might exist outside this partial fetch. The
  // `partial_topology` diagnostic already alerts the caller that the
  // data is incomplete; routing them to "remove a filter" would be
  // misdirection.
  const allGhostEmitted = !partialData && ghostKind === "all";
  if (tree.length === 0 && assetIds.length > 0) {
    if (assetScopeEmpty) {
      diagnostics.push({ kind: "asset_scope_empty", asset_ids: assetIds });
    } else if (assetTagDisjoint && !allGhostEmitted && !partialData) {
      diagnostics.push({ kind: "asset_tag_disjoint" });
    }
  }

  // Tag-match='all' no-overlap diagnostic: every requested tag resolved
  // and each has associations, but the per-tag SUBTREE intersection is
  // empty (e.g. tag A on Room X, tag B on Room Y in different floors).
  // Without this branch the user gets `tree: []` and no diagnostic when
  // no asset_ids filter is in play. Gate on the absence of higher-
  // priority diagnostics so we don't double-report.
  if (
    tagMatch === "all" &&
    resolvedTagRows &&
    resolvedTagRows.length > 1 &&
    filterIds !== undefined &&
    filterIds.length === 0 &&
    !partialData &&
    !allGhostEmitted &&
    diagnostics.length === 0
  ) {
    diagnostics.push({
      kind: "tag_match_all_no_overlap",
      resolved_names: resolvedTagRows.map((r) => asTagName(r.name)),
    });
  }

  // Depth-slicing diagnostic: filter resolved to entities (filterIds and
  // filteredSites both non-empty) but the formatter's depth window
  // sliced them out. Without this branch the user gets `tree: []` and no
  // signal — a real correctness gap pointed out by the silent-failure
  // review. Gate on the absence of the higher-priority diagnostics so
  // we don't double-report.
  const haveOtherEmptyTreeDiagnostic = diagnostics.some(
    (d) =>
      d.kind === "asset_scope_empty" ||
      d.kind === "asset_tag_disjoint" ||
      d.kind === "tag_associations_all_ghost" ||
      d.kind === "tag_no_associations" ||
      d.kind === "tag_no_match" ||
      d.kind === "tag_match_all_unsatisfiable" ||
      d.kind === "tag_match_all_no_overlap"
  );
  if (
    tree.length === 0 &&
    !haveOtherEmptyTreeDiagnostic &&
    !partialData &&
    filterIds !== undefined &&
    filterIds.length > 0 &&
    filteredSites.length > 0
  ) {
    diagnostics.push({
      kind: "depth_excludes_matches",
      starting_depth: startingDepth,
      traversal_depth: traversalDepth,
    });
  }

  return buildTopologyResponse({
    tree,
    queryParams: {
      starting_depth: startingDepth,
      traversal_depth: traversalDepth,
      asset_filter: assetIds.length > 0 ? assetIds : "all",
      ...(tagNames.length > 0 ? { tag_filter: { names: tagNames, match: tagMatch } } : {}),
    },
    diagnostics,
    unknownTagNames,
  });
}

/**
 * Collect every entity id present in the active topology so we can detect
 * tag associations pointing at deleted (or otherwise filtered-out) entities.
 */
function collectAllTopologyIds(sites: Site[]): Set<string> {
  const ids = new Set<string>();
  for (const site of sites) {
    ids.add(site.id);
    for (const building of site.buildings ?? []) {
      ids.add(building.id);
      for (const floor of building.floors ?? []) {
        ids.add(floor.id);
        for (const room of floor.rooms ?? []) ids.add(room.id);
        for (const zone of floor.zones ?? []) ids.add(zone.id);
        for (const hive of floor.hives ?? []) ids.add(hive.id);
        for (const sensor of floor.sensors ?? []) ids.add(sensor.id);
      }
    }
  }
  return ids;
}

/** Render a structured diagnostic as the human-readable prose used in `warning`. */
function renderDiagnostic(d: TopologyDiagnostic): string {
  switch (d.kind) {
    case "partial_topology":
      return "Topology data may be incomplete — the API returned partial results due to upstream errors.";
    case "tag_no_match":
      return (
        `No matching tags found in this org for: ${d.unknown_names.join(", ")}. ` +
        "Use butlr_list_tags to see available tag names."
      );
    case "unknown_tags":
      return (
        `Unknown tag(s) ignored: ${d.names.join(", ")}. ` +
        "Use butlr_list_tags to see available tag names."
      );
    case "tag_match_all_unsatisfiable":
      return (
        `Cannot satisfy tag_match='all': ${d.partial_resolved_count} tag(s) ` +
        `resolved but unknown tag(s) ${d.unknown_names.join(", ")} prevent the AND. ` +
        "Use butlr_list_tags to see available tag names, or pass tag_match='any' to match entities tagged with any of the supplied tags."
      );
    case "tag_no_associations": {
      // Single-tag case reads cleanly without the all/any preamble.
      const tagList =
        d.tag_names.length === 1
          ? `"${d.tag_names[0]}"`
          : `${d.tag_match === "all" ? "all of" : "any of"} [${d.tag_names.join(", ")}]`;
      return (
        `No rooms, zones, or floors are currently tagged with ${tagList}. ` +
        "Use butlr_list_tags { include_entities: true } to see what is tagged."
      );
    }
    case "asset_scope_empty":
      return (
        "asset_ids matched no entities in the org — verify the IDs exist " +
        "(use butlr_search_assets if unsure)."
      );
    case "asset_tag_disjoint":
      return (
        "No tree node satisfies both asset_ids and tag_names — the two filters scope disjoint subtrees. " +
        "Try removing one filter or use butlr_list_tags { include_entities: true } to see where the tags live."
      );
    case "tag_associations_all_ghost":
      return (
        `Tag matched ${d.total} entit${d.total === 1 ? "y" : "ies"} ` +
        "in tag associations, but none are present in the active topology — " +
        "they may have been deleted. " +
        "Use butlr_list_tags { include_entities: true } to inspect the raw associations."
      );
    case "tag_associations_partial_ghost":
      return (
        `${d.ghost} of ${d.total} tag associations point at ` +
        "entities outside the active topology (likely deleted) and were skipped. " +
        "Use butlr_list_tags { include_entities: true } to inspect the raw associations."
      );
    case "asset_ids_unverified":
      return (
        "asset_ids were not validated (topology not yet cached) — " +
        "re-run after correcting the tag names to confirm they exist."
      );
    case "malformed_tag_rows":
      return (
        `${d.count} tag row(s) skipped — upstream returned entries with ` +
        "missing or empty id/name fields. If unexpected, contact support."
      );
    case "depth_excludes_matches":
      return (
        "Filter matched entities, but every match sits outside the " +
        `current depth window (starting_depth=${d.starting_depth}, ` +
        `traversal_depth=${d.traversal_depth}). Lower starting_depth or ` +
        "raise traversal_depth to surface the matches."
      );
    case "tag_match_all_no_overlap":
      return (
        `tag_match='all' but the subtree intersection of ` +
        `[${d.resolved_names.join(", ")}] is empty — the tags apply to ` +
        "entities under different parents. Try tag_match='any', drop a " +
        "tag, or use butlr_list_tags { include_entities: true } to inspect " +
        "where each tag lives."
      );
    default: {
      // Exhaustiveness guard — adding a new TopologyDiagnostic arm without
      // a matching case here fails to compile because `assertNever` only
      // accepts `never`. At runtime we degrade gracefully with a fallback
      // string rather than throw, so version skew (e.g. an older bundle
      // reads a diagnostic kind written by a newer one over a shared
      // cache or transport) doesn't crash the response renderer.
      assertNever(d);
      const unknownKind = (d as { kind?: string }).kind ?? "unspecified";
      // Surface version-skew explicitly in logs so an operator notices
      // the drift without needing to spelunk the response shape.
      debug("topology-diagnostic-unknown-kind", unknownKind);
      return `Unknown diagnostic kind: ${unknownKind}`;
    }
  }
}

/**
 * Compile-time exhaustiveness assertion. The argument's type must be
 * `never`; if any caller's narrowing leaves an unhandled case, TS rejects
 * the call. Returns nothing so the surrounding switch can still fall
 * through to a runtime fallback (see `renderDiagnostic`).
 */
function assertNever(_value: never): void {
  /* compile-time guard only */
}

/**
 * Assemble the response, deriving the legacy `warning` string from the
 * structured diagnostics so the two stay in lock-step. Either field on its
 * own carries the full diagnostic surface; consumers can safely branch on
 * `warnings[].kind` and ignore `warning`.
 */
function buildTopologyResponse(args: {
  tree: ListTopologyResponse["tree"];
  queryParams: ListTopologyResponse["query_params"];
  diagnostics: TopologyDiagnostic[];
  unknownTagNames: ReadonlyArray<TagName>;
}): ListTopologyResponse {
  const response: ListTopologyResponse = {
    tree: args.tree,
    query_params: args.queryParams,
    timestamp: new Date().toISOString(),
  };
  if (args.diagnostics.length > 0) {
    response.warnings = args.diagnostics;
    response.warning = args.diagnostics.map(renderDiagnostic).join(" ");
  }
  if (args.unknownTagNames.length > 0) {
    response.unknown_tags = args.unknownTagNames;
  }
  return response;
}

/**
 * Merge sensors and hives into topology structure.
 * Groups by floor_id and nests under appropriate floors.
 *
 * IN-PLACE MUTATION: assigns `floor.sensors` and `floor.hives` directly on
 * the input site tree (returned for chaining; no new array is allocated).
 * `setCachedTopology` reads from the same `sites` reference that this
 * function mutates — any caller that captures the pre-merge `sites` (via
 * Apollo cache-restore, structural clone, or fork-then-await) would
 * observe the un-merged shape and could write a device-incomplete tree
 * to the cache. If you change this to immutable assignment, audit the
 * cache write site to confirm it sees the merged result.
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
