import { describe, it, expect, beforeEach, vi } from "vitest";
import { executeSpaceBusyness } from "../../butlr-space-busyness.js";
import { apolloClient } from "../../../clients/graphql-client.js";
import * as reportingClient from "../../../clients/reporting-client.js";
import * as statsClient from "../../../clients/stats-client.js";
import * as searchAssets from "../../butlr-search-assets.js";
import { clearOccupancyCache } from "../../../cache/occupancy-cache.js";
import { GET_FULL_TOPOLOGY } from "../../../clients/queries/topology.js";
import { cacheMergedTopology, clearTopologyCache } from "../../../cache/topology-cache.js";
import { primeSpaceFieldSupport } from "../../../clients/space-field-support.js";
import { print } from "graphql";
import { CombinedGraphQLErrors } from "@apollo/client/errors";

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
    clearTopologyCache();
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

    describe("archived spaces", () => {
      const ARCHIVED_AT = "2026-10-22T20:00:00Z";

      /**
       * Floor 7 rooms keyed by id; `room(id:)` and the topology both answer
       * from this table.
       */
      function mockFloor7(rooms: Array<Record<string, unknown>>) {
        vi.mocked(apolloClient.query).mockImplementation((async (opts: any) => {
          if (opts.query === GET_FULL_TOPOLOGY) {
            return {
              data: {
                sites: {
                  data: [
                    {
                      id: "site_1",
                      name: "Indy",
                      timezone: "America/Indiana/Indianapolis",
                      buildings: [
                        {
                          id: "building_1",
                          name: "Tower",
                          site_id: "site_1",
                          floors: [
                            {
                              id: "floor_7",
                              name: "Floor 07",
                              building_id: "building_1",
                              rooms,
                              zones: [],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
            };
          }
          const room = rooms.find((r) => r.id === opts.variables?.roomId);
          return {
            data: {
              room: room && {
                ...room,
                capacity: { max: 4 },
                floor: {
                  id: "floor_7",
                  name: "Floor 07",
                  building: {
                    id: "building_1",
                    name: "Tower",
                    site_id: "site_1",
                    site: { id: "site_1", timezone: "America/Indiana/Indianapolis" },
                  },
                },
              },
            },
          };
        }) as never);
        vi.mocked(reportingClient.getCurrentOccupancy).mockImplementation(async (_t, ids) => [
          {
            start: "2026-10-23T15:00:00Z",
            measurement: "room_occupancy",
            value: 1,
            asset_id: ids[0],
          },
        ]);
      }

      function searchReturns(matches: Array<Record<string, unknown>>) {
        vi.mocked(searchAssets.executeSearchAssets).mockResolvedValue({
          query: "q",
          matches: matches.map((m) => ({ type: "room", match_score: 90, path: "p", ...m })),
          total_matches: matches.length,
        } as any);
      }

      const OLD = { id: "room_old", name: "Pilot - Huddle", archivedAt: ARCHIVED_AT };

      it("follows an archived best match to its single, active replacement", async () => {
        mockFloor7([OLD, { id: "room_v2", name: "Huddle_V2", replacesID: "room_old" }]);
        searchReturns([
          { ...OLD, archived_at: ARCHIVED_AT, replaced_by: [{ id: "room_v2", name: "Huddle_V2" }] },
        ]);

        const result = await executeSpaceBusyness({
          space_id_or_name: "Pilot - Huddle",
          include_trend: false,
        });

        expect(result.space.id).toBe("room_v2");
        expect(result.current?.occupancy).toBe(1);
        expect(result.warning).toContain(
          '"Pilot - Huddle" (room_old) is archived; showing its replacement "Huddle_V2" (room_v2).'
        );
      });

      it("does not auto-follow a split: returns the archived space with its successors", async () => {
        mockFloor7([
          OLD,
          { id: "room_v2a", name: "Huddle_V2", replacesID: "room_old" },
          { id: "room_v2b", name: "Focus_V2", replacesID: "room_old" },
        ]);
        searchReturns([
          {
            ...OLD,
            archived_at: ARCHIVED_AT,
            replaced_by: [
              { id: "room_v2a", name: "Huddle_V2" },
              { id: "room_v2b", name: "Focus_V2" },
            ],
          },
        ]);

        const result = await executeSpaceBusyness({
          space_id_or_name: "Pilot - Huddle",
          include_trend: false,
        });

        expect(result.space.id).toBe("room_old");
        expect(result.space.archived_at).toBe(ARCHIVED_AT);
        expect(result.current).toBeNull();
        expect(result.space.replaced_by).toEqual([
          { id: "room_v2a", name: "Huddle_V2" },
          { id: "room_v2b", name: "Focus_V2" },
        ]);
        expect(result.history_note).toContain("history_end");
        expect(reportingClient.getCurrentOccupancy).not.toHaveBeenCalled();
      });

      it("does not follow a successor that is itself archived", async () => {
        mockFloor7([
          OLD,
          { id: "room_v2", name: "Huddle_V2", replacesID: "room_old", archivedAt: ARCHIVED_AT },
        ]);
        searchReturns([
          {
            ...OLD,
            archived_at: ARCHIVED_AT,
            replaced_by: [{ id: "room_v2", name: "Huddle_V2", archived_at: ARCHIVED_AT }],
          },
        ]);

        const result = await executeSpaceBusyness({
          space_id_or_name: "Pilot - Huddle",
          include_trend: false,
        });

        expect(result.space.id).toBe("room_old");
        expect(result.current).toBeNull();
        expect(result.space.replaced_by).toEqual([
          { id: "room_v2", name: "Huddle_V2", archived_at: ARCHIVED_AT },
        ]);
      });

      it("does not switch to a weaker non-archived match", async () => {
        mockFloor7([OLD, { id: "room_other", name: "Pilot - Hub" }]);
        searchReturns([
          { ...OLD, archived_at: ARCHIVED_AT, match_score: 100 },
          { id: "room_other", name: "Pilot - Hub", match_score: 80 },
        ]);

        const result = await executeSpaceBusyness({
          space_id_or_name: "Pilot - Huddle",
          include_trend: false,
        });

        expect(result.space.id).toBe("room_old");
        expect(result.current).toBeNull();
        expect(result.recommendation).toBe(
          "This room was archived on 2026-10-22, has no sensors assigned and has no live busyness."
        );
        expect(result.space).not.toHaveProperty("replaced_by");
      });

      it("uses the search result's successors on the name path, without the topology", async () => {
        mockFloor7([OLD, { id: "room_v2", name: "Huddle_V2", replacesID: "room_old" }]);
        searchReturns([
          { ...OLD, archived_at: ARCHIVED_AT, replaced_by: [{ id: "room_v2", name: "Huddle_V2" }] },
        ]);

        await executeSpaceBusyness({ space_id_or_name: "Pilot - Huddle", include_trend: false });

        const topologyFetches = vi
          .mocked(apolloClient.query)
          .mock.calls.filter((c) => c[0].query === GET_FULL_TOPOLOGY);
        expect(topologyFetches).toHaveLength(0);
      });

      it("does not call a successor its replacement once it turns out archived", async () => {
        // The search corpus (cached topology) still says room_v2 is active,
        // but GetRoom now returns it archived.
        mockFloor7([
          OLD,
          { id: "room_v2", name: "Huddle_V2", replacesID: "room_old", archivedAt: ARCHIVED_AT },
        ]);
        searchReturns([
          { ...OLD, archived_at: ARCHIVED_AT, replaced_by: [{ id: "room_v2", name: "Huddle_V2" }] },
        ]);

        const result = await executeSpaceBusyness({
          space_id_or_name: "Pilot - Huddle",
          include_trend: false,
        });

        expect(result.space.id).toBe("room_old");
        expect(result.current).toBeNull();
        expect(result.space.replaced_by).toEqual([
          { id: "room_v2", name: "Huddle_V2", archived_at: ARCHIVED_AT },
        ]);
        expect(result.recommendation).not.toMatch(/replaced by "Pilot - Huddle"/);
        expect(result.warning ?? "").not.toMatch(/showing its replacement/);
      });

      it("reads successors for an archived ID from the cached topology when warm", async () => {
        mockFloor7([OLD, { id: "room_v2", name: "Huddle_V2", replacesID: "room_old" }]);
        cacheMergedTopology(
          [
            {
              id: "site_1",
              buildings: [
                {
                  id: "building_1",
                  floors: [
                    {
                      id: "floor_7",
                      rooms: [OLD, { id: "room_v2", name: "Huddle_V2", replacesID: "room_old" }],
                      zones: [],
                    },
                  ],
                },
              ],
            },
          ] as any,
          { partial: false, omittedFields: [] }
        );

        const result = await executeSpaceBusyness({
          space_id_or_name: "room_old",
          include_trend: false,
        });

        expect(result.space.id).toBe("room_v2");
        const topologyFetches = vi
          .mocked(apolloClient.query)
          .mock.calls.filter((c) => c[0].query === GET_FULL_TOPOLOGY);
        expect(topologyFetches).toHaveLength(0);
      });

      it("still answers for an archived ID when the topology cannot be loaded", async () => {
        mockFloor7([OLD]);
        const answer = vi.mocked(apolloClient.query).getMockImplementation()!;
        vi.mocked(apolloClient.query).mockImplementation((async (opts: any) => {
          if (opts.query === GET_FULL_TOPOLOGY) throw new Error("upstream down");
          return answer(opts);
        }) as never);

        const result = await executeSpaceBusyness({
          space_id_or_name: "room_old",
          include_trend: false,
        });

        expect(result.space.archived_at).toBe(ARCHIVED_AT);
        expect(result.current).toBeNull();
        expect(result.warning).toContain("Could not look up this space's replacements");
      });

      it("does not trust a warm cache that predates the re-draw: fetches the topology", async () => {
        // Cached before the re-draw: room_old active, no successor yet.
        cacheMergedTopology(
          [
            {
              id: "site_1",
              buildings: [
                {
                  id: "building_1",
                  floors: [
                    {
                      id: "floor_7",
                      rooms: [{ id: "room_old", name: "Pilot - Huddle" }],
                      zones: [],
                    },
                  ],
                },
              ],
            },
          ] as any,
          { partial: false, omittedFields: [] }
        );
        mockFloor7([OLD, { id: "room_v2", name: "Huddle_V2", replacesID: "room_old" }]);

        const result = await executeSpaceBusyness({
          space_id_or_name: "room_old",
          include_trend: false,
        });

        expect(result.space.id).toBe("room_v2");
        const topologyFetches = vi
          .mocked(apolloClient.query)
          .mock.calls.filter((c) => c[0].query === GET_FULL_TOPOLOGY);
        expect(topologyFetches).toHaveLength(1);
      });

      it("does not trust a search result that has no successors yet", async () => {
        mockFloor7([OLD, { id: "room_v2", name: "Huddle_V2", replacesID: "room_old" }]);
        // The search corpus predates the archive: no archived_at, no replaced_by.
        searchReturns([{ id: "room_old", name: "Pilot - Huddle" }]);

        const result = await executeSpaceBusyness({
          space_id_or_name: "Pilot - Huddle",
          include_trend: false,
        });

        expect(result.space.id).toBe("room_v2");
      });

      it("warns with the error when the single successor cannot be loaded", async () => {
        mockFloor7([OLD, { id: "room_v2", name: "Huddle_V2", replacesID: "room_old" }]);
        const answer = vi.mocked(apolloClient.query).getMockImplementation()!;
        vi.mocked(apolloClient.query).mockImplementation((async (opts: any) => {
          if (opts.variables?.roomId === "room_v2") {
            return {
              data: undefined,
              error: new CombinedGraphQLErrors({
                errors: [{ message: "Too many requests", extensions: { code: "RATE_LIMITED" } }],
              }),
            };
          }
          return answer(opts);
        }) as never);

        const result = await executeSpaceBusyness({
          space_id_or_name: "room_old",
          include_trend: false,
        });

        expect(result.space.id).toBe("room_old");
        expect(result.current).toBeNull();
        expect(result.warning).toMatch(
          /Could not load its replacement "Huddle_V2" \(room_v2\): \[/
        );
      });

      it("reads an archived room live when sensors are still attributed (E4)", async () => {
        mockFloor7([{ ...OLD, sensors: [{ id: "sensor_1" }] }]);

        const result = await executeSpaceBusyness({
          space_id_or_name: "room_old",
          include_trend: false,
        });

        expect(result.current?.occupancy).toBe(1);
        expect(result.warning).toMatch(
          /still has 1 sensor attributed \(a data-integrity issue\), so it is read live/
        );
        expect(reportingClient.getCurrentOccupancy).toHaveBeenCalled();
      });

      it("treats a room retired only by sensorsRemovedAt as retired", async () => {
        mockFloor7([{ id: "room_old", name: "Pilot - Huddle", sensorsRemovedAt: ARCHIVED_AT }]);

        const result = await executeSpaceBusyness({
          space_id_or_name: "room_old",
          include_trend: false,
        });

        expect(result.current).toBeNull();
        expect(result.space).not.toHaveProperty("archived_at");
        expect(result.recommendation).toBe(
          "This room had its sensors removed on 2026-10-22, has no sensors assigned and has no live busyness."
        );
        expect(reportingClient.getCurrentOccupancy).not.toHaveBeenCalled();
      });

      it("gives an archived room passed by ID the same treatment", async () => {
        mockFloor7([OLD]);

        const result = await executeSpaceBusyness({
          space_id_or_name: "room_old",
          include_trend: false,
        });

        expect(searchAssets.executeSearchAssets).not.toHaveBeenCalled();
        expect(result.space.archived_at).toBe(ARCHIVED_AT);
        expect(result.current).toBeNull();
        expect(reportingClient.getCurrentOccupancy).not.toHaveBeenCalled();
      });

      it("strips the archive fields from GetRoom on an API that lacks them", async () => {
        primeSpaceFieldSupport([]);
        const sent: string[] = [];
        vi.mocked(apolloClient.query).mockImplementation((async (opts: any) => {
          sent.push(print(opts.query));
          return { data: { room: { id: "room_123", name: "Room", capacity: { max: 10 } } } };
        }) as never);
        vi.mocked(reportingClient.getCurrentOccupancy).mockResolvedValue([
          {
            start: "2026-10-23T15:00:00Z",
            measurement: "room_occupancy",
            value: 2,
            asset_id: "room_123",
          },
        ]);

        const result = await executeSpaceBusyness({
          space_id_or_name: "room_123",
          include_trend: false,
        });

        expect(sent).toHaveLength(1);
        expect(sent[0]).not.toMatch(/archivedAt|replacesID|sensorsRemovedAt/);
        expect(result.current?.occupancy).toBe(2);
      });

      it("follows the single active replacement from an archived ID too", async () => {
        mockFloor7([OLD, { id: "room_v2", name: "Huddle_V2", replacesID: "room_old" }]);

        const result = await executeSpaceBusyness({
          space_id_or_name: "room_old",
          include_trend: false,
        });

        expect(result.space.id).toBe("room_v2");
        expect(result.warning).toContain("showing its replacement");
      });
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
