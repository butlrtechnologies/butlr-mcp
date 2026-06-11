import { describe, it, expect, beforeEach, vi } from "vitest";
import { executeSpaceBusyness } from "../../butlr-space-busyness.js";
import { apolloClient } from "../../../clients/graphql-client.js";
import * as reportingClient from "../../../clients/reporting-client.js";
import * as statsClient from "../../../clients/stats-client.js";
import * as searchAssets from "../../butlr-search-assets.js";
import { clearOccupancyCache } from "../../../cache/occupancy-cache.js";

// Mock all the clients
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
    getCurrentOccupancy: vi.fn(),
  };
});

vi.mock("../../../clients/stats-client.js", async () => {
  const actual = await vi.importActual<typeof import("../../../clients/stats-client.js")>(
    "../../../clients/stats-client.js"
  );
  return {
    ...actual,
    getSingleAssetStats: vi.fn(),
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

describe("butlr_space_busyness - Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearOccupancyCache(); // Clear cache between tests
  });

  describe("Direct ID lookup", () => {
    it("returns busyness for a room by ID", async () => {
      // Mock room query
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: {
          room: {
            id: "room_123",
            name: "Conference Room A",
            capacity: { max: 10, mid: 5 },
            floor: {
              id: "floor_456",
              name: "Floor 2",
              building: { id: "building_789", name: "HQ Tower" },
            },
          },
        },
        loading: false,
        networkStatus: 7,
      } as any);

      // Mock current occupancy (3 people)
      vi.mocked(reportingClient.getCurrentOccupancy).mockResolvedValue([
        {
          start: "2025-10-14T15:00:00Z",
          measurement: "room_occupancy",
          value: 3,
          asset_id: "room_123",
        },
      ]);

      const result = await executeSpaceBusyness({
        space_id_or_name: "room_123",
        include_trend: false,
      });

      expect(result.space.id).toBe("room_123");
      expect(result.space.name).toBe("Conference Room A");
      expect(result.current.occupancy).toBe(3);
      expect(result.current.capacity.max).toBe(10);
      expect(result.current.utilization_percent).toBe(30);
      expect(result.current.label).toBe("moderate");
      expect(result.recommendation).toContain("Good time to visit");
      expect(result.summary).toContain("Conference Room A");
    });

    it("calculates correct utilization percentages", async () => {
      // Test different occupancy levels
      const testCases = [
        { occupancy: 0, expected: "quiet" },
        { occupancy: 5, expected: "quiet" }, // 25%
        { occupancy: 10, expected: "moderate" }, // 50%
        { occupancy: 15, expected: "busy" }, // 75%
        { occupancy: 20, expected: "busy" }, // 100%
      ];

      for (const testCase of testCases) {
        // Clear mocks and cache between iterations
        vi.clearAllMocks();
        clearOccupancyCache();

        vi.mocked(apolloClient.query).mockResolvedValue({
          data: {
            room: {
              id: "room_test",
              name: "Test Room",
              capacity: { max: 20 },
            },
          },
          loading: false,
          networkStatus: 7,
        } as any);

        vi.mocked(reportingClient.getCurrentOccupancy).mockResolvedValue([
          {
            start: "2025-10-14T15:00:00Z",
            measurement: "room_occupancy",
            value: testCase.occupancy,
            asset_id: "room_test",
          },
        ]);

        const result = await executeSpaceBusyness({
          space_id_or_name: "room_test",
          include_trend: false,
        });

        expect(result.current.label).toBe(testCase.expected);
      }
    });
  });

  describe("Name search", () => {
    it("searches for space by name", async () => {
      // Mock search results
      vi.mocked(searchAssets.executeSearchAssets).mockResolvedValue({
        query: "café",
        matches: [
          {
            id: "room_cafe",
            type: "room",
            name: "Employee Café",
            score: 95,
            path: "HQ > Floor 1 > Employee Café",
          },
        ],
        total_matches: 1,
      } as any);

      // Mock room query
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: {
          room: {
            id: "room_cafe",
            name: "Employee Café",
            capacity: { max: 50 },
          },
        },
        loading: false,
        networkStatus: 7,
      } as any);

      // Mock occupancy
      vi.mocked(reportingClient.getCurrentOccupancy).mockResolvedValue([
        {
          start: "2025-10-14T15:00:00Z",
          measurement: "room_occupancy",
          value: 25,
          asset_id: "room_cafe",
        },
      ]);

      const result = await executeSpaceBusyness({
        space_id_or_name: "café",
        include_trend: false,
      });

      expect(searchAssets.executeSearchAssets).toHaveBeenCalledWith({
        query: "café",
        asset_types: ["room", "zone"],
        max_results: 5,
      });

      expect(result.space.id).toBe("room_cafe");
      expect(result.current.occupancy).toBe(25);
    });

    it("throws error if no spaces found", async () => {
      vi.mocked(searchAssets.executeSearchAssets).mockResolvedValue({
        query: "nonexistent",
        matches: [],
        total_matches: 0,
      } as any);

      await expect(
        executeSpaceBusyness({
          space_id_or_name: "nonexistent",
        })
      ).rejects.toThrow('No spaces found matching "nonexistent"');
    });
  });

  describe("Trend calculation", () => {
    it("handles trend calculation with stats data", async () => {
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: {
          room: {
            id: "room_123",
            name: "Meeting Room",
            capacity: { max: 8 },
          },
        },
        loading: false,
        networkStatus: 7,
      } as any);

      vi.mocked(reportingClient.getCurrentOccupancy).mockResolvedValue([
        {
          start: "2025-10-14T15:00:00Z",
          measurement: "room_occupancy",
          value: 6, // 75% utilization
          asset_id: "room_123",
        },
      ]);

      vi.mocked(statsClient.getSingleAssetStats).mockResolvedValue({
        count: 1000,
        mean: 3,
        median: 2,
        min: 0,
        max: 8,
        stdev: 2,
        sum: 3000,
        first: 2,
        last: 4,
      });

      const result = await executeSpaceBusyness({
        space_id_or_name: "room_123",
        include_trend: true,
      });

      // Stats call should have been attempted
      expect(statsClient.getSingleAssetStats).toHaveBeenCalled();

      // Regression: the v4 Stats API requires ISO-8601 absolute timestamps and
      // rejects relative formats like "-4w". Pin the call-site to pass ISO-8601
      // strings (parseable by Date.parse) so a future "convenience" refactor
      // back to relative formats doesn't reintroduce the bug.
      const callArgs = vi.mocked(statsClient.getSingleAssetStats).mock.calls[0];
      const [, , start, stop] = callArgs;
      expect(typeof start).toBe("string");
      expect(typeof stop).toBe("string");
      expect(Number.isNaN(Date.parse(start as string))).toBe(false);
      expect(Number.isNaN(Date.parse(stop as string))).toBe(false);
      // Should NOT be a relative format like "-4w" / "-7d" / "now"
      expect(start).not.toMatch(/^-?\d+[mhdw]$|^now$/);
      expect(stop).not.toMatch(/^-?\d+[mhdw]$|^now$/);
      // Window should be ~28 days
      const windowMs = Date.parse(stop as string) - Date.parse(start as string);
      const days = windowMs / (24 * 60 * 60 * 1000);
      expect(days).toBeGreaterThan(27.5);
      expect(days).toBeLessThan(28.5);

      // If stats succeeded, trend would be included
      if (result.trend) {
        expect(result.trend.typical_for_time).toBe(3);
        expect(result.trend.trend_label).toMatch(/lighter|typical|busier/);
      }
    });

    it("excludes trend when disabled", async () => {
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: {
          room: {
            id: "room_123",
            name: "Test Room",
            capacity: { max: 10 },
          },
        },
        loading: false,
        networkStatus: 7,
      } as any);

      vi.mocked(reportingClient.getCurrentOccupancy).mockResolvedValue([
        {
          start: "2025-10-14T15:00:00Z",
          measurement: "room_occupancy",
          value: 5,
          asset_id: "room_123",
        },
      ]);

      const result = await executeSpaceBusyness({
        space_id_or_name: "room_123",
        include_trend: false,
      });

      expect(result.trend).toBeUndefined();
      expect(statsClient.getSingleAssetStats).not.toHaveBeenCalled();
    });
  });

  describe("Response structure", () => {
    it("includes all required fields", async () => {
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: {
          room: {
            id: "room_123",
            name: "Test Room",
            capacity: { max: 10 },
          },
        },
        loading: false,
        networkStatus: 7,
      } as any);

      vi.mocked(reportingClient.getCurrentOccupancy).mockResolvedValue([
        {
          start: "2025-10-14T15:00:00Z",
          measurement: "room_occupancy",
          value: 5,
          asset_id: "room_123",
        },
      ]);

      const result = await executeSpaceBusyness({
        space_id_or_name: "room_123",
        include_trend: false,
      });

      expect(result.space).toBeDefined();
      expect(result.current).toBeDefined();
      expect(result.recommendation).toBeDefined();
      expect(result.summary).toBeDefined();
      expect(result.timestamp).toBeDefined();
    });
  });

  describe("Error handling", () => {
    it("throws validation error for empty space_id_or_name", async () => {
      // Note: Validation happens in MCP handler, not execute function
      // Direct calls with empty string will attempt search and fail with "No spaces found"
      await expect(executeSpaceBusyness({ space_id_or_name: "" })).rejects.toThrow(
        'No spaces found matching ""'
      );
    });

    it("returns null utilization when capacity is not configured", async () => {
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: {
          room: {
            id: "room_nocap",
            name: "Unconfigured Room",
            capacity: {},
          },
        },
        loading: false,
        networkStatus: 7,
      } as any);

      vi.mocked(reportingClient.getCurrentOccupancy).mockResolvedValue([
        {
          start: "2025-10-14T15:00:00Z",
          measurement: "room_occupancy",
          value: 5,
          asset_id: "room_nocap",
        },
      ]);

      const result = await executeSpaceBusyness({
        space_id_or_name: "room_nocap",
        include_trend: false,
      });

      expect(result.current.occupancy).toBe(5);
      expect(result.current.utilization_percent).toBeNull();
      expect(result.current.label).toBeNull();
      expect(result.current.capacity_configured).toBe(false);
      expect(result.warning).toContain("capacity");
    });

    it("throws error if space not found", async () => {
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: { room: null },
        loading: false,
        networkStatus: 7,
      } as any);

      await expect(executeSpaceBusyness({ space_id_or_name: "room_nonexistent" })).rejects.toThrow(
        "Room room_nonexistent not found"
      );
    });
  });

  // Regression test for B1: GET_ROOM / GET_ZONE used to select `site { timezone }`
  // without `id`. graphql-client.ts declares `Site: { keyFields: ['id'] }` on the
  // InMemoryCache, so Apollo 4 silently set `result.data = undefined` (under
  // `errorPolicy: 'all'`) when the Site object came back without its keyField —
  // which the tool then mis-reported as "Room/Zone not found". This test pins
  // the query shape so a future cleanup that strips `id` doesn't reintroduce
  // the bug. The Apollo mock used by these tests bypasses the cache, so we
  // can't reproduce the runtime symptom here; checking the query AST is the
  // only way to catch the regression without spinning up a real Apollo client.
  describe("Regression: B1 — Apollo cache normalization requires site.id", () => {
    function captureQueryFor(typeName: "room" | "zone") {
      let capturedSource = "";
      vi.mocked(apolloClient.query).mockImplementation((options: any) => {
        capturedSource = options.query?.loc?.source?.body ?? "";
        return Promise.resolve({
          data: {
            [typeName]: {
              id: typeName === "room" ? "room_x" : "zone_x",
              name: "X",
              capacity: { max: 1 },
            },
          },
          loading: false,
          networkStatus: 7,
        } as any);
      });
      vi.mocked(reportingClient.getCurrentOccupancy).mockResolvedValue([]);
      return () => capturedSource;
    }

    it("GET_ROOM selects id inside the site { ... } subselection", async () => {
      const getSource = captureQueryFor("room");
      await executeSpaceBusyness({ space_id_or_name: "room_x", include_trend: false });
      const source = getSource();
      // Look for `site { ... id ... }` somewhere in the query body. Tolerant
      // of whitespace/ordering so a maintainer can reformat without breaking.
      expect(source).toMatch(/site\s*\{[^{}]*\bid\b[^{}]*\}/);
    });

    it("GET_ZONE selects id inside the site { ... } subselection", async () => {
      const getSource = captureQueryFor("zone");
      await executeSpaceBusyness({ space_id_or_name: "zone_x", include_trend: false });
      const source = getSource();
      expect(source).toMatch(/site\s*\{[^{}]*\bid\b[^{}]*\}/);
    });
  });

  describe("Null site timezone fallback", () => {
    it("includes timezone fallback warning when site has no timezone", async () => {
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: {
          room: {
            id: "room_123",
            name: "Conference Room A",
            capacity: { max: 10 },
            floor: {
              id: "floor_456",
              name: "Floor 2",
              building: {
                id: "building_789",
                name: "HQ Tower",
                site_id: "site_001",
                site: { timezone: null },
              },
            },
          },
        },
        loading: false,
        networkStatus: 7,
      } as any);

      vi.mocked(reportingClient.getCurrentOccupancy).mockResolvedValue([
        {
          start: "2025-10-14T15:00:00Z",
          measurement: "room_occupancy",
          value: 3,
          asset_id: "room_123",
        },
      ]);

      const result = await executeSpaceBusyness({
        space_id_or_name: "room_123",
        include_trend: false,
      });

      expect(result.warning).toMatch(/Could not determine site timezone/);
      expect(result.warning).toMatch(/fallback/);
    });

    it("no timezone warning when site has valid timezone", async () => {
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: {
          room: {
            id: "room_123",
            name: "Conference Room A",
            capacity: { max: 10 },
            floor: {
              id: "floor_456",
              name: "Floor 2",
              building: {
                id: "building_789",
                name: "HQ Tower",
                site_id: "site_001",
                site: { timezone: "America/New_York" },
              },
            },
          },
        },
        loading: false,
        networkStatus: 7,
      } as any);

      vi.mocked(reportingClient.getCurrentOccupancy).mockResolvedValue([
        {
          start: "2025-10-14T15:00:00Z",
          measurement: "room_occupancy",
          value: 3,
          asset_id: "room_123",
        },
      ]);

      const result = await executeSpaceBusyness({
        space_id_or_name: "room_123",
        include_trend: false,
      });

      expect(result.warning).toBeUndefined();
    });
  });
});
