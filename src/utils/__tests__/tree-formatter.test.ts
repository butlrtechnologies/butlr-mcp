import { describe, it, expect } from "vitest";
import { formatTopologyTree } from "../tree-formatter.js";
import type { Site } from "../../clients/types.js";
import type { TopologyNode } from "../../types/responses.js";

/**
 * Build a realistic topology fixture for tree-formatter tests.
 *
 * Hierarchy:
 *   site_1 "Test Site"
 *     building_1 "Building A"
 *       floor_1 "Floor 1"
 *         room_1 "Room A"
 *           zone_1 "Zone X"         (room-level zone, roomID = room_1)
 *           sensor_1 aa:bb:...:01   (hive HIVE-001, room room_1)
 *         room_2 "Room B"
 *           sensor_2 aa:bb:...:02   (hive HIVE-001, room room_2)
 *         zone_2 "Zone Y"           (floor-level zone, no roomID)
 *         hive_1 "HIVE-001"
 *           sensor_1, sensor_2
 *         orphan sensor_3 aa:bb:...:03  (hive_serial = "UNKNOWN", no room)
 */
function createTestTopology(): Site[] {
  return [
    {
      id: "site_1",
      name: "Test Site",
      buildings: [
        {
          id: "building_1",
          name: "Building A",
          site_id: "site_1",
          floors: [
            {
              id: "floor_1",
              name: "Floor 1",
              building_id: "building_1",
              rooms: [
                { id: "room_1", name: "Room A", floorID: "floor_1" },
                { id: "room_2", name: "Room B", floorID: "floor_1" },
              ],
              zones: [
                { id: "zone_1", name: "Zone X", floorID: "floor_1", roomID: "room_1" },
                { id: "zone_2", name: "Zone Y", floorID: "floor_1" }, // floor-level zone
              ],
              hives: [{ id: "hive_1", serialNumber: "HIVE-001", floorID: "floor_1" }],
              sensors: [
                {
                  id: "sensor_1",
                  mac_address: "aa:bb:cc:dd:ee:01",
                  hive_serial: "HIVE-001",
                  roomID: "room_1",
                },
                {
                  id: "sensor_2",
                  mac_address: "aa:bb:cc:dd:ee:02",
                  hive_serial: "HIVE-001",
                  roomID: "room_2",
                },
                {
                  id: "sensor_3",
                  mac_address: "aa:bb:cc:dd:ee:03",
                  hive_serial: "UNKNOWN", // orphan — no matching hive
                },
              ],
            },
          ],
        },
      ],
    },
  ] as any;
}

/**
 * Build a multi-site topology for edge cases.
 */
function createMultiSiteTopology(): Site[] {
  return [
    {
      id: "site_1",
      name: "Site Alpha",
      buildings: [
        {
          id: "bldg_1",
          name: "Alpha HQ",
          site_id: "site_1",
          floors: [
            {
              id: "floor_a1",
              name: "Floor A1",
              building_id: "bldg_1",
              rooms: [{ id: "room_a1", name: "Room A1", floorID: "floor_a1" }],
              zones: [],
              hives: [],
              sensors: [],
            },
          ],
        },
      ],
    },
    {
      id: "site_2",
      name: "Site Beta",
      buildings: [
        {
          id: "bldg_2",
          name: "Beta Office",
          site_id: "site_2",
          floors: [
            {
              id: "floor_b1",
              name: "Floor B1",
              building_id: "bldg_2",
              rooms: [{ id: "room_b1", name: "Room B1", floorID: "floor_b1" }],
              zones: [],
              hives: [],
              sensors: [],
            },
          ],
        },
      ],
    },
  ] as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("formatTopologyTree", () => {
  const sites = createTestTopology();

  // -------------------------------------------------------------------------
  // 1. Basic formatting — sites only
  // -------------------------------------------------------------------------
  describe("sites only (startingDepth=0, traversalDepth=0)", () => {
    it("returns sites without children", () => {
      const result = formatTopologyTree(sites, 0, 0);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(["site_1", "Test Site"]);
      // Two-element tuple — no children slot
      expect((result[0] as any).length).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Full tree traversal
  // -------------------------------------------------------------------------
  describe("full tree (startingDepth=0, traversalDepth=10)", () => {
    it("includes all levels down to sensors", () => {
      const result = formatTopologyTree(sites, 0, 10);

      // Root should be a single site with children
      expect(result).toHaveLength(1);
      const [siteId, siteName, siteChildren] = result[0] as [string, string, TopologyNode[]];
      expect(siteId).toBe("site_1");
      expect(siteName).toBe("Test Site");
      expect(siteChildren).toBeDefined();

      // Building level
      expect(siteChildren).toHaveLength(1);
      const [bldgId, bldgName, bldgChildren] = siteChildren[0] as [string, string, TopologyNode[]];
      expect(bldgId).toBe("building_1");
      expect(bldgName).toBe("Building A");
      expect(bldgChildren).toBeDefined();

      // Floor level
      expect(bldgChildren).toHaveLength(1);
      const [floorId, floorName, floorChildren] = bldgChildren[0] as [
        string,
        string,
        TopologyNode[],
      ];
      expect(floorId).toBe("floor_1");
      expect(floorName).toBe("Floor 1");
      expect(floorChildren).toBeDefined();

      // Floor children: 2 rooms + 1 floor-level zone + 1 hive + 1 orphan group
      expect(floorChildren.length).toBe(5);

      // Rooms
      const roomA = floorChildren[0] as [string, string, TopologyNode[]];
      expect(roomA[0]).toBe("room_1");
      expect(roomA[1]).toBe("Room A");

      const roomB = floorChildren[1] as [string, string, TopologyNode[]];
      expect(roomB[0]).toBe("room_2");
      expect(roomB[1]).toBe("Room B");

      // Floor-level zone (Zone Y has no roomID)
      const floorZone = floorChildren[2] as [string, string];
      expect(floorZone).toEqual(["zone_2", "Zone Y"]);

      // Hive
      const hive = floorChildren[3] as [string, string, TopologyNode[]];
      expect(hive[0]).toBe("hive_1");
      expect(hive[1]).toBe("HIVE-001");

      // Orphan group
      const orphanGroup = floorChildren[4] as [string, string, TopologyNode[]];
      expect(orphanGroup[0]).toBe("orphan");
      expect(orphanGroup[1]).toBe("Orphan (no parent hive)");
    });

    it("nests room-level zone inside its room", () => {
      const result = formatTopologyTree(sites, 0, 10);
      const siteChildren = (result[0] as [string, string, TopologyNode[]])[2];
      const bldgChildren = (siteChildren[0] as [string, string, TopologyNode[]])[2];
      const floorChildren = (bldgChildren[0] as [string, string, TopologyNode[]])[2];

      // Room A should contain zone_1
      const roomA = floorChildren[0] as [string, string, TopologyNode[]];
      const roomAChildren = roomA[2];
      expect(roomAChildren).toBeDefined();

      const zoneInRoom = roomAChildren.find((child) => child[0] === "zone_1");
      expect(zoneInRoom).toEqual(["zone_1", "Zone X"]);
    });

    it("nests sensors under their parent hive", () => {
      const result = formatTopologyTree(sites, 0, 10);
      const siteChildren = (result[0] as [string, string, TopologyNode[]])[2];
      const bldgChildren = (siteChildren[0] as [string, string, TopologyNode[]])[2];
      const floorChildren = (bldgChildren[0] as [string, string, TopologyNode[]])[2];

      // Hive at index 3
      const hive = floorChildren[3] as [string, string, TopologyNode[]];
      expect(hive[0]).toBe("hive_1");
      expect(hive[1]).toBe("HIVE-001");
      const hiveSensors = hive[2];
      expect(hiveSensors).toHaveLength(2);
      expect(hiveSensors[0]).toEqual(["sensor_1", "aa:bb:cc:dd:ee:01"]);
      expect(hiveSensors[1]).toEqual(["sensor_2", "aa:bb:cc:dd:ee:02"]);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Starting at depth 1 (buildings)
  // -------------------------------------------------------------------------
  describe("buildings only (startingDepth=1, traversalDepth=0)", () => {
    it("returns a flat list of buildings", () => {
      const result = formatTopologyTree(sites, 1, 0);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(["building_1", "Building A"]);
      expect((result[0] as any).length).toBe(2);
    });

    it("collects buildings across multiple sites", () => {
      const multiSites = createMultiSiteTopology();
      const result = formatTopologyTree(multiSites, 1, 0);

      expect(result).toHaveLength(2);
      expect(result[0][0]).toBe("bldg_1");
      expect(result[1][0]).toBe("bldg_2");
    });
  });

  // -------------------------------------------------------------------------
  // 4. Starting at depth 2 (floors)
  // -------------------------------------------------------------------------
  describe("floors only (startingDepth=2, traversalDepth=0)", () => {
    it("returns a flat list of floors", () => {
      const result = formatTopologyTree(sites, 2, 0);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(["floor_1", "Floor 1"]);
      expect((result[0] as any).length).toBe(2);
    });

    it("collects floors from all buildings across all sites", () => {
      const multiSites = createMultiSiteTopology();
      const result = formatTopologyTree(multiSites, 2, 0);

      expect(result).toHaveLength(2);
      expect(result[0][0]).toBe("floor_a1");
      expect(result[1][0]).toBe("floor_b1");
    });
  });

  // -------------------------------------------------------------------------
  // 5. Floors with one level below
  // -------------------------------------------------------------------------
  describe("floors + rooms (startingDepth=2, traversalDepth=1)", () => {
    it("shows floors with rooms and floor-level zones as children", () => {
      const result = formatTopologyTree(sites, 2, 1);

      expect(result).toHaveLength(1);
      const [floorId, floorName, floorChildren] = result[0] as [string, string, TopologyNode[]];
      expect(floorId).toBe("floor_1");
      expect(floorName).toBe("Floor 1");
      expect(floorChildren).toBeDefined();

      // Children should be rooms + floor-level zones + floor-level hives
      // (but NOT orphan sensors, because sensor depth 5 is > startingDepth 2 + traversalDepth 1)
      const ids = floorChildren.map((c) => c[0]);
      expect(ids).toContain("room_1");
      expect(ids).toContain("room_2");
      expect(ids).toContain("zone_2"); // floor-level zone
    });

    it("does not include room children when traversalDepth limits to 1 level below floors", () => {
      const result = formatTopologyTree(sites, 2, 1);
      const floorChildren = (result[0] as [string, string, TopologyNode[]])[2];
      const roomA = floorChildren.find((c) => c[0] === "room_1") as TopologyNode;

      // Room should be a leaf (2-element tuple) — no children
      expect(roomA.length).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Flat list of rooms
  // -------------------------------------------------------------------------
  describe("rooms/zones flat (startingDepth=3, traversalDepth=0)", () => {
    it("returns rooms and zones from all floors", () => {
      const result = formatTopologyTree(sites, 3, 0);

      // 2 rooms + 2 zones = 4 items
      expect(result).toHaveLength(4);

      const ids = result.map((n) => n[0]);
      expect(ids).toContain("room_1");
      expect(ids).toContain("room_2");
      expect(ids).toContain("zone_1");
      expect(ids).toContain("zone_2");
    });

    it("returns rooms without children", () => {
      const result = formatTopologyTree(sites, 3, 0);
      const room = result.find((n) => n[0] === "room_1")!;
      expect(room.length).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Flat list of sensors
  // -------------------------------------------------------------------------
  describe("sensors flat (startingDepth=5, traversalDepth=0)", () => {
    it("returns all sensors as flat list", () => {
      const result = formatTopologyTree(sites, 5, 0);

      expect(result).toHaveLength(3);
      const ids = result.map((n) => n[0]);
      expect(ids).toContain("sensor_1");
      expect(ids).toContain("sensor_2");
      expect(ids).toContain("sensor_3");
    });

    it("formats each sensor as [id, mac_address]", () => {
      const result = formatTopologyTree(sites, 5, 0);
      const s1 = result.find((n) => n[0] === "sensor_1")!;
      expect(s1).toEqual(["sensor_1", "aa:bb:cc:dd:ee:01"]);
    });
  });

  // -------------------------------------------------------------------------
  // 8. Empty arrays
  // -------------------------------------------------------------------------
  describe("empty arrays", () => {
    it("handles a site with no buildings", () => {
      const emptySite = [{ id: "site_empty", name: "Empty Site", buildings: [] }] as any;
      const result = formatTopologyTree(emptySite, 0, 10);

      expect(result).toHaveLength(1);
      // No children slot when buildings array is empty
      expect(result[0]).toEqual(["site_empty", "Empty Site"]);
      expect(result[0].length).toBe(2);
    });

    it("handles a building with no floors", () => {
      const noFloors = [
        {
          id: "site_1",
          name: "S",
          buildings: [{ id: "bldg_1", name: "B", site_id: "site_1", floors: [] }],
        },
      ] as any;
      const result = formatTopologyTree(noFloors, 0, 10);

      const siteChildren = (result[0] as [string, string, TopologyNode[]])[2];
      expect(siteChildren).toHaveLength(1);
      // Building has no children
      expect(siteChildren[0]).toEqual(["bldg_1", "B"]);
      expect(siteChildren[0].length).toBe(2);
    });

    it("handles a floor with no rooms, zones, hives, or sensors", () => {
      const bareFloor = [
        {
          id: "site_1",
          name: "S",
          buildings: [
            {
              id: "bldg_1",
              name: "B",
              site_id: "site_1",
              floors: [
                {
                  id: "floor_1",
                  name: "F",
                  building_id: "bldg_1",
                  rooms: [],
                  zones: [],
                  hives: [],
                  sensors: [],
                },
              ],
            },
          ],
        },
      ] as any;
      const result = formatTopologyTree(bareFloor, 0, 10);

      const siteChildren = (result[0] as [string, string, TopologyNode[]])[2];
      const bldgChildren = (siteChildren[0] as [string, string, TopologyNode[]])[2];
      // Floor is a leaf
      expect(bldgChildren[0]).toEqual(["floor_1", "F"]);
      expect(bldgChildren[0].length).toBe(2);
    });

    it("returns empty array when no buildings exist at depth 1", () => {
      const noBuildings = [{ id: "s", name: "S", buildings: [] }] as any;
      const result = formatTopologyTree(noBuildings, 1, 0);
      expect(result).toEqual([]);
    });

    it("returns empty array when no floors exist at depth 2", () => {
      const noFloors = [
        {
          id: "s",
          name: "S",
          buildings: [{ id: "b", name: "B", site_id: "s", floors: [] }],
        },
      ] as any;
      const result = formatTopologyTree(noFloors, 2, 0);
      expect(result).toEqual([]);
    });

    it("returns empty array for empty sites input", () => {
      const result = formatTopologyTree([] as any, 0, 0);
      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // 9. Hive-sensor nesting
  // -------------------------------------------------------------------------
  describe("hive-sensor nesting", () => {
    it("nests sensors under their parent hive at depth 4->5", () => {
      // Start at hives (depth 4) with 1 level of traversal to include sensors
      const result = formatTopologyTree(sites, 4, 1);

      expect(result).toHaveLength(1);
      const [hiveId, hiveSerial, hiveSensors] = result[0] as [string, string, TopologyNode[]];
      expect(hiveId).toBe("hive_1");
      expect(hiveSerial).toBe("HIVE-001");
      expect(hiveSensors).toBeDefined();
      expect(hiveSensors).toHaveLength(2);
      expect(hiveSensors[0]).toEqual(["sensor_1", "aa:bb:cc:dd:ee:01"]);
      expect(hiveSensors[1]).toEqual(["sensor_2", "aa:bb:cc:dd:ee:02"]);
    });

    it("returns hives without children when traversalDepth is 0", () => {
      const result = formatTopologyTree(sites, 4, 0);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(["hive_1", "HIVE-001"]);
      expect(result[0].length).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // 10. Orphan sensors
  // -------------------------------------------------------------------------
  describe("orphan sensors", () => {
    it("groups orphan sensors under an orphan node at floor level", () => {
      const result = formatTopologyTree(sites, 0, 10);
      const siteChildren = (result[0] as [string, string, TopologyNode[]])[2];
      const bldgChildren = (siteChildren[0] as [string, string, TopologyNode[]])[2];
      const floorChildren = (bldgChildren[0] as [string, string, TopologyNode[]])[2];

      const orphanGroup = floorChildren.find((c) => c[0] === "orphan") as [
        string,
        string,
        TopologyNode[],
      ];
      expect(orphanGroup).toBeDefined();
      expect(orphanGroup[0]).toBe("orphan");
      expect(orphanGroup[1]).toBe("Orphan (no parent hive)");
      expect(orphanGroup[2]).toHaveLength(1);
      expect(orphanGroup[2][0]).toEqual(["sensor_3", "aa:bb:cc:dd:ee:03"]);
    });

    it("identifies sensor with non-matching hive_serial as orphan", () => {
      // sensor_3 has hive_serial "UNKNOWN" which does not match any hive's serialNumber
      const result = formatTopologyTree(sites, 0, 10);
      const siteChildren = (result[0] as [string, string, TopologyNode[]])[2];
      const bldgChildren = (siteChildren[0] as [string, string, TopologyNode[]])[2];
      const floorChildren = (bldgChildren[0] as [string, string, TopologyNode[]])[2];

      const orphanGroup = floorChildren.find((c) => c[0] === "orphan") as [
        string,
        string,
        TopologyNode[],
      ];
      const orphanSensorIds = orphanGroup[2].map((s) => s[0]);
      expect(orphanSensorIds).toContain("sensor_3");
      // Sensors with a matching hive should NOT be in the orphan group
      expect(orphanSensorIds).not.toContain("sensor_1");
      expect(orphanSensorIds).not.toContain("sensor_2");
    });

    it("places room-scoped orphan sensors inside that room", () => {
      // Create topology where an orphan sensor has a roomID
      const topo = [
        {
          id: "site_1",
          name: "S",
          buildings: [
            {
              id: "b1",
              name: "B",
              site_id: "site_1",
              floors: [
                {
                  id: "f1",
                  name: "F",
                  building_id: "b1",
                  rooms: [{ id: "r1", name: "R", floorID: "f1" }],
                  zones: [],
                  hives: [{ id: "h1", serialNumber: "H-100", floorID: "f1" }],
                  sensors: [
                    {
                      id: "s_orphan_room",
                      mac_address: "ff:ff:ff:ff:ff:01",
                      hive_serial: "NO-MATCH",
                      roomID: "r1",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ] as any;

      const result = formatTopologyTree(topo, 0, 10);
      const siteChildren = (result[0] as [string, string, TopologyNode[]])[2];
      const bldgChildren = (siteChildren[0] as [string, string, TopologyNode[]])[2];
      const floorChildren = (bldgChildren[0] as [string, string, TopologyNode[]])[2];

      // Room R should have an orphan group
      const roomR = floorChildren.find((c) => c[0] === "r1") as [string, string, TopologyNode[]];
      expect(roomR[2]).toBeDefined();
      const roomOrphan = roomR[2].find((c) => c[0] === "orphan") as [
        string,
        string,
        TopologyNode[],
      ];
      expect(roomOrphan).toBeDefined();
      expect(roomOrphan[2][0]).toEqual(["s_orphan_room", "ff:ff:ff:ff:ff:01"]);
    });

    it("does not include orphan group when no orphan sensors exist", () => {
      const noOrphansTopo = [
        {
          id: "site_1",
          name: "S",
          buildings: [
            {
              id: "b1",
              name: "B",
              site_id: "site_1",
              floors: [
                {
                  id: "f1",
                  name: "F",
                  building_id: "b1",
                  rooms: [],
                  zones: [],
                  hives: [{ id: "h1", serialNumber: "H-100", floorID: "f1" }],
                  sensors: [
                    {
                      id: "s1",
                      mac_address: "aa:bb:cc:dd:ee:01",
                      hive_serial: "H-100",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ] as any;

      const result = formatTopologyTree(noOrphansTopo, 0, 10);
      const siteChildren = (result[0] as [string, string, TopologyNode[]])[2];
      const bldgChildren = (siteChildren[0] as [string, string, TopologyNode[]])[2];
      const floorChildren = (bldgChildren[0] as [string, string, TopologyNode[]])[2];

      const orphanGroup = floorChildren.find((c) => c[0] === "orphan");
      expect(orphanGroup).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // 11. Floor-level zones
  // -------------------------------------------------------------------------
  describe("floor-level zones", () => {
    it("zones without roomID appear at floor level, not inside a room", () => {
      const result = formatTopologyTree(sites, 0, 10);
      const siteChildren = (result[0] as [string, string, TopologyNode[]])[2];
      const bldgChildren = (siteChildren[0] as [string, string, TopologyNode[]])[2];
      const floorChildren = (bldgChildren[0] as [string, string, TopologyNode[]])[2];

      // Zone Y (no roomID) should be a direct child of the floor
      const floorChildIds = floorChildren.map((c) => c[0]);
      expect(floorChildIds).toContain("zone_2");

      // Zone Y should NOT be inside any room
      const rooms = floorChildren.filter((c) => c[0] === "room_1" || c[0] === "room_2") as [
        string,
        string,
        TopologyNode[],
      ][];

      for (const room of rooms) {
        if (room[2]) {
          const childIds = room[2].map((c) => c[0]);
          expect(childIds).not.toContain("zone_2");
        }
      }
    });
  });

  // -------------------------------------------------------------------------
  // 12. Room-level zones
  // -------------------------------------------------------------------------
  describe("room-level zones", () => {
    it("zones with roomID appear inside their matching room", () => {
      const result = formatTopologyTree(sites, 0, 10);
      const siteChildren = (result[0] as [string, string, TopologyNode[]])[2];
      const bldgChildren = (siteChildren[0] as [string, string, TopologyNode[]])[2];
      const floorChildren = (bldgChildren[0] as [string, string, TopologyNode[]])[2];

      // Room A should contain zone_1
      const roomA = floorChildren.find((c) => c[0] === "room_1") as [
        string,
        string,
        TopologyNode[],
      ];
      expect(roomA[2]).toBeDefined();
      const zoneInRoom = roomA[2].find((c) => c[0] === "zone_1");
      expect(zoneInRoom).toBeDefined();
      expect(zoneInRoom).toEqual(["zone_1", "Zone X"]);
    });

    it("zone with roomID does not appear at floor level", () => {
      const result = formatTopologyTree(sites, 0, 10);
      const siteChildren = (result[0] as [string, string, TopologyNode[]])[2];
      const bldgChildren = (siteChildren[0] as [string, string, TopologyNode[]])[2];
      const floorChildren = (bldgChildren[0] as [string, string, TopologyNode[]])[2];

      // Direct floor children should NOT include zone_1 (it has roomID=room_1)
      const directFloorChildIds = floorChildren.map((c) => c[0]);
      expect(directFloorChildIds).not.toContain("zone_1");
    });
  });

  // -------------------------------------------------------------------------
  // 13. Sensor display uses mac_address
  // -------------------------------------------------------------------------
  describe("sensor display format", () => {
    it("sensors show [id, mac_address] not [id, name]", () => {
      const result = formatTopologyTree(sites, 5, 0);

      for (const node of result) {
        // Position 1 should be a mac address, not a name like "Sensor 1"
        expect(node[1]).toMatch(/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/);
      }
    });

    it("sensor in full tree uses mac_address as display identifier", () => {
      const result = formatTopologyTree(sites, 0, 10);
      const siteChildren = (result[0] as [string, string, TopologyNode[]])[2];
      const bldgChildren = (siteChildren[0] as [string, string, TopologyNode[]])[2];
      const floorChildren = (bldgChildren[0] as [string, string, TopologyNode[]])[2];

      // Get hive's sensors
      const hive = floorChildren.find((c) => c[0] === "hive_1") as [string, string, TopologyNode[]];
      const hiveSensors = hive[2];

      expect(hiveSensors[0][1]).toBe("aa:bb:cc:dd:ee:01");
      expect(hiveSensors[1][1]).toBe("aa:bb:cc:dd:ee:02");
    });
  });

  // -------------------------------------------------------------------------
  // 14. Hive display uses serialNumber
  // -------------------------------------------------------------------------
  describe("hive display format", () => {
    it("hives show [id, serialNumber] not [id, name]", () => {
      const result = formatTopologyTree(sites, 4, 0);

      expect(result).toHaveLength(1);
      expect(result[0][0]).toBe("hive_1");
      expect(result[0][1]).toBe("HIVE-001");
    });

    it("hive in full tree uses serialNumber as display identifier", () => {
      const result = formatTopologyTree(sites, 0, 10);
      const siteChildren = (result[0] as [string, string, TopologyNode[]])[2];
      const bldgChildren = (siteChildren[0] as [string, string, TopologyNode[]])[2];
      const floorChildren = (bldgChildren[0] as [string, string, TopologyNode[]])[2];

      const hive = floorChildren.find((c) => c[0] === "hive_1")!;
      expect(hive[1]).toBe("HIVE-001");
    });
  });

  // -------------------------------------------------------------------------
  // Additional edge-case coverage
  // -------------------------------------------------------------------------
  describe("depth traversal boundaries", () => {
    it("sites with traversalDepth=1 shows buildings but not floors", () => {
      const result = formatTopologyTree(sites, 0, 1);

      const [, , siteChildren] = result[0] as [string, string, TopologyNode[]];
      expect(siteChildren).toBeDefined();
      expect(siteChildren).toHaveLength(1);

      // Building should be a leaf
      expect(siteChildren[0]).toEqual(["building_1", "Building A"]);
      expect(siteChildren[0].length).toBe(2);
    });

    it("sites with traversalDepth=2 shows buildings and floors but not rooms", () => {
      const result = formatTopologyTree(sites, 0, 2);

      const siteChildren = (result[0] as [string, string, TopologyNode[]])[2];
      const building = siteChildren[0] as [string, string, TopologyNode[]];
      expect(building[2]).toBeDefined();
      expect(building[2]).toHaveLength(1);

      // Floor should be a leaf
      expect(building[2][0]).toEqual(["floor_1", "Floor 1"]);
      expect(building[2][0].length).toBe(2);
    });

    it("buildings with traversalDepth=2 shows floors with rooms", () => {
      const result = formatTopologyTree(sites, 1, 2);

      const building = result[0] as [string, string, TopologyNode[]];
      expect(building[2]).toBeDefined();

      const floor = building[2][0] as [string, string, TopologyNode[]];
      expect(floor[2]).toBeDefined();

      // Floor children should include rooms and floor-level zones
      const ids = floor[2].map((c) => c[0]);
      expect(ids).toContain("room_1");
      expect(ids).toContain("room_2");
    });
  });

  describe("undefined optional arrays", () => {
    it("handles undefined rooms, zones, hives, sensors on a floor", () => {
      const topo = [
        {
          id: "s",
          name: "S",
          buildings: [
            {
              id: "b",
              name: "B",
              site_id: "s",
              floors: [
                {
                  id: "f",
                  name: "F",
                  building_id: "b",
                  // rooms, zones, hives, sensors all undefined
                },
              ],
            },
          ],
        },
      ] as any;

      const result = formatTopologyTree(topo, 0, 10);
      const siteChildren = (result[0] as [string, string, TopologyNode[]])[2];
      const bldgChildren = (siteChildren[0] as [string, string, TopologyNode[]])[2];

      // Floor should be a leaf (no children to show)
      expect(bldgChildren[0]).toEqual(["f", "F"]);
      expect(bldgChildren[0].length).toBe(2);
    });

    it("handles undefined buildings on a site", () => {
      const topo = [{ id: "s", name: "S" }] as any;
      const result = formatTopologyTree(topo, 0, 10);
      expect(result).toEqual([["s", "S"]]);
    });

    it("handles undefined floors on a building", () => {
      const topo = [
        {
          id: "s",
          name: "S",
          buildings: [{ id: "b", name: "B", site_id: "s" }],
        },
      ] as any;
      const result = formatTopologyTree(topo, 0, 10);
      const siteChildren = (result[0] as [string, string, TopologyNode[]])[2];
      expect(siteChildren[0]).toEqual(["b", "B"]);
    });
  });

  describe("default parameters", () => {
    it("defaults startingDepth to 0 and traversalDepth to 0", () => {
      const result = formatTopologyTree(sites);
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(["site_1", "Test Site"]);
      expect(result[0].length).toBe(2);
    });
  });
});
