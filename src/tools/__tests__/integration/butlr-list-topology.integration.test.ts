import { describe, it, expect, beforeEach, vi } from "vitest";
import { executeListTopology } from "../../butlr-list-topology.js";
import { apolloClient } from "../../../clients/graphql-client.js";
import { clearTopologyCache } from "../../../cache/topology-cache.js";

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
 * topology. Queues only the tags fetch — queuing more would leak into the
 * next test because `vi.clearAllMocks()` doesn't drain the
 * `mockResolvedValueOnce` queue.
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
      // Per R3 §2: the warning helps the LLM distinguish typo'd asset_ids
      // from a genuinely empty subtree.
      expect(result.warning).toMatch(/asset_ids matched no entities/i);
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
      // Existing filterTopologyByAssets keeps any subtree containing a match,
      // so Floor 1 stays with all its children.
      const ids = flattenIds(result.tree);
      expect(ids).toContain("room_001");
      expect(ids).toContain("zone_001");
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

    // Per R1 §2.3: 3-tag intersection exercises the fold loop in
    // collectTaggedEntityIds at i >= 2 — a 2-tag test only exercises i=1.
    // Designed so the third tag is load-bearing: focus ∩ broad already
    // contains room_003, and only the third tag (executive) prunes it.
    // A fence-post that skips i=2 leaves room_003 in and pulls Floor 2 in.
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

    // Per R1 §2.2: an upstream that returns a dangling { id: null } in a
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
      setupTagFilteredMocks();

      const result = await executeListTopology({
        tag_names: ["unused"],
        starting_depth: 0,
        traversal_depth: 10,
      });

      expect(result.tree).toEqual([]);
      expect(result.warning).toMatch(/No rooms, zones, or floors are currently tagged/i);
    });

    // Per R4: when a tag sits on an ANCESTOR of an asset_ids entry, the
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

    // Per R4: sensor/hive asset_ids must compose against floor-level tags.
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

    // Per R4: a tag on a room implicitly covers devices bound to that
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

    // Per R3 §1: leaf-level asset_ids must AND with tag_names strictly.
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

    // Per R3 §2: invalid asset_ids must surface a clearer warning, not the
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

    // Per R1 §2.4: tag matches a room outside the asset_ids scope, no overlap.
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
      // Per R1 §2.7.2: disjoint scopes yield an explanatory warning so the
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
  });
});
