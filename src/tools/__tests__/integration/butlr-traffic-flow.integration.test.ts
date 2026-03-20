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
});
