import { describe, it, expect, beforeEach, vi } from "vitest";
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

  describe("ETL backend time semantics", () => {
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

      const closedHourEnd = new Date();
      closedHourEnd.setUTCMinutes(0, 0, 0);
      const closedHourIso = closedHourEnd.toISOString().replace(".000Z", "Z");
      const inProgressMinute = new Date(closedHourEnd.getTime() + 5 * 60 * 1000)
        .toISOString()
        .replace(".000Z", "Z");
      const staleMinute = new Date(closedHourEnd.getTime() - 10 * 60 * 1000)
        .toISOString()
        .replace(".000Z", "Z");

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

      const closedHourEnd = new Date();
      closedHourEnd.setUTCMinutes(0, 0, 0);
      const closedHourIso = closedHourEnd.toISOString().replace(".000Z", "Z");

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
      const nativeEnd = new Date();
      nativeEnd.setUTCMinutes(30, 0, 0);
      if (nativeEnd.getTime() > Date.now()) {
        nativeEnd.setUTCHours(nativeEnd.getUTCHours() - 1);
      }
      const nativeIso = nativeEnd.toISOString().replace(".000Z", "Z");
      const insideNative = new Date(nativeEnd.getTime() - 15 * 60 * 1000)
        .toISOString()
        .replace(".000Z", "Z");
      const afterNative = new Date(nativeEnd.getTime() + 5 * 60 * 1000)
        .toISOString()
        .replace(".000Z", "Z");

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
