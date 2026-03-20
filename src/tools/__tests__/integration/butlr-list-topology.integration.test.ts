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

describe("butlr_list_topology - Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    it("returns empty tree when asset_ids match nothing", async () => {
      setupFullTopologyMocks();

      const result = await executeListTopology({
        asset_ids: ["room_nonexistent"],
        starting_depth: 0,
        traversal_depth: 10,
      });

      expect(result.tree).toHaveLength(0);
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
});
