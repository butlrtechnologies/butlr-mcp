import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { executeTrafficFlow } from "../../butlr-traffic-flow.js";
import { apolloClient } from "../../../clients/graphql-client.js";
import * as reportingClient from "../../../clients/reporting-client.js";
import * as searchAssets from "../../butlr-search-assets.js";
import { loadReportingFixture } from "../../../__mocks__/reporting-client.js";

// Mock the clients
vi.mock("../../../clients/graphql-client.js", () => ({
  apolloClient: {
    query: vi.fn(),
  },
}));

vi.mock("../../../clients/reporting-client.js", async () => {
  const actual = await vi.importActual<typeof import("../../../clients/reporting-client.js")>(
    "../../../clients/reporting-client.js"
  );
  return {
    ...actual,
    ReportingRequestBuilder: actual.ReportingRequestBuilder,
  };
});

vi.mock("../../butlr-search-assets.js", async () => {
  const actual = await vi.importActual<typeof import("../../butlr-search-assets.js")>(
    "../../butlr-search-assets.js"
  );
  return {
    ...actual,
    executeSearchAssets: vi.fn(),
  };
});

// Deterministic topology mock with explicit timezone (America/Los_Angeles)
const MOCK_TOPOLOGY = {
  sites: {
    data: [
      {
        id: "site_test",
        name: "Test Site",
        timezone: "America/Los_Angeles", // Explicit, deterministic timezone
        buildings: [
          {
            id: "building_test",
            name: "Test Building",
            site_id: "site_test",
            floors: [
              {
                id: "floor_test",
                name: "Test Floor",
                building_id: "building_test",
                rooms: [
                  {
                    id: "room_test",
                    name: "Test Room",
                  },
                  {
                    id: "room_lobby",
                    name: "Main Lobby",
                  },
                  {
                    id: "room_meeting",
                    name: "Meeting Room",
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

const MOCK_SENSORS = {
  sensors: {
    data: [
      { id: "sensor_1", mode: "traffic", room_id: "room_test", is_entrance: false },
      { id: "sensor_2", mode: "traffic", room_id: "room_lobby", is_entrance: false },
      { id: "sensor_3", mode: "presence", room_id: "room_meeting", is_entrance: false },
    ],
  },
};

describe("butlr_traffic_flow - Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Room with traffic sensors", () => {
    it("returns traffic data for room by ID", async () => {
      // Mock all three queries: room, topology, sensors
      vi.mocked(apolloClient.query).mockImplementation((options: any) => {
        const queryString = options.query.loc?.source?.body || "";

        // Return room data
        if (queryString.includes("GetRoomSensors")) {
          return Promise.resolve({
            data: {
              room: {
                id: "room_lobby",
                name: "Main Lobby",
                floorID: "floor_test",
                sensors: [{ id: "sensor_2", mode: "traffic" }],
                floor: {
                  id: "floor_test",
                  name: "Test Floor",
                  building: { id: "building_test", name: "Test Building" },
                },
              },
            },
            loading: false,
            networkStatus: 7,
          } as any);
        }

        // Return topology data
        if (queryString.includes("GetFullTopology")) {
          return Promise.resolve({
            data: MOCK_TOPOLOGY,
            loading: false,
            networkStatus: 7,
          } as any);
        }

        // Return sensors data
        if (queryString.includes("GetAllSensors")) {
          return Promise.resolve({
            data: MOCK_SENSORS,
            loading: false,
            networkStatus: 7,
          } as any);
        }

        return Promise.reject(new Error("Unknown query"));
      });

      // Use traffic fixture for realistic data
      const trafficFixture = loadReportingFixture("traffic-flow-today");

      // Mock reporting query to return fixture
      const mockExecute = vi.fn().mockResolvedValue(trafficFixture);
      vi.spyOn(reportingClient.ReportingRequestBuilder.prototype, "execute").mockImplementation(
        mockExecute
      );

      const result = await executeTrafficFlow({
        space_id_or_name: "room_lobby",
        time_window: "today",
      });

      expect(result.space.id).toBe("room_lobby");
      expect(result.space.name).toBe("Main Lobby");
      expect(result.traffic.total_traffic).toBeGreaterThanOrEqual(0);
      expect(result.summary).toContain("Main Lobby");
      expect(Array.isArray(result.hourly_breakdown)).toBe(true);
    });

    it("validates room has traffic sensors", async () => {
      // Mock room WITHOUT traffic sensors (only presence)
      vi.mocked(apolloClient.query).mockImplementation((options: any) => {
        const queryString = options.query.loc?.source?.body || "";

        if (queryString.includes("GetRoomSensors")) {
          return Promise.resolve({
            data: {
              room: {
                id: "room_meeting",
                name: "Meeting Room",
                floorID: "floor_test",
                sensors: [{ id: "sensor_3", mode: "presence" }], // Only presence
                floor: {
                  id: "floor_test",
                  name: "Test Floor",
                  building: { id: "building_test", name: "Test Building" },
                },
              },
            },
            loading: false,
            networkStatus: 7,
          } as any);
        }

        if (queryString.includes("GetFullTopology")) {
          return Promise.resolve({
            data: MOCK_TOPOLOGY,
            loading: false,
            networkStatus: 7,
          } as any);
        }

        if (queryString.includes("GetAllSensors")) {
          return Promise.resolve({
            data: MOCK_SENSORS,
            loading: false,
            networkStatus: 7,
          } as any);
        }

        return Promise.reject(new Error("Unknown query"));
      });

      await expect(
        executeTrafficFlow({
          space_id_or_name: "room_meeting",
        })
      ).rejects.toThrow("does not have traffic-mode sensors");
    });
  });

  describe("Time window presets", () => {
    beforeEach(() => {
      // Mock all three queries for time window tests
      vi.mocked(apolloClient.query).mockImplementation((options: any) => {
        const queryString = options.query.loc?.source?.body || "";

        if (queryString.includes("GetRoomSensors")) {
          return Promise.resolve({
            data: {
              room: {
                id: "room_test",
                name: "Test Room",
                floorID: "floor_test",
                sensors: [{ id: "sensor_1", mode: "traffic" }],
                floor: {
                  id: "floor_test",
                  name: "Test Floor",
                  building: { id: "building_test", name: "Test Building" },
                },
              },
            },
            loading: false,
            networkStatus: 7,
          } as any);
        }

        if (queryString.includes("GetFullTopology")) {
          return Promise.resolve({
            data: MOCK_TOPOLOGY,
            loading: false,
            networkStatus: 7,
          } as any);
        }

        if (queryString.includes("GetAllSensors")) {
          return Promise.resolve({
            data: MOCK_SENSORS,
            loading: false,
            networkStatus: 7,
          } as any);
        }

        return Promise.reject(new Error("Unknown query"));
      });
    });

    it("handles 20m time window", async () => {
      const mockExecute = vi.fn().mockResolvedValue({ data: [] });
      vi.spyOn(reportingClient.ReportingRequestBuilder.prototype, "execute").mockImplementation(
        mockExecute
      );

      const result = await executeTrafficFlow({
        space_id_or_name: "room_test",
        time_window: "20m",
      });

      expect(result.traffic.period.description).toBe("last 20 minutes");
    });

    it("handles 1h time window", async () => {
      const mockExecute = vi.fn().mockResolvedValue({ data: [] });
      vi.spyOn(reportingClient.ReportingRequestBuilder.prototype, "execute").mockImplementation(
        mockExecute
      );

      const result = await executeTrafficFlow({
        space_id_or_name: "room_test",
        time_window: "1h",
      });

      expect(result.traffic.period.description).toBe("last hour");
    });

    it("handles today time window", async () => {
      const mockExecute = vi.fn().mockResolvedValue({ data: [] });
      vi.spyOn(reportingClient.ReportingRequestBuilder.prototype, "execute").mockImplementation(
        mockExecute
      );

      const result = await executeTrafficFlow({
        space_id_or_name: "room_test",
        time_window: "today",
      });

      expect(result.traffic.period.description).toMatch(/today/);
    });
  });

  describe("Response structure", () => {
    it("includes all required fields", async () => {
      vi.mocked(apolloClient.query).mockImplementation((options: any) => {
        const queryString = options.query.loc?.source?.body || "";

        if (queryString.includes("GetRoomSensors")) {
          return Promise.resolve({
            data: {
              room: {
                id: "room_test",
                name: "Test Room",
                floorID: "floor_test",
                sensors: [{ id: "sensor_1", mode: "traffic" }],
                floor: {
                  id: "floor_test",
                  name: "Test Floor",
                  building: { id: "building_test", name: "Test Building" },
                },
              },
            },
            loading: false,
            networkStatus: 7,
          } as any);
        }

        if (queryString.includes("GetFullTopology")) {
          return Promise.resolve({
            data: MOCK_TOPOLOGY,
            loading: false,
            networkStatus: 7,
          } as any);
        }

        if (queryString.includes("GetAllSensors")) {
          return Promise.resolve({
            data: MOCK_SENSORS,
            loading: false,
            networkStatus: 7,
          } as any);
        }

        return Promise.reject(new Error("Unknown query"));
      });

      const mockExecute = vi.fn().mockResolvedValue({
        data: [
          { time: "2025-10-14T10:00:00Z", value: 10 },
          { time: "2025-10-14T11:00:00Z", value: 15 },
        ],
      });
      vi.spyOn(reportingClient.ReportingRequestBuilder.prototype, "execute").mockImplementation(
        mockExecute
      );

      const result = await executeTrafficFlow({
        space_id_or_name: "room_test",
      });

      expect(result.space).toBeDefined();
      expect(result.traffic).toBeDefined();
      expect(result.hourly_breakdown).toBeDefined();
      expect(result.summary).toBeDefined();
      expect(result.timestamp).toBeDefined();
    });

    it("calculates peak hour correctly", async () => {
      vi.mocked(apolloClient.query).mockImplementation((options: any) => {
        const queryString = options.query.loc?.source?.body || "";

        if (queryString.includes("GetRoomSensors")) {
          return Promise.resolve({
            data: {
              room: {
                id: "room_test",
                name: "Test Room",
                floorID: "floor_test",
                sensors: [{ id: "sensor_1", mode: "traffic" }],
                floor: {
                  id: "floor_test",
                  name: "Test Floor",
                  building: { id: "building_test", name: "Test Building" },
                },
              },
            },
            loading: false,
            networkStatus: 7,
          } as any);
        }

        if (queryString.includes("GetFullTopology")) {
          return Promise.resolve({
            data: MOCK_TOPOLOGY,
            loading: false,
            networkStatus: 7,
          } as any);
        }

        if (queryString.includes("GetAllSensors")) {
          return Promise.resolve({
            data: MOCK_SENSORS,
            loading: false,
            networkStatus: 7,
          } as any);
        }

        return Promise.reject(new Error("Unknown query"));
      });

      const mockExecute = vi.fn().mockResolvedValue({
        data: [
          { field: "in", sensor_id: "sensor_1", time: "2025-10-14T10:00:00Z", value: 10 },
          { field: "out", sensor_id: "sensor_1", time: "2025-10-14T10:00:00Z", value: 0 },
          { field: "in", sensor_id: "sensor_1", time: "2025-10-14T11:00:00Z", value: 25 }, // Peak
          { field: "out", sensor_id: "sensor_1", time: "2025-10-14T11:00:00Z", value: 0 },
          { field: "in", sensor_id: "sensor_1", time: "2025-10-14T12:00:00Z", value: 15 },
          { field: "out", sensor_id: "sensor_1", time: "2025-10-14T12:00:00Z", value: 0 },
        ],
      });
      vi.spyOn(reportingClient.ReportingRequestBuilder.prototype, "execute").mockImplementation(
        mockExecute
      );

      const result = await executeTrafficFlow({
        space_id_or_name: "room_test",
      });

      expect(result.traffic.total_traffic).toBe(50);
      expect(result.peak_hour.total_traffic).toBe(25);
    });
  });

  // Regression test for B2: room-level traffic used to filter `s.is_entrance === false`,
  // which dropped every traffic sensor at rooms whose sensors all happen to be entrances
  // (e.g. a cafe room that owns the floor's stairwell/elevator entrance sensors). The
  // Reporting API aggregates by room_id regardless — `is_entrance` is a semantic flag,
  // not a routing one. Floor-level traffic still uses `is_entrance === true`.
  describe("Regression: B2 — room-level traffic accepts is_entrance=true sensors", () => {
    it("returns traffic data when all room sensors have is_entrance=true", async () => {
      vi.mocked(apolloClient.query).mockImplementation((options: any) => {
        const queryString = options.query.loc?.source?.body || "";

        if (queryString.includes("GetRoomSensors")) {
          return Promise.resolve({
            data: {
              room: {
                id: "room_cafe",
                name: "MB2 Cafe",
                floorID: "floor_test",
                sensors: [{ id: "sensor_entrance_1", mode: "traffic" }],
                floor: {
                  id: "floor_test",
                  name: "Floor 2",
                  building: { id: "building_test", name: "MB2" },
                },
              },
            },
            loading: false,
            networkStatus: 7,
          } as any);
        }
        if (queryString.includes("GetFullTopology")) {
          return Promise.resolve({
            data: MOCK_TOPOLOGY,
            loading: false,
            networkStatus: 7,
          } as any);
        }
        if (queryString.includes("GetAllSensors")) {
          return Promise.resolve({
            data: {
              sensors: {
                data: [
                  // Every sensor is is_entrance=true — pre-fix the room-level
                  // traffic filter excluded these and the tool threw "does not
                  // have traffic-mode sensors".
                  {
                    id: "sensor_entrance_1",
                    mode: "traffic",
                    room_id: "room_cafe",
                    is_entrance: true,
                  },
                  {
                    id: "sensor_entrance_2",
                    mode: "traffic",
                    room_id: "room_cafe",
                    is_entrance: true,
                  },
                ],
              },
            },
            loading: false,
            networkStatus: 7,
          } as any);
        }
        return Promise.reject(new Error("Unknown query"));
      });

      const mockExecute = vi.fn().mockResolvedValue({
        data: [
          { field: "in", sensor_id: "sensor_entrance_1", time: "2025-10-14T10:00:00Z", value: 88 },
          { field: "out", sensor_id: "sensor_entrance_1", time: "2025-10-14T10:00:00Z", value: 8 },
          { field: "in", sensor_id: "sensor_entrance_2", time: "2025-10-14T10:00:00Z", value: 28 },
          { field: "out", sensor_id: "sensor_entrance_2", time: "2025-10-14T10:00:00Z", value: 66 },
        ],
      });
      vi.spyOn(reportingClient.ReportingRequestBuilder.prototype, "execute").mockImplementation(
        mockExecute
      );

      const result = await executeTrafficFlow({
        space_id_or_name: "room_cafe",
        time_window: "1h",
      });

      expect(result.traffic.sensor_count).toBe(2);
      expect(result.traffic.total_entries).toBe(116); // 88 + 28
      expect(result.traffic.total_exits).toBe(74); // 8 + 66
      expect(result.traffic.total_traffic).toBe(190);
    });
  });

  describe("Error handling", () => {
    it("throws validation error for empty space_id_or_name", async () => {
      // Note: Validation happens in MCP handler, not execute function
      // Direct calls with empty string will attempt to process and fail
      await expect(executeTrafficFlow({ space_id_or_name: "" })).rejects.toThrow();
    });

    it("throws error if room not found", async () => {
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: { room: null },
        loading: false,
        networkStatus: 7,
      } as any);

      await expect(executeTrafficFlow({ space_id_or_name: "room_nonexistent" })).rejects.toThrow(
        "Room room_nonexistent not found"
      );
    });
  });

  describe("Sensor-level queries", () => {
    const mockGraphQLTopologyAndSensors = (sensors: unknown[]) => {
      vi.mocked(apolloClient.query).mockImplementation((options: any) => {
        const queryString = options.query.loc?.source?.body || "";
        if (queryString.includes("GetFullTopology")) {
          return Promise.resolve({ data: MOCK_TOPOLOGY, loading: false, networkStatus: 7 } as any);
        }
        if (queryString.includes("GetAllSensors")) {
          return Promise.resolve({
            data: { sensors: { data: sensors } },
            loading: false,
            networkStatus: 7,
          } as any);
        }
        return Promise.reject(new Error(`Unexpected query for sensor path: ${queryString}`));
      });
    };

    it("queries a traffic sensor directly by ID without room resolution", async () => {
      mockGraphQLTopologyAndSensors([
        {
          id: "sensor_direct",
          name: "N. Elevator",
          mac_address: "aa:bb:cc:dd:ee:01",
          mode: "traffic",
          room_id: "room_test",
          floor_id: "floor_test",
          is_entrance: false,
        },
      ]);

      const assetsSpy = vi.spyOn(reportingClient.ReportingRequestBuilder.prototype, "assets");
      const mockExecute = vi.fn().mockResolvedValue({
        data: [
          { time: "2026-08-25T18:29:00Z", sensor_id: "sensor_direct", field: "in", value: 3 },
          { time: "2026-08-25T18:31:00Z", sensor_id: "sensor_direct", field: "out", value: 2 },
        ],
      });
      vi.spyOn(reportingClient.ReportingRequestBuilder.prototype, "execute").mockImplementation(
        mockExecute
      );

      const result = await executeTrafficFlow({
        space_id_or_name: "sensor_direct",
        time_window: "1h",
      });

      expect(assetsSpy).toHaveBeenCalledWith("sensor", ["sensor_direct"]);
      expect(result.space.type).toBe("sensor");
      expect(result.space.name).toBe("N. Elevator");
      // Path includes the room segment, not just building > floor
      expect(result.space.path).toBe("Test Building > Test Floor > Test Room > N. Elevator");
      expect(result.traffic.sensor_count).toBe(1);
      expect(result.traffic.total_entries).toBe(3);
      expect(result.traffic.total_exits).toBe(2);
    });

    it("falls back to the floor timezone when the sensor's room_id is dangling", async () => {
      mockGraphQLTopologyAndSensors([
        {
          id: "sensor_dangling",
          name: "Old Door",
          mac_address: "aa:bb:cc:dd:ee:02",
          mode: "traffic",
          room_id: "room_deleted_long_ago",
          floor_id: "floor_test",
        },
      ]);

      const mockExecute = vi.fn().mockResolvedValue({ data: [] });
      vi.spyOn(reportingClient.ReportingRequestBuilder.prototype, "execute").mockImplementation(
        mockExecute
      );

      const result = await executeTrafficFlow({
        space_id_or_name: "sensor_dangling",
        time_window: "1h",
      });

      // Floor resolves via the topology (site tz), so no UTC fallback warning
      expect(result.space.site_timezone).toBe("America/Los_Angeles");
      expect(result.warning).toBeUndefined();
    });

    it("uses the sensor filter on the 1m tail query for long windows", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-25T19:30:00.000Z"));
      try {
        mockGraphQLTopologyAndSensors([
          {
            id: "sensor_direct",
            name: "N. Elevator",
            mac_address: "aa:bb:cc:dd:ee:01",
            mode: "traffic",
            room_id: "room_test",
            floor_id: "floor_test",
          },
        ]);

        const assetsSpy = vi.spyOn(reportingClient.ReportingRequestBuilder.prototype, "assets");
        const mockExecute = vi
          .fn()
          .mockResolvedValueOnce({
            data: [
              { time: "2026-08-25T19:00:00Z", sensor_id: "sensor_direct", field: "in", value: 5 },
            ],
          })
          .mockResolvedValueOnce({
            data: [
              { time: "2026-08-25T19:05:00Z", sensor_id: "sensor_direct", field: "in", value: 2 },
            ],
          });
        vi.spyOn(reportingClient.ReportingRequestBuilder.prototype, "execute").mockImplementation(
          mockExecute
        );

        const result = await executeTrafficFlow({
          space_id_or_name: "sensor_direct",
          time_window: "today",
        });

        expect(mockExecute).toHaveBeenCalledTimes(2);
        // Both the main and tail queries must filter by sensor, not room
        expect(assetsSpy).toHaveBeenNthCalledWith(1, "sensor", ["sensor_direct"]);
        expect(assetsSpy).toHaveBeenNthCalledWith(2, "sensor", ["sensor_direct"]);
        expect(result.traffic.total_entries).toBe(7);
      } finally {
        vi.useRealTimers();
      }
    });

    it("works for a traffic sensor with no room assigned", async () => {
      mockGraphQLTopologyAndSensors([
        {
          id: "sensor_orphan",
          name: "Dock Door",
          mac_address: "aa:bb:cc:dd:ee:03",
          mode: "traffic",
          room_id: "",
          floor_id: "",
        },
      ]);

      const mockExecute = vi.fn().mockResolvedValue({ data: [] });
      vi.spyOn(reportingClient.ReportingRequestBuilder.prototype, "execute").mockImplementation(
        mockExecute
      );

      const result = await executeTrafficFlow({
        space_id_or_name: "sensor_orphan",
        time_window: "1h",
      });

      expect(result.space.type).toBe("sensor");
      expect(result.space.name).toBe("Dock Door");
      // No room/floor → timezone falls back with a warning rather than failing
      expect(result.warning).toBeDefined();
    });

    it("rejects a presence-mode sensor with a helpful error", async () => {
      mockGraphQLTopologyAndSensors([
        {
          id: "sensor_presence",
          name: "Desk 12",
          mac_address: "aa:bb:cc:dd:ee:04",
          mode: "presence",
          room_id: "room_meeting",
        },
      ]);

      await expect(
        executeTrafficFlow({ space_id_or_name: "sensor_presence", time_window: "1h" })
      ).rejects.toThrow("presence-mode sensor");
    });

    it("rejects mirror/test devices with a clear error", async () => {
      mockGraphQLTopologyAndSensors([
        {
          id: "sensor_mirror",
          name: "Mirror 1",
          mac_address: "mi-rr-or-00-00-01",
          mode: "traffic",
          room_id: "",
        },
      ]);

      await expect(
        executeTrafficFlow({ space_id_or_name: "sensor_mirror", time_window: "1h" })
      ).rejects.toThrow("test/mirror device");
    });

    it("errors clearly when the sensor ID does not exist", async () => {
      mockGraphQLTopologyAndSensors([]);

      await expect(
        executeTrafficFlow({ space_id_or_name: "sensor_missing", time_window: "1h" })
      ).rejects.toThrow("Sensor sensor_missing not found");
    });
  });

  describe("ETL backend time semantics", () => {
    // Pinned to midday UTC (12:30 PT for the mocked site): the "today" range
    // is well over 2h, so the 1h + 1m-tail branch always runs. Without this,
    // runs between the site's local midnight and 02:00 flip the tool to the
    // single 1m query and the tail assertions go stale.
    const NOW = new Date("2026-08-05T19:30:00.000Z");

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const mockGraphQLForRoomTest = () => {
      vi.mocked(apolloClient.query).mockImplementation((options: any) => {
        const queryString = options.query.loc?.source?.body || "";
        if (queryString.includes("GetRoomSensors")) {
          return Promise.resolve({
            data: {
              room: {
                id: "room_test",
                name: "Test Room",
                floorID: "floor_test",
                sensors: [{ id: "sensor_1", mode: "traffic" }],
                floor: {
                  id: "floor_test",
                  name: "Test Floor",
                  building: { id: "building_test", name: "Test Building" },
                },
              },
            },
            loading: false,
            networkStatus: 7,
          } as any);
        }
        if (queryString.includes("GetFullTopology")) {
          return Promise.resolve({ data: MOCK_TOPOLOGY, loading: false, networkStatus: 7 } as any);
        }
        if (queryString.includes("GetAllSensors")) {
          return Promise.resolve({ data: MOCK_SENSORS, loading: false, networkStatus: 7 } as any);
        }
        return Promise.reject(new Error("Unknown query"));
      });
    };

    it("uses 1m buckets for short windows and rolls them up to end-labeled hours", async () => {
      mockGraphQLForRoomTest();

      const windowSpy = vi.spyOn(reportingClient.ReportingRequestBuilder.prototype, "window");
      const mockExecute = vi.fn().mockResolvedValue({
        data: [
          { time: "2026-08-05T17:29:00Z", sensor_id: "sensor_1", field: "in", value: 1 },
          { time: "2026-08-05T17:31:00Z", sensor_id: "sensor_1", field: "out", value: 1 },
        ],
      });
      vi.spyOn(reportingClient.ReportingRequestBuilder.prototype, "execute").mockImplementation(
        mockExecute
      );

      const result = await executeTrafficFlow({
        space_id_or_name: "room_test",
        time_window: "1h",
      });

      expect(windowSpy).toHaveBeenCalledWith("1m", "sum", expect.any(String));
      expect(result.traffic.total_entries).toBe(1);
      expect(result.traffic.total_exits).toBe(1);
      // Both 1m buckets roll up into the single end-labeled hour 18:00
      expect(result.hourly_breakdown).toHaveLength(1);
      expect(result.hourly_breakdown[0].hour_utc).toBe("2026-08-05T18:00:00Z");
    });

    it("merges the 1m tail for long windows without double counting closed hours", async () => {
      mockGraphQLForRoomTest();

      const closedHourIso = "2026-08-05T19:00:00Z";
      const inProgressMinute = "2026-08-05T19:05:00Z";
      const staleMinute = "2026-08-05T18:50:00Z";

      const mockExecute = vi
        .fn()
        // Main 1h query: one closed hourly bucket
        .mockResolvedValueOnce({
          data: [
            { time: closedHourIso, sensor_id: "sensor_1", field: "in", value: 10 },
            { time: closedHourIso, sensor_id: "sensor_1", field: "out", value: 8 },
          ],
        })
        // Tail 1m query: a stale minute inside the closed hour (must be
        // deduped) plus a minute in the in-progress hour (must be added)
        .mockResolvedValueOnce({
          data: [
            { time: staleMinute, sensor_id: "sensor_1", field: "in", value: 3 },
            { time: inProgressMinute, sensor_id: "sensor_1", field: "in", value: 2 },
          ],
        });
      vi.spyOn(reportingClient.ReportingRequestBuilder.prototype, "execute").mockImplementation(
        mockExecute
      );

      const result = await executeTrafficFlow({
        space_id_or_name: "room_test",
        time_window: "today",
      });

      expect(mockExecute).toHaveBeenCalledTimes(2);
      // 10 in + 8 out from the closed hour, +2 in from the in-progress hour;
      // the stale minute inside the closed hour is dropped, not double counted
      expect(result.traffic.total_entries).toBe(12);
      expect(result.traffic.total_exits).toBe(8);
      expect(result.hourly_breakdown).toHaveLength(2);
    });

    it("does not let a tail bucket on an exact hour boundary overwrite the native bucket", async () => {
      mockGraphQLForRoomTest();

      const closedHourIso = "2026-08-05T19:00:00Z";

      const mockExecute = vi
        .fn()
        // Main 1h query: closed hourly bucket with 10 entries
        .mockResolvedValueOnce({
          data: [{ time: closedHourIso, sensor_id: "sensor_1", field: "in", value: 10 }],
        })
        // Tail 1m query: the hour's final minute bucket carries the exact
        // same end label as the native 1h bucket
        .mockResolvedValueOnce({
          data: [{ time: closedHourIso, sensor_id: "sensor_1", field: "in", value: 1 }],
        });
      vi.spyOn(reportingClient.ReportingRequestBuilder.prototype, "execute").mockImplementation(
        mockExecute
      );

      const result = await executeTrafficFlow({
        space_id_or_name: "room_test",
        time_window: "today",
      });

      // Native bucket total must survive; the duplicate tail minute is dropped
      expect(result.traffic.total_entries).toBe(10);
    });

    it("dedups tail minutes against native buckets on a non-UTC-aligned hour grid", async () => {
      mockGraphQLForRoomTest();

      // Native 1h bucket end-labeled on a :30 grid (e.g. Asia/Kolkata site),
      // covering the 60 minutes before it
      const nativeIso = "2026-08-05T18:30:00Z";
      const insideNative = "2026-08-05T18:15:00Z";
      const afterNative = "2026-08-05T18:35:00Z";

      const mockExecute = vi
        .fn()
        .mockResolvedValueOnce({
          data: [{ time: nativeIso, sensor_id: "sensor_1", field: "in", value: 10 }],
        })
        // Tail: one minute inside the native bucket's interval (drop), one
        // after it (keep) — labels never match the :30 native label
        .mockResolvedValueOnce({
          data: [
            { time: insideNative, sensor_id: "sensor_1", field: "in", value: 3 },
            { time: afterNative, sensor_id: "sensor_1", field: "in", value: 2 },
          ],
        });
      vi.spyOn(reportingClient.ReportingRequestBuilder.prototype, "execute").mockImplementation(
        mockExecute
      );

      const result = await executeTrafficFlow({
        space_id_or_name: "room_test",
        time_window: "today",
      });

      expect(result.traffic.total_entries).toBe(12);
    });

    it("keeps a sensor's tail minutes when only another sensor's hourly bucket has materialized", async () => {
      mockGraphQLForRoomTest();

      const mockExecute = vi
        .fn()
        // Main 1h query: only sensor_1's bucket for the closed hour landed
        .mockResolvedValueOnce({
          data: [{ time: "2026-08-05T19:00:00Z", sensor_id: "sensor_1", field: "in", value: 10 }],
        })
        // Tail 1m query: sensor_1's minute inside its own landed hour must
        // be dropped; sensor_2's minute in the same hour has no native
        // bucket yet and must be kept
        .mockResolvedValueOnce({
          data: [
            { time: "2026-08-05T18:50:00Z", sensor_id: "sensor_1", field: "in", value: 3 },
            { time: "2026-08-05T18:45:00Z", sensor_id: "sensor_2", field: "in", value: 4 },
          ],
        });
      vi.spyOn(reportingClient.ReportingRequestBuilder.prototype, "execute").mockImplementation(
        mockExecute
      );

      const result = await executeTrafficFlow({
        space_id_or_name: "room_test",
        time_window: "today",
      });

      expect(result.traffic.total_entries).toBe(14);
    });

    it("skips the tail query when the range stop is not recent", async () => {
      mockGraphQLForRoomTest();

      const mockExecute = vi.fn().mockResolvedValue({
        data: [{ time: "2026-08-01T10:00:00Z", sensor_id: "sensor_1", field: "in", value: 5 }],
      });
      vi.spyOn(reportingClient.ReportingRequestBuilder.prototype, "execute").mockImplementation(
        mockExecute
      );

      const result = await executeTrafficFlow({
        space_id_or_name: "room_test",
        time_window: "custom",
        custom_start: "2026-08-01T08:00:00Z",
        custom_stop: "2026-08-01T12:00:00Z",
      });

      // Historical range: hourly buckets materialized long ago, no tail call
      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(result.traffic.total_entries).toBe(5);
    });

    it("includes a freshness note when the window ends near now", async () => {
      mockGraphQLForRoomTest();

      const mockExecute = vi.fn().mockResolvedValue({ data: [] });
      vi.spyOn(reportingClient.ReportingRequestBuilder.prototype, "execute").mockImplementation(
        mockExecute
      );

      const result = await executeTrafficFlow({
        space_id_or_name: "room_test",
        time_window: "20m",
      });

      expect(result.freshness_note).toContain("5-10 minutes");
    });
  });
});
