import { describe, it, expect, beforeEach, vi } from "vitest";
import { executeListTopology } from "../../butlr-list-topology.js";
import { apolloClient } from "../../../clients/graphql-client.js";
import {
  clearTopologyCache,
  generateTopologyCacheKey,
  setCachedTopology,
} from "../../../cache/topology-cache.js";

// Mock the GraphQL client
vi.mock("../../../clients/graphql-client.js", () => ({
  apolloClient: {
    query: vi.fn(),
  },
}));

/**
 * Build minimal topology fixture for tests.
 * One site with one building, two floors, each with rooms.
 */
function buildTopologyFixture() {
  return {
    sites: {
      data: [
        {
          id: "site_001",
          name: "HQ Campus",
          timezone: "America/New_York",
          org_id: "org_001",
          buildings: [
            {
              id: "building_001",
              name: "Main Tower",
              site_id: "site_001",
              floors: [
                {
                  id: "space_001",
                  name: "Floor 1",
                  building_id: "building_001",
                  rooms: [
                    { id: "room_001", name: "Conf A", floorID: "space_001" },
                    { id: "room_002", name: "Conf B", floorID: "space_001" },
                  ],
                  zones: [{ id: "zone_001", name: "Reception", floorID: "space_001" }],
                },
                {
                  id: "space_002",
                  name: "Floor 2",
                  building_id: "building_001",
                  rooms: [{ id: "room_003", name: "Board Room", floorID: "space_002" }],
                  zones: [],
                },
              ],
            },
          ],
        },
      ],
    },
  };
}

/**
 * Build sensors fixture with production and test devices.
 */
function buildSensorsFixture() {
  return {
    sensors: {
      data: [
        {
          id: "sensor_001",
          mac_address: "aa:bb:cc:dd:ee:01",
          mode: "presence",
          floor_id: "space_001",
          room_id: "room_001",
          hive_serial: "HIVE001",
          is_online: true,
          is_entrance: false,
        },
        {
          // Test sensor (mirror) - should be filtered out
          id: "sensor_mirror",
          mac_address: "mi-rr-or-test-001",
          mode: "presence",
          floor_id: "space_001",
          room_id: "room_002",
          hive_serial: "HIVE001",
          is_online: true,
          is_entrance: false,
        },
      ],
    },
  };
}

/**
 * Build a tags fixture aligned with the topology fixture IDs.
 *  - "huddle"   → room_001 (Floor 1)
 *  - "focus"    → room_001 (Floor 1) + room_003 (Floor 2)
 *  - "broad"    → room_001 (Floor 1) + room_003 (Floor 2)
 *  - "executive"→ room_001 (Floor 1) + room_002 (Floor 1)
 *  - "video"    → zone_001 (Floor 1)
 *  - "unused"   → no associations
 *
 * "focus" ∩ "broad" ∩ "executive" subtracts step-by-step: 2-tag intersection
 * is {room_001, room_003}; adding "executive" prunes room_003 → {room_001}.
 * A fence-post in the fold loop (skipping the third tag) would leave
 * {room_001, room_003} and pull Floor 2 into the result — the 3-tag test
 * detects exactly that.
 */
function buildTagsFixture() {
  return {
    tags: [
      {
        __typename: "Tag",
        id: "tag_huddle",
        name: "huddle",
        organization_id: "org_001",
        rooms: [{ __typename: "Room", id: "room_001", name: "Conf A" }],
        zones: [],
        floors: [],
      },
      {
        __typename: "Tag",
        id: "tag_focus",
        name: "focus",
        organization_id: "org_001",
        rooms: [
          { __typename: "Room", id: "room_001", name: "Conf A" },
          { __typename: "Room", id: "room_003", name: "Board Room" },
        ],
        zones: [],
        floors: [],
      },
      {
        __typename: "Tag",
        id: "tag_broad",
        name: "broad",
        organization_id: "org_001",
        rooms: [
          { __typename: "Room", id: "room_001", name: "Conf A" },
          { __typename: "Room", id: "room_003", name: "Board Room" },
        ],
        zones: [],
        floors: [],
      },
      {
        __typename: "Tag",
        id: "tag_executive",
        name: "executive",
        organization_id: "org_001",
        rooms: [
          { __typename: "Room", id: "room_001", name: "Conf A" },
          { __typename: "Room", id: "room_002", name: "Conf B" },
        ],
        zones: [],
        floors: [],
      },
      {
        __typename: "Tag",
        id: "tag_video",
        name: "video",
        organization_id: "org_001",
        rooms: [],
        zones: [{ __typename: "Zone", id: "zone_001", name: "Reception" }],
        floors: [],
      },
      {
        __typename: "Tag",
        id: "tag_unused",
        name: "unused",
        organization_id: "org_001",
        rooms: [],
        zones: [],
        floors: [],
      },
    ],
  };
}

function buildHivesFixture() {
  return {
    hives: {
      data: [
        {
          id: "hive_001",
          serialNumber: "HIVE001",
          floor_id: "space_001",
          isOnline: true,
          installed: true,
        },
      ],
    },
  };
}

/**
 * Set up all 3 sequential query mocks: topology, sensors, hives.
 */
function setupFullTopologyMocks(topologyData?: any, sensorsData?: any, hivesData?: any) {
  const topo = topologyData ?? buildTopologyFixture();
  const sensors = sensorsData ?? buildSensorsFixture();
  const hives = hivesData ?? buildHivesFixture();

  vi.mocked(apolloClient.query)
    .mockResolvedValueOnce({
      data: topo,
      loading: false,
      networkStatus: 7,
    } as any) // GET_FULL_TOPOLOGY
    .mockResolvedValueOnce({
      data: sensors,
      loading: false,
      networkStatus: 7,
    } as any) // GET_ALL_SENSORS
    .mockResolvedValueOnce({
      data: hives,
      loading: false,
      networkStatus: 7,
    } as any); // GET_ALL_HIVES
}

/**
 * Set up mocks for a tag-filtered call: tags fetched FIRST (used to short-circuit
 * before topology fetch), then topology / sensors / hives in the usual order.
 */
function setupTagFilteredMocks(
  tagsData?: any,
  topologyData?: any,
  sensorsData?: any,
  hivesData?: any
) {
  const tags = tagsData ?? buildTagsFixture();
  vi.mocked(apolloClient.query).mockResolvedValueOnce({
    data: tags,
    loading: false,
    networkStatus: 7,
  } as any); // GET_TAGS_WITH_USAGE
  setupFullTopologyMocks(topologyData, sensorsData, hivesData);
}

/**
 * Set up mocks for a tag-filter call that short-circuits before fetching
 * topology. Queues only the tags fetch — `beforeEach` uses `mockReset()`
 * (which DOES drain the once-queue), so leftover mocks would not cross
 * tests, but queuing only what we consume keeps the test self-documenting:
 * if the production short-circuit moves below the topology fetch later,
 * we want it to fail loudly here instead of silently pulling a stale mock.
 */
function setupTagsOnlyMock(tagsData?: any) {
  const tags = tagsData ?? buildTagsFixture();
  vi.mocked(apolloClient.query).mockResolvedValueOnce({
    data: tags,
    loading: false,
    networkStatus: 7,
  } as any);
}

/** Recursively collect every node id from a tree response. */
function flattenIds(nodes: any[]): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    ids.push(node[0]);
    if (node[2]) ids.push(...flattenIds(node[2]));
  }
  return ids;
}

describe("butlr_list_topology - Integration", () => {
  beforeEach(() => {
    // mockReset (not just clearAllMocks) is required to drain leftover
    // `mockResolvedValueOnce` entries between tests — clearAllMocks resets
    // call history but not the once-queue, which would otherwise leak from
    // a short-circuiting tag test into the next one.
    vi.mocked(apolloClient.query).mockReset();
    clearTopologyCache();
  });

  describe("Basic listing (depth 0, sites only)", () => {
    it("returns site-level tree nodes", async () => {
      setupFullTopologyMocks();

      const result = await executeListTopology({
        starting_depth: 0,
        traversal_depth: 0,
      });

      expect(result.tree).toHaveLength(1);
      // Each node is [id, name] or [id, name, children]
      expect(result.tree[0][0]).toBe("site_001");
      expect(result.tree[0][1]).toBe("HQ Campus");
      // traversal_depth=0 means no children
      expect(result.tree[0]).toHaveLength(2);
      expect(result.query_params).toEqual({
        starting_depth: 0,
        traversal_depth: 0,
        asset_filter: "all",
      });
      expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  });

  describe("Full tree traversal", () => {
    it("returns nested tree with sites > buildings > floors > rooms", async () => {
      setupFullTopologyMocks();

      const result = await executeListTopology({
        starting_depth: 0,
        traversal_depth: 10,
      });

      // Site should have children (buildings)
      const site = result.tree[0];
      expect(site[0]).toBe("site_001");
      expect(site).toHaveLength(3); // [id, name, children]

      const buildings = site[2] as any[];
      expect(buildings).toHaveLength(1);
      expect(buildings[0][0]).toBe("building_001");
      expect(buildings[0][1]).toBe("Main Tower");

      // Building should have floors
      const floors = buildings[0][2] as any[];
      expect(floors.length).toBeGreaterThanOrEqual(2);

      // Floor 1 should have rooms and zones
      const floor1 = floors.find((f: any) => f[0] === "space_001");
      expect(floor1).toBeDefined();
      expect(floor1).toHaveLength(3); // has children
      const floor1Children = floor1![2] as any[];
      // Should include rooms and zone
      const childIds = floor1Children.map((c: any) => c[0]);
      expect(childIds).toContain("room_001");
      expect(childIds).toContain("room_002");
      expect(childIds).toContain("zone_001");
    });
  });

  describe("Cache behavior", () => {
    it("uses cached topology on second call (no additional API calls)", async () => {
      setupFullTopologyMocks();

      // First call fetches fresh
      await executeListTopology({ starting_depth: 0, traversal_depth: 0 });
      expect(apolloClient.query).toHaveBeenCalledTimes(3); // topology + sensors + hives

      // Second call should use cache and not call API again
      const result2 = await executeListTopology({
        starting_depth: 0,
        traversal_depth: 0,
      });

      // Should still be 3 total calls (no new calls)
      expect(apolloClient.query).toHaveBeenCalledTimes(3);
      expect(result2.tree).toHaveLength(1);
      expect(result2.tree[0][0]).toBe("site_001");
    });
  });

  describe("Partial topology data", () => {
    it("adds warning and skips caching when API returns errors alongside data", async () => {
      const topo = buildTopologyFixture();

      // Simulate partial data: API returns data + error
      vi.mocked(apolloClient.query)
        .mockResolvedValueOnce({
          data: topo,
          error: new Error("Partial failure: some buildings unavailable"),
          loading: false,
          networkStatus: 7,
        } as any)
        .mockResolvedValueOnce({
          data: buildSensorsFixture(),
          loading: false,
          networkStatus: 7,
        } as any)
        .mockResolvedValueOnce({
          data: buildHivesFixture(),
          loading: false,
          networkStatus: 7,
        } as any);

      const result = await executeListTopology({
        starting_depth: 0,
        traversal_depth: 0,
      });

      expect(result.warning).toContain("incomplete");
      expect(result.tree).toHaveLength(1); // Data still present

      // Now make a second call - should NOT use cache (partial data is not cached)
      setupFullTopologyMocks();
      const result2 = await executeListTopology({
        starting_depth: 0,
        traversal_depth: 0,
      });

      // 6 total calls: 3 for first + 3 for second (cache was skipped)
      expect(apolloClient.query).toHaveBeenCalledTimes(6);
      expect(result2.warning).toBeUndefined();
    });
  });

  describe("Asset ID filtering", () => {
    it("filters topology to only include specified building", async () => {
      setupFullTopologyMocks();

      const result = await executeListTopology({
        asset_ids: ["building_001"],
        starting_depth: 0,
        traversal_depth: 10,
      });

      expect(result.query_params.asset_filter).toEqual(["building_001"]);
      // Should still show site as the wrapper since building is nested
      expect(result.tree).toHaveLength(1);
    });

    it("filters topology to specific room", async () => {
      setupFullTopologyMocks();

      const result = await executeListTopology({
        asset_ids: ["room_003"],
        starting_depth: 0,
        traversal_depth: 10,
      });

      expect(result.query_params.asset_filter).toEqual(["room_003"]);
      // The tree should only contain the path to room_003
      expect(result.tree).toHaveLength(1);
      const site = result.tree[0];
      const buildings = site[2] as any[];
      const floors = buildings[0][2] as any[];
      // Should only include Floor 2 (where room_003 lives)
      expect(floors).toHaveLength(1);
      expect(floors[0][0]).toBe("space_002");
    });

    it("returns empty tree with explanatory warning when asset_ids match nothing", async () => {
      setupFullTopologyMocks();

      const result = await executeListTopology({
        asset_ids: ["room_nonexistent"],
        starting_depth: 0,
        traversal_depth: 10,
      });

      expect(result.tree).toHaveLength(0);
      // the warning helps the LLM distinguish typo'd asset_ids
      // from a genuinely empty subtree.
      expect(result.warning).toMatch(/asset_ids matched no entities/i);
    });

    // C1 regression: single-filter asset_ids must closure-expand so descendants
    // (room-bound sensors, zones, hives, sensors-via-hive) survive
    // pruneFloorToMatches's strict-by-id filter. Pre-fix, asset_ids=["room_001"]
    // returned the room with empty zones/hives/sensors.
    it("asset_ids=[room] returns the room AND its room-bound descendants (closure expansion)", async () => {
      setupFullTopologyMocks();

      const result = await executeListTopology({
        asset_ids: ["room_001"], // sensor_001 has room_id=room_001 in the default fixture
        starting_depth: 0,
        traversal_depth: 10,
      });

      const ids = flattenIds(result.tree);
      expect(ids).toContain("room_001");
      // sensor_001.room_id === room_001 — must survive single-filter pruning.
      expect(ids).toContain("sensor_001");
    });
  });

  describe("Test device filtering", () => {
    it("excludes mirror/test sensors from topology", async () => {
      setupFullTopologyMocks();

      const result = await executeListTopology({
        starting_depth: 0,
        traversal_depth: 10,
      });

      // Traverse tree to find sensors — mirror sensor should be filtered
      const flattenIds = (nodes: any[]): string[] => {
        const ids: string[] = [];
        for (const node of nodes) {
          ids.push(node[0]);
          if (node[2]) ids.push(...flattenIds(node[2]));
        }
        return ids;
      };

      const allIds = flattenIds(result.tree);
      expect(allIds).toContain("sensor_001");
      expect(allIds).not.toContain("sensor_mirror");
    });
  });

  describe("Tag-based filtering", () => {
    it("filters tree to subtrees containing rooms with the named tag", async () => {
      setupTagFilteredMocks();

      const result = await executeListTopology({
        tag_names: ["huddle"],
        starting_depth: 0,
        traversal_depth: 10,
      });

      // huddle is on room_001 only (Floor 1) → Floor 2 (room_003) must be pruned
      const ids = flattenIds(result.tree);
      expect(ids).toContain("room_001");
      expect(ids).not.toContain("space_002");
      expect(ids).not.toContain("room_003");

      expect(result.query_params.tag_filter).toEqual({ names: ["huddle"], match: "any" });
      expect(result.unknown_tags).toBeUndefined();
    });

    it("matches case-insensitively", async () => {
      setupTagFilteredMocks();

      const result = await executeListTopology({
        tag_names: ["HUDDLE"],
        starting_depth: 0,
        traversal_depth: 10,
      });

      expect(flattenIds(result.tree)).toContain("room_001");
    });

    it("default tag_match='any' returns the union across multiple tags", async () => {
      setupTagFilteredMocks();

      const result = await executeListTopology({
        tag_names: ["huddle", "video"],
        starting_depth: 0,
        traversal_depth: 10,
      });

      // huddle → room_001 ; video → zone_001 ; both live on Floor 1.
      // filterTopologyByAssets prunes Floor 1 to only the matched children,
      // so room_002 (untagged sibling on the same floor) does NOT leak in.
      const ids = flattenIds(result.tree);
      expect(ids).toContain("room_001");
      expect(ids).toContain("zone_001");
      expect(ids).not.toContain("room_002");
      expect(ids).not.toContain("space_002");
    });

    it("tag_match='all' returns the per-entity-type intersection", async () => {
      setupTagFilteredMocks();

      const result = await executeListTopology({
        tag_names: ["huddle", "focus"],
        tag_match: "all",
        starting_depth: 0,
        traversal_depth: 10,
      });

      // huddle ∩ focus on rooms = {room_001}; tags don't apply to zones/floors
      // here, so room_003 (only focus) must NOT pull Floor 2 into the result.
      const ids = flattenIds(result.tree);
      expect(ids).toContain("room_001");
      expect(ids).not.toContain("space_002");
      expect(ids).not.toContain("room_003");
    });

    // 3-tag intersection exercises the fold loop in collectMatchAwareClosure
    // at i >= 2 — a 2-tag test only exercises i=1. Designed so the third tag
    // is load-bearing: focus ∩ broad already contains room_003, and only the
    // third tag (executive) prunes it. A fence-post that skips i=2 leaves
    // room_003 in and pulls Floor 2 in.
    it("tag_match='all' folds intersection across 3+ tags", async () => {
      setupTagFilteredMocks();

      const result = await executeListTopology({
        tag_names: ["focus", "broad", "executive"],
        tag_match: "all",
        starting_depth: 0,
        traversal_depth: 10,
      });

      // focus={001,003} ∩ broad={001,003} = {001,003}; ∩ executive={001,002} = {001}.
      // Floor 2 (only room_003) must be excluded — that's the load-bearing assertion.
      const ids = flattenIds(result.tree);
      expect(ids).toContain("room_001");
      expect(ids).not.toContain("space_002");
      expect(ids).not.toContain("room_003");
    });

    it("returns empty tree with warning when no tag names match", async () => {
      setupTagsOnlyMock();

      const result = await executeListTopology({
        tag_names: ["does-not-exist"],
        starting_depth: 0,
        traversal_depth: 10,
      });

      expect(result.tree).toEqual([]);
      expect(result.warning).toMatch(/No matching tags/i);
      expect(result.unknown_tags).toEqual(["does-not-exist"]);
      // Topology fetch should not happen on the no-match short-circuit
      expect(apolloClient.query).toHaveBeenCalledTimes(1);
    });

    it("returns empty tree with unsatisfiable warning under tag_match='all'", async () => {
      setupTagsOnlyMock();

      const result = await executeListTopology({
        tag_names: ["huddle", "does-not-exist"],
        tag_match: "all",
        starting_depth: 0,
        traversal_depth: 10,
      });

      expect(result.tree).toEqual([]);
      expect(result.warning).toMatch(/Cannot satisfy tag_match='all'/);
      expect(result.unknown_tags).toEqual(["does-not-exist"]);
      expect(apolloClient.query).toHaveBeenCalledTimes(1);
    });

    it("warns but still returns results when an unknown tag is mixed under tag_match='any'", async () => {
      setupTagFilteredMocks();

      const result = await executeListTopology({
        tag_names: ["huddle", "does-not-exist"],
        tag_match: "any",
        starting_depth: 0,
        traversal_depth: 10,
      });

      expect(result.tree).toHaveLength(1);
      expect(result.unknown_tags).toEqual(["does-not-exist"]);
      expect(result.warning).toMatch(/Unknown tag\(s\) ignored/);
      expect(flattenIds(result.tree)).toContain("room_001");
    });

    // an upstream that returns a dangling { id: null } in a
    // tag→entity association must not crash or pull spurious entries into
    // the matched-id set. Real refs alongside the bad ones still resolve.
    it("ignores tagged-entity refs with null id when filtering the topology", async () => {
      const dirtyTags = {
        tags: [
          {
            __typename: "Tag",
            id: "tag_huddle",
            name: "huddle",
            organization_id: "org_001",
            rooms: [
              { __typename: "Room", id: "room_001", name: "Conf A" },
              { __typename: "Room", id: null, name: null },
              { __typename: "Room", id: "" },
            ],
            zones: [],
            floors: [],
          },
        ],
      };
      setupTagFilteredMocks(dirtyTags);

      const result = await executeListTopology({
        tag_names: ["huddle"],
        starting_depth: 0,
        traversal_depth: 10,
      });

      const ids = flattenIds(result.tree);
      expect(ids).toContain("room_001");
      expect(ids).not.toContain("space_002");
      expect(result.warning).toBeUndefined();
    });

    it("returns empty with warning when resolved tags have no associations", async () => {
      // short-circuits on taggedEntityIds.size === 0 before the
      // topology fetch — queue only the tags mock and assert the call count
      // so a future regression that drops the short-circuit is caught here.
      setupTagsOnlyMock();

      const result = await executeListTopology({
        tag_names: ["unused"],
        starting_depth: 0,
        traversal_depth: 10,
      });

      expect(result.tree).toEqual([]);
      expect(result.warning).toMatch(/No rooms, zones, or floors are currently tagged/i);
      expect(apolloClient.query).toHaveBeenCalledTimes(1);
      // Lock the structured discriminant alongside the prose — programmatic
      // consumers branch on warnings[].kind, not regex on warning.
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "tag_no_associations",
            tag_match: "any",
            tag_names: ["unused"],
          }),
        ])
      );
    });

    // when a tag sits on an ANCESTOR of an asset_ids entry, the
    // asset is inside the tagged subtree and must qualify. A raw-ID
    // intersection (R3 v1) missed this because asset_ids and tagged_ids
    // didn't share a literal id. Symmetric closure expansion fixes it.
    it("matches asset_ids when the tag is on an ancestor floor of the asset", async () => {
      const tagsOnFloor = {
        tags: [
          {
            __typename: "Tag",
            id: "tag_floor_exec",
            name: "floor-executive",
            organization_id: "org_001",
            rooms: [],
            zones: [],
            floors: [{ __typename: "Floor", id: "space_001", name: "Floor 1" }],
          },
        ],
      };
      setupTagFilteredMocks(tagsOnFloor);

      const result = await executeListTopology({
        asset_ids: ["room_001"], // room is descendant of tagged Floor 1
        tag_names: ["floor-executive"],
        starting_depth: 0,
        traversal_depth: 10,
      });

      const ids = flattenIds(result.tree);
      expect(ids).toContain("room_001");
      expect(result.warning).toBeUndefined();
    });

    // sensor/hive asset_ids must compose against floor-level tags.
    // The original closure did not include sensors/hives at all and would
    // misreport assetScopeEmpty even though the device exists.
    it("matches sensor/hive asset_ids when the tag is on the floor they live on", async () => {
      const tagsOnFloor = {
        tags: [
          {
            __typename: "Tag",
            id: "tag_floor_exec",
            name: "floor-executive",
            organization_id: "org_001",
            rooms: [],
            zones: [],
            floors: [{ __typename: "Floor", id: "space_001", name: "Floor 1" }],
          },
        ],
      };
      setupTagFilteredMocks(tagsOnFloor);

      const result = await executeListTopology({
        asset_ids: ["sensor_001"], // sensor on Floor 1 (space_001)
        tag_names: ["floor-executive"],
        starting_depth: 0,
        traversal_depth: 10,
      });

      const ids = flattenIds(result.tree);
      expect(ids).toContain("sensor_001");
      expect(result.warning).toBeUndefined();
    });

    // a tag on a room implicitly covers devices bound to that
    // room via room_id, even though the topology attaches them at floor
    // level. asset_ids=[sensor_001] (room_id=room_001) + tag on room_001
    // should match.
    it("matches sensor asset_ids when the tag is on its room (sensor.room_id)", async () => {
      // Default huddle fixture already tags room_001; sensor_001.room_id = room_001.
      setupTagFilteredMocks();

      const result = await executeListTopology({
        asset_ids: ["sensor_001"],
        tag_names: ["huddle"],
        starting_depth: 0,
        traversal_depth: 10,
      });

      const ids = flattenIds(result.tree);
      expect(ids).toContain("sensor_001");
      expect(result.warning).toBeUndefined();
    });

    // a zone with room_id pointing at a targeted room must be
    // pulled into the room's closure, mirroring the formatter's behaviour
    // (zones with roomID/room_id render as room children).
    it("matches asset_ids when the tag is on a room-bound zone (zone.room_id → room)", async () => {
      // Topology: add a zone whose room_id binds it to room_001.
      const topoWithRoomZone = {
        sites: {
          data: [
            {
              id: "site_001",
              name: "HQ Campus",
              timezone: "America/New_York",
              org_id: "org_001",
              buildings: [
                {
                  id: "building_001",
                  name: "Main Tower",
                  site_id: "site_001",
                  floors: [
                    {
                      id: "space_001",
                      name: "Floor 1",
                      building_id: "building_001",
                      rooms: [
                        { id: "room_001", name: "Conf A", floorID: "space_001" },
                        { id: "room_002", name: "Conf B", floorID: "space_001" },
                      ],
                      zones: [
                        {
                          id: "zone_in_room_001",
                          name: "Privacy Booth",
                          floorID: "space_001",
                          room_id: "room_001",
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      };
      const tagsOnZone = {
        tags: [
          {
            __typename: "Tag",
            id: "tag_priv",
            name: "privacy",
            organization_id: "org_001",
            rooms: [],
            zones: [{ __typename: "Zone", id: "zone_in_room_001", name: "Privacy Booth" }],
            floors: [],
          },
        ],
      };
      setupTagFilteredMocks(tagsOnZone, topoWithRoomZone);

      const result = await executeListTopology({
        asset_ids: ["room_001"],
        tag_names: ["privacy"],
        starting_depth: 0,
        traversal_depth: 10,
      });

      const ids = flattenIds(result.tree);
      expect(ids).toContain("zone_in_room_001");
      expect(result.warning).toBeUndefined();
    });

    // device room links may arrive as camelCase `roomID` instead
    // of snake_case `room_id` (cached payloads, alternate API shape). The
    // closure must match the formatter and accept either.
    it("matches sensor asset_ids using camelCase roomID when the tag is on its room", async () => {
      const sensorsCamelCase = {
        sensors: {
          data: [
            {
              id: "sensor_camel_001",
              mac_address: "aa:bb:cc:dd:ee:99",
              mode: "presence",
              floor_id: "space_001",
              roomID: "room_001", // camelCase only — no snake_case room_id
              hive_serial: "HIVE001",
              is_online: true,
              is_entrance: false,
            },
          ],
        },
      };
      setupTagFilteredMocks(undefined, undefined, sensorsCamelCase);

      const result = await executeListTopology({
        asset_ids: ["sensor_camel_001"],
        tag_names: ["huddle"], // huddle is on room_001 in the default fixture
        starting_depth: 0,
        traversal_depth: 10,
      });

      const ids = flattenIds(result.tree);
      expect(ids).toContain("sensor_camel_001");
      expect(result.warning).toBeUndefined();
    });

    // when both inputs are typos, surface the asset_ids note
    // alongside the tag-typo warning — but only if we can verify cheaply
    // (warm topology cache). Without the cache we don't pay for a fetch
    // just for the diagnostic.
    it("hints at invalid asset_ids alongside unknown-tag warning when topology cache is warm", async () => {
      // Prime the cache with a successful no-tag call.
      setupFullTopologyMocks();
      await executeListTopology({ starting_depth: 0, traversal_depth: 0 });

      // Now run a dual-typo call. Only the tags fetch should happen
      // (cache hit gives us asset verification for free).
      setupTagsOnlyMock();

      const result = await executeListTopology({
        asset_ids: ["asset_does_not_exist"],
        tag_names: ["does-not-exist"],
        starting_depth: 0,
        traversal_depth: 10,
      });

      expect(result.tree).toEqual([]);
      // Both the rendered prose and the structured diagnostics carry the
      // dual cause. We assert on the structured form (kind discriminants)
      // because it's robust to rewording; the prose is a derived view.
      expect(result.warning).toMatch(/No matching tags/i);
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "tag_no_match" }),
          expect.objectContaining({ kind: "asset_scope_empty" }),
        ])
      );
      // 3 priming calls (topology + sensors + hives) + 1 dual-typo tags
      // fetch = 4. Locks in the cache-hit path so a regression that loses
      // the merged-cache lookup and triggers a fresh topology fetch fails
      // this assertion loudly instead of returning an unrelated error.
      expect(apolloClient.query).toHaveBeenCalledTimes(4);
    });

    // butlr_search_assets writes to a separate cache key (devicesMerged:false)
    // than butlr_list_topology (devicesMerged:true). When only the search-
    // assets shape is primed, the list-topology read MUST miss the merged-
    // shape cache and surface the dual-typo "asset_ids were not validated"
    // hint instead of false-positively reporting a real device id as missing.
    it("does NOT false-positive asset_ids hint when only search_assets primed the cache", async () => {
      // Prime the cache as butlr_search_assets does: sites tree only,
      // sensors/hives never merged → floor.sensors stays undefined.
      const { sites } = buildTopologyFixture();
      const orgId = process.env.BUTLR_ORG_ID || "default";
      setCachedTopology(
        generateTopologyCacheKey(
          orgId,
          true,
          true,
          false, // devicesMerged: false — mirrors butlr_search_assets cache shape
          undefined
        ),
        {
          sites: sites.data,
        }
      );

      setupTagsOnlyMock();

      const result = await executeListTopology({
        asset_ids: ["sensor_real_one"], // would be a real sensor, but cache can't tell
        tag_names: ["does-not-exist"],
        starting_depth: 0,
        traversal_depth: 10,
      });

      expect(result.tree).toEqual([]);
      expect(result.warning).toMatch(/No matching tags/i);
      // Critically: NO false-positive "matched no entities" assertion. The
      // unverified hint surfaces instead, telling the caller to retry after
      // fixing the tag — at which point the merged-shape cache will exist.
      expect(result.warning).not.toMatch(/asset_ids also matched no entities/i);
      expect(result.warning).toMatch(/asset_ids were not validated/i);
    });

    // a tag with associations to entities that aren't in
    // the active topology (deleted entity, test device filtered, etc.)
    // must produce an explanatory warning rather than a silent empty tree.
    it("warns when tag associations point at entities missing from the active topology", async () => {
      const tagsWithGhostRoom = {
        tags: [
          {
            __typename: "Tag",
            id: "tag_ghost",
            name: "ghost-tag",
            organization_id: "org_001",
            rooms: [{ __typename: "Room", id: "room_does_not_exist", name: "Ghost" }],
            zones: [],
            floors: [],
          },
        ],
      };
      setupTagFilteredMocks(tagsWithGhostRoom);

      const result = await executeListTopology({
        tag_names: ["ghost-tag"],
        starting_depth: 0,
        traversal_depth: 10,
      });

      expect(result.tree).toEqual([]);
      expect(result.warning).toMatch(/none are present in the active topology/i);
      expect(result.warning).toMatch(/butlr_list_tags/i);
    });

    // a partial-ghost tag (some real, some absent) used to
    // silently include the real entries and hide the dangling ones. Now
    // the response surfaces "N of M tag associations point at entities
    // outside the active topology" when the tree is non-empty.
    it("warns about partial-ghost tag associations (some real, some absent)", async () => {
      const partialGhostTag = {
        tags: [
          {
            __typename: "Tag",
            id: "tag_partial",
            name: "partial-ghost",
            organization_id: "org_001",
            rooms: [
              { __typename: "Room", id: "room_001", name: "Conf A" }, // real
              { __typename: "Room", id: "room_does_not_exist", name: "Ghost" },
            ],
            zones: [],
            floors: [],
          },
        ],
      };
      setupTagFilteredMocks(partialGhostTag);

      const result = await executeListTopology({
        tag_names: ["partial-ghost"],
        starting_depth: 0,
        traversal_depth: 10,
      });

      // Real entry renders; tree is non-empty.
      expect(flattenIds(result.tree)).toContain("room_001");
      // Soft warning surfaces the dangling association.
      expect(result.warning).toMatch(/1 of 2 tag associations point at entities outside/i);
    });

    // sensors reach a room transitively through a room-bound hive
    // (sensor.hive_serial → hive.serialNumber, hive.room_id → room). The
    // formatter renders such sensors under their hive under the room, so
    // they must be in the room's tag closure even without a direct
    // room_id/roomID link of their own.
    it("matches sensor asset_ids attached via room-bound hive (no direct room_id)", async () => {
      const sensorViaHive = {
        sensors: {
          data: [
            {
              id: "sensor_via_hive",
              mac_address: "aa:bb:cc:dd:ee:77",
              mode: "presence",
              floor_id: "space_001",
              // No room_id / roomID — link to room is purely through the hive.
              hive_serial: "HIVE001",
              is_online: true,
              is_entrance: false,
            },
          ],
        },
      };
      const hiveBoundToRoom = {
        hives: {
          data: [
            {
              id: "hive_in_room_001",
              serialNumber: "HIVE001",
              floor_id: "space_001",
              room_id: "room_001", // hive sits in room_001
              isOnline: true,
              installed: true,
            },
          ],
        },
      };
      setupTagFilteredMocks(undefined, undefined, sensorViaHive, hiveBoundToRoom);

      const result = await executeListTopology({
        asset_ids: ["sensor_via_hive"],
        tag_names: ["huddle"], // huddle is on room_001 in the default fixture
        starting_depth: 0,
        traversal_depth: 10,
      });

      const ids = flattenIds(result.tree);
      expect(ids).toContain("sensor_via_hive");
      expect(result.warning).toBeUndefined();
    });

    // leaf-level asset_ids must AND with tag_names strictly.
    // filterTopologyByAssets's contextual expansion would otherwise leak
    // siblings of the asset_ids leaf — e.g. asset_ids=[room_002] expands
    // to Floor 1 with all rooms (incl. room_001), and a naive second-pass
    // tag filter would then catch room_001 and silently broaden the result.
    it("composes AND-style at leaf level: sibling tag matches don't leak through asset_ids", async () => {
      setupTagFilteredMocks();

      const result = await executeListTopology({
        asset_ids: ["room_002"], // Floor 1 sibling of huddle's room_001
        tag_names: ["huddle"], // huddle is on room_001 only
        starting_depth: 0,
        traversal_depth: 10,
      });

      // True AND: room_002 is not tagged huddle, so the result is empty —
      // the sibling room_001 (which IS huddle) must NOT pull anything in.
      expect(result.tree).toEqual([]);
      expect(result.warning).toMatch(/disjoint subtrees/i);
      expect(result.warning).not.toMatch(/matched no entities/i);
    });

    // invalid asset_ids must surface a clearer warning, not the
    // misleading "disjoint subtrees" — the asset_ids didn't resolve at all,
    // so there's no scope to be disjoint from.
    it("emits 'asset_ids matched no entities' (not 'disjoint') for invalid asset_ids alongside tag_names", async () => {
      setupTagFilteredMocks();

      const result = await executeListTopology({
        asset_ids: ["room_definitely_does_not_exist"],
        tag_names: ["huddle"],
        starting_depth: 0,
        traversal_depth: 10,
      });

      expect(result.tree).toEqual([]);
      expect(result.warning).toMatch(/asset_ids matched no entities/i);
      expect(result.warning).not.toMatch(/disjoint subtrees/i);
    });

    // tag matches a room outside the asset_ids scope, no overlap.
    // Pins down the intersection semantics so a future refactor that turns
    // composition into a union would be caught (current test would still pass
    // because the in-scope tag also matches).
    it("returns empty tree when tag matches no entity inside the asset_ids scope", async () => {
      setupTagFilteredMocks();

      const result = await executeListTopology({
        asset_ids: ["space_002"],
        tag_names: ["huddle"], // huddle is on room_001 only (Floor 1)
        starting_depth: 0,
        traversal_depth: 10,
      });

      expect(result.tree).toEqual([]);
      expect(result.query_params.asset_filter).toEqual(["space_002"]);
      expect(result.query_params.tag_filter).toEqual({ names: ["huddle"], match: "any" });
      // Disjoint scopes yield an explanatory warning so the
      // caller can distinguish "filters disagree" from a generic empty-tree.
      expect(result.warning).toMatch(/disjoint subtrees/i);
    });

    it("composes AND-style with asset_ids — tag matches outside the scope are pruned", async () => {
      // focus is on room_001 (Floor 1) and room_003 (Floor 2). Scope to Floor 2
      // and only room_003 should remain.
      setupTagFilteredMocks();

      const result = await executeListTopology({
        asset_ids: ["space_002"],
        tag_names: ["focus"],
        starting_depth: 0,
        traversal_depth: 10,
      });

      const ids = flattenIds(result.tree);
      expect(ids).toContain("room_003");
      expect(ids).not.toContain("room_001");
      expect(result.query_params.asset_filter).toEqual(["space_002"]);
      expect(result.query_params.tag_filter).toEqual({ names: ["focus"], match: "any" });
    });

    // H2 regression: filterTopologyByAssets must prune siblings of a matched
    // room — pre-fix it pushed the entire raw floor into the result, which
    // re-broadened tag-composition AND back into "every node on the floor".
    // The fixture below pins the Codex acceptance test (untagged sibling
    // room_extra must NOT appear when filtering by huddle).
    it("strict prune: untagged sibling rooms on a tag-matched floor do NOT leak in", async () => {
      const topoWithSibling = {
        sites: {
          data: [
            {
              id: "site_001",
              name: "HQ Campus",
              timezone: "America/New_York",
              org_id: "org_001",
              buildings: [
                {
                  id: "building_001",
                  name: "Main Tower",
                  site_id: "site_001",
                  floors: [
                    {
                      id: "space_001",
                      name: "Floor 1",
                      building_id: "building_001",
                      rooms: [
                        { id: "room_001", name: "Conf A", floorID: "space_001" }, // huddle-tagged
                        { id: "room_002", name: "Conf B", floorID: "space_001" }, // untagged sibling
                        { id: "room_extra", name: "Extra", floorID: "space_001" }, // untagged sibling
                      ],
                      zones: [{ id: "zone_001", name: "Reception", floorID: "space_001" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      };
      setupTagFilteredMocks(undefined, topoWithSibling);

      const result = await executeListTopology({
        tag_names: ["huddle"],
        starting_depth: 0,
        traversal_depth: 10,
      });

      const ids = flattenIds(result.tree);
      expect(ids).toContain("room_001");
      // Untagged siblings on the same floor must be pruned.
      expect(ids).not.toContain("room_002");
      expect(ids).not.toContain("room_extra");
      // zone_001 has no huddle tag and is not bound to room_001 (no room_id),
      // so it must also be pruned.
      expect(ids).not.toContain("zone_001");
    });

    // M1 regression: when both the asset-side filter is empty AND the tag
    // is dangling (points only at deleted entities), the response must
    // emit the ghost-tag diagnostic — not the misleading "disjoint
    // subtrees" warning. The two diagnostics now evaluate independently.
    it("emits ghost-tag diagnostic when asset_ids + dangling-tag both apply (not 'disjoint')", async () => {
      const tagsWithGhostRoom = {
        tags: [
          {
            __typename: "Tag",
            id: "tag_ghost",
            name: "ghost-tag",
            organization_id: "org_001",
            rooms: [{ __typename: "Room", id: "room_does_not_exist", name: "Ghost" }],
            zones: [],
            floors: [],
          },
        ],
      };
      setupTagFilteredMocks(tagsWithGhostRoom);

      const result = await executeListTopology({
        asset_ids: ["building_001"], // valid asset scope (early-return preserves whole building)
        tag_names: ["ghost-tag"],
        starting_depth: 0,
        traversal_depth: 10,
      });

      expect(result.tree).toEqual([]);
      // Tag-side ghost diagnostic surfaces; asset-side disjoint warning is
      // suppressed because the ghost is the root cause.
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "tag_associations_all_ghost", total: 1 }),
        ])
      );
      expect(result.warnings).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "asset_tag_disjoint" })])
      );
      // Prose mirrors the structured form.
      expect(result.warning).toMatch(/none are present in the active topology/i);
      expect(result.warning).not.toMatch(/disjoint subtrees/i);
    });

    // R6 §1 regression: the all-ghost diagnostic must NOT fire when the
    // tree is empty due to depth slicing rather than missing entities.
    // ghostKind is computed from `ghostTagCount === taggedEntityIds.size`,
    // anchored on the merged-topology presentIds walk — independent of
    // `tree.length` / starting_depth / traversal_depth. A future refactor
    // that re-couples the diagnostic to the rendered tree would fire
    // `tag_associations_all_ghost` falsely for a real-but-deviceless
    // tagged entity queried at sensors-level depth.
    it("does NOT emit all-ghost diagnostic when tree is empty due to depth slicing", async () => {
      // Empty sensors + hives → after merge every floor has sensors=[] /
      // hives=[]. starting_depth=5 (sensors level) renders nothing.
      setupTagFilteredMocks(
        undefined,
        undefined,
        { sensors: { data: [] } },
        { hives: { data: [] } }
      );

      const result = await executeListTopology({
        tag_names: ["huddle"], // huddle is on real room_001 in the default fixture
        starting_depth: 5,
        traversal_depth: 0,
      });

      expect(result.tree).toEqual([]);
      // room_001 IS in the merged topology — empty tree is a depth artefact,
      // not a deletion artefact. No structured ghost diagnostic, no prose.
      expect(result.warnings ?? []).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "tag_associations_all_ghost" })])
      );
      expect(result.warning ?? "").not.toMatch(/none are present in the active topology/i);
      expect(result.warning ?? "").not.toMatch(/may have been deleted/i);
    });

    // M5 regression: warnings[] is a discriminated union of TopologyDiagnostic
    // — programmatic consumers branch on `kind`. The legacy `warning` string
    // is rendered from the same set so the two are always in lock-step.
    it("emits structured warnings[] alongside the rendered warning string", async () => {
      setupTagFilteredMocks();

      const result = await executeListTopology({
        tag_names: ["huddle", "does-not-exist"],
        tag_match: "any",
        starting_depth: 0,
        traversal_depth: 10,
      });

      expect(result.warnings).toBeDefined();
      expect(result.warnings).toEqual([{ kind: "unknown_tags", names: ["does-not-exist"] }]);
      // The rendered string is derived from the structured list; both fields
      // describe the same diagnostic surface.
      expect(result.warning).toContain("Unknown tag(s) ignored");
      expect(result.warning).toContain("does-not-exist");
    });

    // L5 regression: when asset_ids targets a SITE, the closure must
    // include every descendant (down to sensors) so a tag on a deep room
    // intersects the asset closure correctly. Pins the site-level
    // early-continue branch in expandToSubtreeClosure.
    it("matches descendants when asset_ids targets a site with tag on a deep room", async () => {
      setupTagFilteredMocks();

      const result = await executeListTopology({
        asset_ids: ["site_001"],
        tag_names: ["huddle"],
        starting_depth: 0,
        traversal_depth: 10,
      });

      // huddle is on room_001 (deep inside site_001). Site-level closure
      // pulls in everything; intersection with huddle's closure yields
      // room_001 + room-bound bindings.
      expect(flattenIds(result.tree)).toContain("room_001");
      expect(result.warnings).toBeUndefined();
    });

    // L5 regression: same intent, building-level. Pins the building-level
    // early-continue branch in expandToSubtreeClosure.
    it("matches descendants when asset_ids targets a building with tag on a deep sensor", async () => {
      // Use a tag on the floor so its closure pulls in floor's sensors.
      const tagsOnFloor = {
        tags: [
          {
            __typename: "Tag",
            id: "tag_floor",
            name: "deep-floor",
            organization_id: "org_001",
            rooms: [],
            zones: [],
            floors: [{ __typename: "Floor", id: "space_001", name: "Floor 1" }],
          },
        ],
      };
      setupTagFilteredMocks(tagsOnFloor);

      const result = await executeListTopology({
        asset_ids: ["building_001"], // ancestor of sensor_001
        tag_names: ["deep-floor"],
        starting_depth: 0,
        traversal_depth: 10,
      });

      // Building-level closure pulls in every descendant; floor-level tag
      // also covers all descendants. Intersection contains the sensor.
      expect(flattenIds(result.tree)).toContain("sensor_001");
      expect(result.warnings).toBeUndefined();
    });

    // L5 regression: hive.roomID (camelCase) closure path — the existing
    // tests cover sensor and zone camelCase variants, but the hive variant
    // is the gate for the entire R6 transitive sensor chain. Without this
    // test, a regression that only checks `hive.room_id` would silently
    // drop room-bound hives whose link arrives as `roomID`.
    it("matches sensors via room-bound hive when hive uses camelCase roomID (no snake_case)", async () => {
      const sensorViaHive = {
        sensors: {
          data: [
            {
              id: "sensor_via_camel_hive",
              mac_address: "aa:bb:cc:dd:ee:88",
              mode: "presence",
              floor_id: "space_001",
              hive_serial: "HIVE001",
              is_online: true,
              is_entrance: false,
            },
          ],
        },
      };
      const hiveCamelCase = {
        hives: {
          data: [
            {
              id: "hive_camel_001",
              serialNumber: "HIVE001",
              floor_id: "space_001",
              roomID: "room_001", // camelCase only — no snake_case room_id
              isOnline: true,
              installed: true,
            },
          ],
        },
      };
      setupTagFilteredMocks(undefined, undefined, sensorViaHive, hiveCamelCase);

      const result = await executeListTopology({
        asset_ids: ["sensor_via_camel_hive"],
        tag_names: ["huddle"], // huddle on room_001
        starting_depth: 0,
        traversal_depth: 10,
      });

      // Closure walks: huddle → room_001 → camelCase-bound hive_camel_001
      // → its sensors via hive_serial → sensor_via_camel_hive.
      expect(flattenIds(result.tree)).toContain("sensor_via_camel_hive");
      expect(result.warnings).toBeUndefined();
    });

    // H1 regression: butlr_search_assets and butlr_list_topology cache to
    // SEPARATE keys (devicesMerged true vs false). A search-assets-primed
    // cache must NOT cause list-topology to read a device-incomplete shape
    // and silently drop sensor/hive matches. This test primes the search-
    // assets cache, then runs a sensor-targeted list-topology call and
    // asserts the sensor is returned (i.e., a fresh fetch happened).
    it("does not read search_assets cache shape — sensor asset_ids resolve correctly after search prime", async () => {
      // Step 1: prime the search-assets cache shape (devicesMerged:false).
      const { sites } = buildTopologyFixture();
      const orgId = process.env.BUTLR_ORG_ID || "default";
      setCachedTopology(generateTopologyCacheKey(orgId, true, true, false, undefined), {
        sites: sites.data,
      });

      // Step 2: list_topology must re-fetch under its own merged-devices key.
      // Queue topology + sensors + hives mocks (no tag fetch — asset-only call).
      setupFullTopologyMocks();

      const result = await executeListTopology({
        asset_ids: ["sensor_001"],
        starting_depth: 0,
        traversal_depth: 10,
      });

      const ids = flattenIds(result.tree);
      // sensor_001 lives on room_001 / hive HIVE001 in the default fixture.
      // A device-aware fetch + closure resolves it; a stale-cache read would
      // see floor.sensors === undefined and silently return tree=[].
      expect(ids).toContain("sensor_001");
      // Three calls: topology + sensors + hives. Search-assets-shape cache
      // was correctly ignored.
      expect(apolloClient.query).toHaveBeenCalledTimes(3);
    });

    // C1 regression: tag_names alone must closure-expand. Tag on a room →
    // tagClosure includes the room's room-bound descendants. Pre-fix, the
    // raw tagged-id set was passed to pruneFloorToMatches and the room was
    // returned with empty children.
    it("tag_names=[room-tag] returns the tagged room AND its room-bound descendants", async () => {
      setupTagFilteredMocks(); // huddle is on room_001

      const result = await executeListTopology({
        tag_names: ["huddle"],
        starting_depth: 0,
        traversal_depth: 10,
      });

      const ids = flattenIds(result.tree);
      expect(ids).toContain("room_001");
      // sensor_001.room_id === room_001 — must be in tagClosure of room_001.
      expect(ids).toContain("sensor_001");
    });

    // C2 regression: when asset_ids is invalid AND every tag association is
    // dangling, the response must surface BOTH diagnostics. Pre-fix, the
    // ghostKind !== "all" gate suppressed the entire asset-side branch
    // including asset_scope_empty (an independent root cause), forcing the
    // user into two debug round-trips.
    it("emits both asset_scope_empty AND tag_associations_all_ghost when both inputs fail", async () => {
      const ghostTag = {
        tags: [
          {
            __typename: "Tag",
            id: "tag_ghost_only",
            name: "ghost-only-tag",
            organization_id: "org_001",
            rooms: [{ __typename: "Room", id: "room_does_not_exist", name: "Ghost" }],
            zones: [],
            floors: [],
          },
        ],
      };
      setupTagFilteredMocks(ghostTag);

      const result = await executeListTopology({
        asset_ids: ["asset_does_not_exist"],
        tag_names: ["ghost-only-tag"],
        starting_depth: 0,
        traversal_depth: 10,
      });

      const kinds = (result.warnings ?? []).map((w) => w.kind);
      expect(kinds).toContain("tag_associations_all_ghost");
      expect(kinds).toContain("asset_scope_empty");
    });

    // I1 regression (Track C): tag_match='all' across hierarchical levels
    // must intersect per-tag SUBTREE closures, not raw per-type ID
    // intersections. Pre-fix, a tag on Floor 1 AND a tag on a room inside
    // Floor 1 yielded {} (per-type intersection: rooms ∩ floors = ∅) even
    // though the user clearly meant "the room is in both tags' subtrees."
    it("tag_match='all' across hierarchy levels intersects subtree closures, not raw IDs", async () => {
      const hierarchicalTags = {
        tags: [
          {
            __typename: "Tag",
            id: "tag_floor",
            name: "floor-tag",
            organization_id: "org_001",
            rooms: [],
            zones: [],
            // Tag the whole floor.
            floors: [{ __typename: "Floor", id: "space_001", name: "Floor 1" }],
          },
          {
            __typename: "Tag",
            id: "tag_room",
            name: "room-tag",
            organization_id: "org_001",
            // Tag a room INSIDE the tagged floor.
            rooms: [{ __typename: "Room", id: "room_001", name: "Conf A" }],
            zones: [],
            floors: [],
          },
        ],
      };
      setupTagFilteredMocks(hierarchicalTags);

      const result = await executeListTopology({
        tag_names: ["floor-tag", "room-tag"],
        tag_match: "all",
        starting_depth: 0,
        traversal_depth: 10,
      });

      const ids = flattenIds(result.tree);
      // room_001 is in BOTH subtrees: trivially in tag_room (direct) and
      // in tag_floor (descendant of space_001). Closure-vs-closure
      // intersection includes it; literal per-type intersection misses it.
      expect(ids).toContain("room_001");
      // No spurious diagnostics — this is a real, satisfiable filter.
      expect(result.warnings ?? []).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "tag_no_associations" })])
      );
    });

    // I3 regression: malformed_tag_rows must surface end-to-end. The tag
    // resolver counts upstream-contract violations (null/empty id+name,
    // case-insensitive duplicates) into droppedRowCount, and the topology
    // tool plumbs that into the diagnostics array. A wiring regression
    // (tool no longer reads droppedRowCount) would silently swallow the
    // upstream signal.
    it("surfaces malformed_tag_rows when the tags response contains malformed rows", async () => {
      const tagsWithMalformed = {
        tags: [
          {
            __typename: "Tag",
            id: "tag_real",
            name: "real-tag",
            organization_id: "org_001",
            rooms: [{ __typename: "Room", id: "room_001", name: "Conf A" }],
            zones: [],
            floors: [],
          },
          // Two malformed rows: missing name and null id.
          {
            __typename: "Tag",
            id: "tag_no_name",
            organization_id: "org_001",
            rooms: [],
            zones: [],
            floors: [],
          } as any,
          {
            __typename: "Tag",
            id: null,
            name: "ghost-id",
            organization_id: "org_001",
            rooms: [],
            zones: [],
            floors: [],
          } as any,
        ],
      };
      setupTagFilteredMocks(tagsWithMalformed);

      const result = await executeListTopology({
        tag_names: ["real-tag"],
        starting_depth: 0,
        traversal_depth: 10,
      });

      const malformed = (result.warnings ?? []).find((w) => w.kind === "malformed_tag_rows");
      expect(malformed).toEqual(expect.objectContaining({ kind: "malformed_tag_rows", count: 2 }));
    });

    // I4 regression: structured asset_ids_unverified discriminant must
    // surface — not just the prose. PR contract is warnings[] for
    // programmatic consumers; a prose reword would silently break clients
    // if we only tested result.warning text.
    it("emits structured asset_ids_unverified when topology cache is cold and tag is unknown", async () => {
      // No prior call → cache cold. Dual-typo input.
      setupTagsOnlyMock();

      const result = await executeListTopology({
        asset_ids: ["asset_does_not_exist"],
        tag_names: ["does-not-exist"],
        starting_depth: 0,
        traversal_depth: 10,
      });

      const kinds = (result.warnings ?? []).map((w) => w.kind);
      expect(kinds).toContain("tag_no_match");
      expect(kinds).toContain("asset_ids_unverified");
    });

    // I5 regression: zone-as-target asset_ids must compose. The closure
    // doc-block lists `zone → zone alone` as a closure rule; a regression
    // that drops the leaf-zone branch in expandToSubtreeClosure would let
    // zone-targeted asset_ids silently miss when composed with tag_names.
    it("asset_ids=[zone] composes with a tag matching that zone", async () => {
      // video tag → zone_001 in the default fixture; asset_ids=[zone_001].
      setupTagFilteredMocks();

      const result = await executeListTopology({
        asset_ids: ["zone_001"],
        tag_names: ["video"],
        starting_depth: 0,
        traversal_depth: 10,
      });

      const ids = flattenIds(result.tree);
      expect(ids).toContain("zone_001");
      expect(result.warnings ?? []).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "asset_tag_disjoint" })])
      );
    });

    // I2 regression: partial_topology must suppress ghost diagnostics — the
    // presentIds walk runs against truncated topology and would otherwise
    // false-positive a tag whose entity is merely missing from THIS partial
    // fetch. partial_topology already alerts the caller.
    it("does NOT emit tag_associations_*_ghost when partial_topology fired", async () => {
      // Topology with the tagged entity (room_001) MISSING from the
      // partial response. The full topology contains it, but this fetch
      // returns Floor 1 with only room_002.
      const partialTopo = {
        sites: {
          data: [
            {
              id: "site_001",
              name: "HQ",
              timezone: "America/New_York",
              org_id: "org_001",
              buildings: [
                {
                  id: "building_001",
                  name: "Main",
                  site_id: "site_001",
                  floors: [
                    {
                      id: "space_001",
                      name: "Floor 1",
                      building_id: "building_001",
                      rooms: [{ id: "room_002", name: "Conf B", floorID: "space_001" }],
                      zones: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
      };

      // Apollo-style { data, error } → partialData=true.
      vi.mocked(apolloClient.query)
        .mockResolvedValueOnce({
          data: buildTagsFixture(),
          loading: false,
          networkStatus: 7,
        } as any)
        .mockResolvedValueOnce({
          data: partialTopo,
          error: new Error("Partial: floors truncated"),
          loading: false,
          networkStatus: 7,
        } as any)
        .mockResolvedValueOnce({
          data: { sensors: { data: [] } },
          loading: false,
          networkStatus: 7,
        } as any)
        .mockResolvedValueOnce({
          data: { hives: { data: [] } },
          loading: false,
          networkStatus: 7,
        } as any);

      const result = await executeListTopology({
        tag_names: ["huddle"], // huddle → room_001, which is missing from this partial fetch
        starting_depth: 0,
        traversal_depth: 10,
      });

      const kinds = (result.warnings ?? []).map((w) => w.kind);
      expect(kinds).toContain("partial_topology");
      // room_001 is "missing" only because the fetch was partial — must
      // NOT surface as tag_associations_all_ghost.
      expect(kinds).not.toContain("tag_associations_all_ghost");
      expect(kinds).not.toContain("tag_associations_partial_ghost");
    });

    // Symmetric to the ghost suppression: under partialData, the
    // disjointness was computed against a truncated topology and is a
    // false signal. The actionable diagnostic is partial_topology, not
    // "remove a filter."
    it("does NOT emit asset_tag_disjoint when partial_topology fired", async () => {
      // Same setup as the ghost-suppression test: huddle tag → room_001,
      // partial topology missing room_001, plus an asset_ids filter that
      // would intersect-empty with the truncated tag closure.
      const partialTopo = {
        sites: {
          data: [
            {
              id: "site_001",
              name: "HQ",
              timezone: "America/New_York",
              org_id: "org_001",
              buildings: [
                {
                  id: "building_001",
                  name: "Main",
                  site_id: "site_001",
                  floors: [
                    {
                      id: "space_001",
                      name: "Floor 1",
                      building_id: "building_001",
                      rooms: [{ id: "room_002", name: "Conf B", floorID: "space_001" }],
                      zones: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
      };

      vi.mocked(apolloClient.query)
        .mockResolvedValueOnce({
          data: buildTagsFixture(),
          loading: false,
          networkStatus: 7,
        } as any)
        .mockResolvedValueOnce({
          data: partialTopo,
          error: new Error("Partial: floors truncated"),
          loading: false,
          networkStatus: 7,
        } as any)
        .mockResolvedValueOnce({
          data: { sensors: { data: [] } },
          loading: false,
          networkStatus: 7,
        } as any)
        .mockResolvedValueOnce({
          data: { hives: { data: [] } },
          loading: false,
          networkStatus: 7,
        } as any);

      const result = await executeListTopology({
        asset_ids: ["room_002"], // real room in the partial fetch
        tag_names: ["huddle"], // huddle → room_001, missing from partial fetch
        starting_depth: 0,
        traversal_depth: 10,
      });

      const kinds = (result.warnings ?? []).map((w) => w.kind);
      expect(kinds).toContain("partial_topology");
      // Disjoint computation here is a false signal — the tag closure
      // was empty only because the relevant entity was outside the
      // partial fetch. partial_topology is the actionable diagnostic.
      expect(kinds).not.toContain("asset_tag_disjoint");
    });

    // Depth-slicing diagnostic: filter resolved real entities, but the
    // formatter window excluded all of them. Pre-fix, the user got
    // tree:[] with no warning. Now there's a structured diagnostic that
    // tells them to widen the depth window.
    it("emits depth_excludes_matches when filter resolves but starting_depth slices everything out", async () => {
      // huddle → room_001 (rooms live at depth 3). starting_depth=5
      // (sensors) with traversal_depth=0 renders only sensors — and
      // we pass an empty-sensors fixture so the floor has nothing at
      // depth 5. Filter resolved (real room_001 in the closure), but
      // tree comes back empty due to depth slicing.
      setupTagFilteredMocks(
        undefined,
        undefined,
        { sensors: { data: [] } },
        { hives: { data: [] } }
      );

      const result = await executeListTopology({
        tag_names: ["huddle"],
        starting_depth: 5,
        traversal_depth: 0,
      });

      expect(result.tree).toEqual([]);
      const kinds = (result.warnings ?? []).map((w) => w.kind);
      expect(kinds).toContain("depth_excludes_matches");
      expect(result.warning ?? "").toMatch(/widen|lower starting_depth|raise traversal_depth/i);
    });

    // tag_match='all' with associations spanning all three entity types.
    // Pre-fix per-type literal intersection couldn't hit this case
    // correctly; verify the closure-aware implementation handles
    // multi-type subtree composition.
    it("tag_match='all' across rooms+zones+floors all resolves correctly", async () => {
      const multiTypeTags = {
        tags: [
          {
            __typename: "Tag",
            id: "tag_floor_x",
            name: "floor-x",
            organization_id: "org_001",
            rooms: [],
            zones: [],
            floors: [{ __typename: "Floor", id: "space_001", name: "Floor 1" }],
          },
          {
            __typename: "Tag",
            id: "tag_room_x",
            name: "room-x",
            organization_id: "org_001",
            rooms: [{ __typename: "Room", id: "room_001", name: "Conf A" }],
            zones: [],
            floors: [],
          },
          {
            __typename: "Tag",
            id: "tag_zone_x",
            name: "zone-x",
            organization_id: "org_001",
            rooms: [],
            zones: [{ __typename: "Zone", id: "zone_001", name: "Reception" }],
            floors: [],
          },
        ],
      };
      setupTagFilteredMocks(multiTypeTags);

      // floor-x ∩ room-x = {room_001 + descendants} (room_001 in floor closure)
      // ∩ zone-x = ?  zone-x's closure is {zone_001}; room_001's subtree
      // doesn't include zone_001 (different room). The 3-way intersection
      // is empty. This locks the per-tag-closure intersection semantics.
      const result = await executeListTopology({
        tag_names: ["floor-x", "room-x", "zone-x"],
        tag_match: "all",
        starting_depth: 0,
        traversal_depth: 10,
      });

      expect(result.tree).toEqual([]);
      // No tag_associations_*_ghost — every tag resolves to real entities.
      const kinds = (result.warnings ?? []).map((w) => w.kind);
      expect(kinds).not.toContain("tag_associations_all_ghost");
    });

    // tag_no_match standalone discriminant — locks the kind so a future
    // refactor that merges tag_no_match and tag_no_associations into one
    // diagnostic would fail.
    it("emits structured tag_no_match when every tag is unknown", async () => {
      setupTagsOnlyMock();

      const result = await executeListTopology({
        tag_names: ["does-not-exist", "also-not"],
        starting_depth: 0,
        traversal_depth: 10,
      });

      expect(result.tree).toEqual([]);
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "tag_no_match",
            unknown_names: ["does-not-exist", "also-not"],
          }),
        ])
      );
    });

    // Empty asset_ids array vs. omitted — should be behaviorally identical
    // (both fall through to "no asset filter"). A future refactor that
    // changes the gate from `assetIds.length > 0` to `assetIds !== undefined`
    // would break this, surfacing a misleading asset_scope_empty.
    it("treats asset_ids: [] the same as omitting asset_ids", async () => {
      setupFullTopologyMocks();

      const result = await executeListTopology({
        asset_ids: [],
        starting_depth: 0,
        traversal_depth: 0,
      });

      expect(result.tree).toHaveLength(1);
      expect(result.warnings ?? []).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: "asset_scope_empty" })])
      );
    });

    // partialResolvedCount must surface on tag_match_all_unsatisfiable so
    // the user can tell "1 of 2 unknown" from "0 of 2 unknown" (the
    // latter is tag_no_match anyway, but the count is useful diagnostic).
    it("emits partial_resolved_count on tag_match_all_unsatisfiable", async () => {
      setupTagsOnlyMock();

      const result = await executeListTopology({
        tag_names: ["huddle", "does-not-exist"],
        tag_match: "all",
        starting_depth: 0,
        traversal_depth: 10,
      });

      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "tag_match_all_unsatisfiable",
            unknown_names: ["does-not-exist"],
            partial_resolved_count: 1,
          }),
        ])
      );
    });
  });
});
