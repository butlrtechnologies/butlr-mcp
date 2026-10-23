import { describe, it, expect, beforeEach, vi } from "vitest";
import { executeGetOccupancyTimeseries } from "../../butlr-get-occupancy-timeseries.js";
import { apolloClient } from "../../../clients/graphql-client.js";
import * as reportingClient from "../../../clients/reporting-client.js";
import { CombinedGraphQLErrors } from "@apollo/client/errors";
import {
  GET_ALL_SENSORS,
  GET_FULL_TOPOLOGY,
  GET_FULL_TOPOLOGY_LEGACY,
} from "../../../clients/queries/topology.js";
import { resetArchiveFieldSupport } from "../../../clients/archive-fallback.js";

// Mock the GraphQL client
vi.mock("../../../clients/graphql-client.js", () => ({
  apolloClient: {
    query: vi.fn(),
  },
}));

// Mock the ReportingRequestBuilder chain
vi.mock("../../../clients/reporting-client.js", async () => {
  const actual = await vi.importActual<typeof import("../../../clients/reporting-client.js")>(
    "../../../clients/reporting-client.js"
  );
  return {
    ...actual,
    ReportingRequestBuilder: vi.fn(),
  };
});

/**
 * Build a mock topology + sensors response with configurable sensor types.
 */
function buildTopologyResponse(opts?: {
  presenceSensors?: number;
  trafficSensors?: number;
  roomId?: string;
  floorId?: string;
  siteTimezone?: string | null;
}) {
  const roomId = opts?.roomId ?? "room_100";
  const floorId = opts?.floorId ?? "space_100";
  const presenceCount = opts?.presenceSensors ?? 1;
  const trafficCount = opts?.trafficSensors ?? 0;
  const siteTimezone = opts?.siteTimezone !== undefined ? opts.siteTimezone : "America/Los_Angeles";

  const presenceSensors = Array.from({ length: presenceCount }, (_, i) => ({
    id: `sensor_p${i}`,
    mac_address: `aa:bb:cc:dd:ee:0${i}`,
    mode: "presence",
    floor_id: floorId,
    room_id: roomId,
    hive_serial: "HIVE001",
    is_online: true,
    is_entrance: false,
  }));

  const trafficSensors = Array.from({ length: trafficCount }, (_, i) => ({
    id: `sensor_t${i}`,
    mac_address: `aa:bb:cc:dd:ff:0${i}`,
    mode: "traffic",
    floor_id: floorId,
    room_id: roomId,
    hive_serial: "HIVE001",
    is_online: true,
    is_entrance: false, // room-level traffic
  }));

  return {
    topology: {
      data: {
        sites: {
          data: [
            {
              id: "site_001",
              name: "Test Site",
              timezone: siteTimezone,
              org_id: "org_001",
              buildings: [
                {
                  id: "building_001",
                  name: "Test Building",
                  site_id: "site_001",
                  floors: [
                    {
                      id: floorId,
                      name: "Floor 1",
                      building_id: "building_001",
                      rooms: [
                        {
                          id: roomId,
                          name: "Conference Room A",
                          floorID: floorId,
                          capacity: { max: 10 },
                        },
                      ],
                      zones: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
      loading: false,
      networkStatus: 7,
    },
    sensors: {
      data: {
        sensors: {
          data: [...presenceSensors, ...trafficSensors],
        },
      },
      loading: false,
      networkStatus: 7,
    },
  };
}

function mockReportingBuilder(response: any) {
  const builder = {
    assets: vi.fn().mockReturnThis(),
    measurements: vi.fn().mockReturnThis(),
    timeRange: vi.fn().mockReturnThis(),
    window: vi.fn().mockReturnThis(),
    execute: vi.fn().mockResolvedValue(response),
  };
  return builder;
}

function setupTopologyMocks(topo: ReturnType<typeof buildTopologyResponse>) {
  vi.mocked(apolloClient.query)
    .mockResolvedValueOnce(topo.topology as any)
    .mockResolvedValueOnce(topo.sensors as any);
}

describe("butlr_get_occupancy_timeseries - Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetArchiveFieldSupport();
  });

  describe("Basic timeseries query", () => {
    it("returns presence timeseries for a room", async () => {
      const topo = buildTopologyResponse({ presenceSensors: 1 });
      setupTopologyMocks(topo);

      const presenceBuilder = mockReportingBuilder({
        data: [
          { time: "2025-10-14T14:00:00Z", value: 3 },
          { time: "2025-10-14T15:00:00Z", value: 5 },
          { time: "2025-10-14T16:00:00Z", value: 2 },
        ],
      });

      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(
        () => presenceBuilder as any
      );

      const result = await executeGetOccupancyTimeseries({
        asset_ids: ["room_100"],
        interval: "1h",
        start: "-24h",
        stop: "now",
      });

      expect(result.assets).toHaveLength(1);
      const asset = result.assets[0];
      expect(asset.asset_id).toBe("room_100");
      expect(asset.asset_type).toBe("room");
      expect(asset.presence.available).toBe(true);
      expect(asset.presence.timeseries).toHaveLength(3);
      expect(asset.presence.timeseries[0]).toEqual({
        timestamp: "2025-10-14T14:00:00.000Z",
        value: 3,
      });
      expect(result.interval).toBe("1h");
      expect(result.start).toBe("-24h");
      expect(result.stop).toBe("now");
      expect(result.timezone_note).toContain("UTC");
    });
  });

  describe("Time range validation", () => {
    it("throws when 1m interval exceeds 1 hour range", async () => {
      await expect(
        executeGetOccupancyTimeseries({
          asset_ids: ["room_100"],
          interval: "1m",
          start: "-3h",
          stop: "now",
        })
      ).rejects.toThrow(/Time range too large for 1m interval/);
    });

    it("throws when 1h interval exceeds 48 hour range", async () => {
      await expect(
        executeGetOccupancyTimeseries({
          asset_ids: ["room_100"],
          interval: "1h",
          start: "-72h",
          stop: "now",
        })
      ).rejects.toThrow(/Time range too large for 1h interval/);
    });

    it("allows valid 1m interval within 1 hour", async () => {
      const topo = buildTopologyResponse({ presenceSensors: 1 });
      setupTopologyMocks(topo);

      const builder = mockReportingBuilder({ data: [] });
      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(() => builder as any);

      // Should not throw
      const result = await executeGetOccupancyTimeseries({
        asset_ids: ["room_100"],
        interval: "1m",
        start: "-30m",
        stop: "now",
      });

      expect(result.assets).toHaveLength(1);
    });
  });

  describe("Both presence and traffic data", () => {
    it("returns both timeseries when both sensor types exist", async () => {
      const topo = buildTopologyResponse({
        presenceSensors: 1,
        trafficSensors: 1,
      });
      setupTopologyMocks(topo);

      const presenceBuilder = mockReportingBuilder({
        data: [
          { time: "2025-10-14T14:00:00Z", value: 3 },
          { time: "2025-10-14T15:00:00Z", value: 6 },
        ],
      });
      const trafficBuilder = mockReportingBuilder({
        data: [
          { time: "2025-10-14T14:00:00Z", value: 10 },
          { time: "2025-10-14T15:00:00Z", value: 15 },
        ],
      });

      let callCount = 0;
      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(() => {
        callCount++;
        return (callCount === 1 ? presenceBuilder : trafficBuilder) as any;
      });

      const result = await executeGetOccupancyTimeseries({
        asset_ids: ["room_100"],
        interval: "1h",
        start: "-24h",
        stop: "now",
      });

      const asset = result.assets[0];
      expect(asset.presence.available).toBe(true);
      expect(asset.presence.timeseries).toHaveLength(2);
      expect(asset.traffic.available).toBe(true);
      expect(asset.traffic.timeseries).toHaveLength(2);
      expect(asset.recommended_measurement).toBe("presence");
      expect(asset.recommendation_reason).toContain("Both available");
    });
  });

  describe("Recommendation reflects actual data retrieval", () => {
    it("recommends none when sensors exist but timeseries is empty", async () => {
      const topo = buildTopologyResponse({ presenceSensors: 1 });
      setupTopologyMocks(topo);

      // Sensors exist, but the API returns no data points
      const emptyBuilder = mockReportingBuilder({ data: [] });
      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(
        () => emptyBuilder as any
      );

      const result = await executeGetOccupancyTimeseries({
        asset_ids: ["room_100"],
        interval: "1h",
        start: "-24h",
        stop: "now",
      });

      const asset = result.assets[0];
      expect(asset.presence.available).toBe(true);
      expect(asset.presence.timeseries).toHaveLength(0);
      // Data was not actually retrieved, so recommendation should be "none"
      expect(asset.recommended_measurement).toBe("none");
    });

    it("no-data reason references the requested window, not 'last 5 minutes'", async () => {
      const topo = buildTopologyResponse({ presenceSensors: 1 });
      setupTopologyMocks(topo);

      const emptyBuilder = mockReportingBuilder({ data: [] });
      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(
        () => emptyBuilder as any
      );

      const result = await executeGetOccupancyTimeseries({
        asset_ids: ["room_100"],
        interval: "1d",
        start: "-7d",
        stop: "now",
      });

      const asset = result.assets[0];
      expect(asset.recommended_measurement).toBe("none");
      // Regression: the failure copy used to hardcode the current-occupancy
      // tool's 5-minute snapshot window — false for a caller-supplied range
      // like -7d, and an LLM would relay "only checked the last 5 minutes"
      // to a customer who asked about a week.
      expect(asset.recommendation_reason).not.toMatch(/last 5 minutes/);
      expect(asset.recommendation_reason).toMatch(/no presence reads in the requested time range/);
    });

    it("recommends traffic when only traffic query returns data", async () => {
      const topo = buildTopologyResponse({
        presenceSensors: 1,
        trafficSensors: 1,
      });
      setupTopologyMocks(topo);

      const emptyPresence = mockReportingBuilder({ data: [] });
      const trafficWithData = mockReportingBuilder({
        data: [{ time: "2025-10-14T14:00:00Z", value: 8 }],
      });

      let callCount = 0;
      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(() => {
        callCount++;
        return (callCount === 1 ? emptyPresence : trafficWithData) as any;
      });

      const result = await executeGetOccupancyTimeseries({
        asset_ids: ["room_100"],
        interval: "1h",
        start: "-24h",
        stop: "now",
      });

      const asset = result.assets[0];
      expect(asset.recommended_measurement).toBe("traffic");
      expect(asset.recommendation_reason).toContain("Traffic");
    });
  });

  describe("Query failure handling", () => {
    it("adds warning when presence timeseries query fails", async () => {
      const topo = buildTopologyResponse({ presenceSensors: 1 });
      setupTopologyMocks(topo);

      const failingBuilder = mockReportingBuilder(null);
      failingBuilder.execute.mockRejectedValue(new Error("Network timeout"));

      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(
        () => failingBuilder as any
      );

      const result = await executeGetOccupancyTimeseries({
        asset_ids: ["room_100"],
        interval: "1h",
        start: "-24h",
        stop: "now",
      });

      const asset = result.assets[0];
      expect(asset.presence.warning).toContain("Failed to retrieve");
      expect(asset.presence.timeseries).toHaveLength(0);
    });
  });

  describe("Response structure", () => {
    it("includes all required top-level fields", async () => {
      const topo = buildTopologyResponse({ presenceSensors: 1 });
      setupTopologyMocks(topo);

      const builder = mockReportingBuilder({ data: [] });
      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(() => builder as any);

      const result = await executeGetOccupancyTimeseries({
        asset_ids: ["room_100"],
        interval: "1h",
        start: "-24h",
        stop: "now",
      });

      expect(result.interval).toBe("1h");
      expect(result.start).toBe("-24h");
      expect(result.stop).toBe("now");
      expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result.timezone_note).toBeDefined();
      expect(result.assets).toHaveLength(1);

      const asset = result.assets[0];
      expect(asset.site_timezone).toBe("America/Los_Angeles");
      expect(asset.presence).toBeDefined();
      expect(asset.traffic).toBeDefined();
    });
  });

  // Regression for B3 (parallel to the current-occupancy test): the timeseries
  // tool's presence gate (`assetType === "zone" || presenceSensors.length > 0`)
  // applied to butlr-get-occupancy-timeseries.ts independently of
  // butlr-get-current-occupancy.ts. Without this dedicated test, a regression
  // of the timeseries gate alone would ship undetected.
  describe("Regression: B3 — always query zone_occupancy regardless of sensor count", () => {
    it("returns zone_occupancy timeseries for a zone with 0 sensors", async () => {
      const floorId = "space_zone_test";
      const zoneTopo = {
        topology: {
          data: {
            sites: {
              data: [
                {
                  id: "site_001",
                  name: "Test Site",
                  timezone: "America/Los_Angeles",
                  org_id: "org_001",
                  buildings: [
                    {
                      id: "building_001",
                      name: "Building",
                      site_id: "site_001",
                      floors: [
                        {
                          id: floorId,
                          name: "Floor 1",
                          building_id: "building_001",
                          rooms: [],
                          zones: [
                            {
                              id: "zone_target",
                              name: "Test Zone A",
                              floor_id: floorId,
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
          loading: false,
          networkStatus: 7,
        },
        sensors: {
          data: { sensors: { data: [] } },
          loading: false,
          networkStatus: 7,
        },
      };
      setupTopologyMocks(zoneTopo);

      const presenceBuilder = mockReportingBuilder({
        data: [
          { time: "2025-10-14T15:00:00Z", value: 2 },
          { time: "2025-10-14T16:00:00Z", value: 4 },
        ],
      });
      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(
        () => presenceBuilder as any
      );

      const result = await executeGetOccupancyTimeseries({
        asset_ids: ["zone_target"],
        interval: "1h",
        start: "-24h",
        stop: "now",
      });

      const asset = result.assets[0];
      expect(asset.asset_id).toBe("zone_target");
      expect(asset.asset_type).toBe("zone");
      // Pre-fix: gated on presenceSensors.length > 0 (always 0 for zones), so
      // available was false and timeseries was empty even when the Reporting
      // API had data.
      expect(asset.presence.available).toBe(true);
      expect(asset.presence.sensor_count).toBe(0);
      expect(asset.presence.timeseries).toHaveLength(2);
      // Must have fired the zone-specific measurement, not room_occupancy.
      expect(presenceBuilder.measurements).toHaveBeenCalledWith(["zone_occupancy"]);
      expect(presenceBuilder.execute).toHaveBeenCalledTimes(1);
    });

    it("reports correct sensor_count for a zone with directly-attributed sensors", async () => {
      // Companion to the current-occupancy variant: assert the timeseries
      // tool surfaces zone.sensors rather than a hardcoded 0.
      const floorId = "space_zone_with_sensor_ts";
      const zoneTopo = {
        topology: {
          data: {
            sites: {
              data: [
                {
                  id: "site_001",
                  name: "Test Site",
                  timezone: "America/Los_Angeles",
                  org_id: "org_001",
                  buildings: [
                    {
                      id: "building_001",
                      name: "Building",
                      site_id: "site_001",
                      floors: [
                        {
                          id: floorId,
                          name: "Floor 1",
                          building_id: "building_001",
                          rooms: [],
                          zones: [
                            {
                              id: "zone_with_sensor_ts",
                              name: "Test Zone A",
                              floor_id: floorId,
                              sensors: [
                                {
                                  id: "sensor_zone_ts1",
                                  mac_address: "00:17:0d:00:00:6d:f3:0d",
                                  mode: "presence",
                                  floor_id: floorId,
                                  hive_serial: "HIVE001",
                                  is_entrance: false,
                                  is_online: true,
                                },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
          loading: false,
          networkStatus: 7,
        },
        sensors: {
          data: { sensors: { data: [] } },
          loading: false,
          networkStatus: 7,
        },
      };
      setupTopologyMocks(zoneTopo);

      const presenceBuilder = mockReportingBuilder({
        data: [{ time: "2025-10-14T15:00:00Z", value: 1 }],
      });
      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(
        () => presenceBuilder as any
      );

      const result = await executeGetOccupancyTimeseries({
        asset_ids: ["zone_with_sensor_ts"],
        interval: "1h",
        start: "-24h",
        stop: "now",
      });

      const asset = result.assets[0];
      expect(asset.asset_type).toBe("zone");
      expect(asset.presence.sensor_count).toBe(1);
      // Coverage note should reflect the real sensor count (mirrors the
      // current-occupancy sibling test).
      expect(asset.presence.coverage_note).not.toMatch(/^Zones support presence/);
    });
  });

  // A room whose sensors were moved to a re-mapped copy has 0 sensors today
  // but still holds its history under its own room_id. The old gate skipped
  // the query, so the tool reported "No presence sensors" for past ranges
  // that the Reporting API could answer.
  describe("Rooms with 0 sensors today", () => {
    it("returns room_occupancy history for a room whose sensors were moved", async () => {
      const topo = buildTopologyResponse({ presenceSensors: 0, roomId: "room_old" });
      setupTopologyMocks(topo);

      const presenceBuilder = mockReportingBuilder({
        data: [
          { time: "2026-10-01T04:00:00Z", value: 3 },
          { time: "2026-10-02T04:00:00Z", value: 5 },
        ],
      });
      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(
        () => presenceBuilder as any
      );

      const result = await executeGetOccupancyTimeseries({
        asset_ids: ["room_old"],
        interval: "1d",
        start: "2026-09-20T00:00:00Z",
        stop: "2026-10-16T00:00:00Z",
      });

      const asset = result.assets[0];
      expect(presenceBuilder.measurements).toHaveBeenCalledWith(["room_occupancy"]);
      expect(asset.presence.available).toBe(true);
      expect(asset.presence.sensor_count).toBe(0);
      expect(asset.presence.timeseries).toHaveLength(2);
      expect(asset.presence.coverage_note).toMatch(/assigned to it earlier/);
      expect(asset.recommended_measurement).toBe("presence");
    });

    it("still reports no presence sensors when a 0-sensor room has no history", async () => {
      const topo = buildTopologyResponse({ presenceSensors: 0, roomId: "room_empty" });
      setupTopologyMocks(topo);

      const presenceBuilder = mockReportingBuilder({ data: [] });
      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(
        () => presenceBuilder as any
      );

      const result = await executeGetOccupancyTimeseries({
        asset_ids: ["room_empty"],
        interval: "1h",
        start: "-24h",
        stop: "now",
      });

      const asset = result.assets[0];
      expect(presenceBuilder.execute).toHaveBeenCalledTimes(1);
      expect(asset.presence.available).toBe(false);
      expect(asset.presence.coverage_note).toBe("No presence sensors on this room.");
      expect(asset.recommended_measurement).toBe("none");
    });

    it("returns floor_occupancy history for a floor with 0 sensors today", async () => {
      const topo = buildTopologyResponse({ presenceSensors: 0, floorId: "space_old" });
      setupTopologyMocks(topo);

      const presenceBuilder = mockReportingBuilder({
        data: [{ time: "2026-10-01T04:00:00Z", value: 12 }],
      });
      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(
        () => presenceBuilder as any
      );

      const result = await executeGetOccupancyTimeseries({
        asset_ids: ["space_old"],
        interval: "1d",
        start: "2026-09-20T00:00:00Z",
        stop: "2026-10-16T00:00:00Z",
      });

      const asset = result.assets[0];
      expect(asset.asset_type).toBe("floor");
      expect(presenceBuilder.measurements).toHaveBeenCalledWith(["floor_occupancy"]);
      expect(asset.presence.available).toBe(true);
      expect(asset.presence.timeseries).toHaveLength(1);
      expect(asset.presence.coverage_note).toMatch(/assigned to it earlier/);
    });

    describe("a failed lookup on a 0-sensor room", () => {
      // Two rooms on one floor: room_live has a sensor, room_old has none.
      function setupMixedBatch() {
        const topo = buildTopologyResponse({ presenceSensors: 1, roomId: "room_live" });
        topo.topology.data.sites.data[0].buildings[0].floors[0].rooms.push({
          id: "room_old",
          name: "Pilot - Drop In",
          floorID: "space_100",
          capacity: { max: 4 },
        });
        setupTopologyMocks(topo);
      }

      // Builder whose execute() answers per room id.
      function mockBuilderByRoom(byRoom: Record<string, () => Promise<unknown>>) {
        vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(() => {
          let roomId = "";
          const builder = mockReportingBuilder(null);
          builder.assets.mockImplementation((_type: string, ids: string[]) => {
            roomId = ids[0];
            return builder;
          });
          builder.execute.mockImplementation(() => byRoom[roomId]());
          return builder as any;
        });
      }

      it("does not fail the batch on a 429, and does not claim there is no history", async () => {
        setupMixedBatch();
        mockBuilderByRoom({
          room_live: async () => ({ data: [{ time: "2026-10-01T04:00:00Z", value: 2 }] }),
          room_old: async () => {
            throw new reportingClient.ApiError(429, "Rate limit exceeded.");
          },
        });

        const result = await executeGetOccupancyTimeseries({
          asset_ids: ["room_old", "room_live"],
          interval: "1d",
          start: "2026-09-20T00:00:00Z",
          stop: "2026-10-16T00:00:00Z",
        });

        // Order follows asset_ids despite concurrent processing.
        expect(result.assets.map((a) => a.asset_id)).toEqual(["room_old", "room_live"]);
        const [old, live] = result.assets;
        expect(live.presence.timeseries).toHaveLength(1);
        expect(old.presence.available).toBe(false);
        expect(old.presence.warning).toContain("Failed to retrieve");
        expect(old.presence.coverage_note).toMatch(
          /lookup for history from earlier sensors failed/
        );
        expect(old.presence.coverage_note).not.toBe("No presence sensors on this room.");
      });

      it("still fails the call on an auth error", async () => {
        setupMixedBatch();
        mockBuilderByRoom({
          room_live: async () => ({ data: [] }),
          room_old: async () => {
            throw new reportingClient.ApiError(401, "Authentication failed.");
          },
        });

        await expect(
          executeGetOccupancyTimeseries({
            asset_ids: ["room_old", "room_live"],
            interval: "1d",
            start: "2026-09-20T00:00:00Z",
            stop: "2026-10-16T00:00:00Z",
          })
        ).rejects.toMatchObject({ statusCode: 401 });
      });

      it("still fails the call on a 4xx for a room that has sensors", async () => {
        setupMixedBatch();
        mockBuilderByRoom({
          room_live: async () => {
            throw new reportingClient.ApiError(400, "Invalid request parameters.");
          },
          room_old: async () => ({ data: [] }),
        });

        await expect(
          executeGetOccupancyTimeseries({
            asset_ids: ["room_old", "room_live"],
            interval: "1d",
            start: "2026-09-20T00:00:00Z",
            stop: "2026-10-16T00:00:00Z",
          })
        ).rejects.toMatchObject({ statusCode: 400 });
      });
    });
  });

  describe("Null site timezone fallback", () => {
    it("falls back to UTC with warnings when site timezone is null", async () => {
      const topo = buildTopologyResponse({ presenceSensors: 1, siteTimezone: null });
      setupTopologyMocks(topo);

      const builder = mockReportingBuilder({
        data: [{ time: "2025-10-14T15:00:00Z", value: 4 }],
      });
      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(() => builder as any);

      const result = await executeGetOccupancyTimeseries({
        asset_ids: ["room_100"],
        interval: "1h",
        start: "-24h",
        stop: "now",
      });

      const asset = result.assets[0];
      expect(asset.site_timezone).toBe("UTC");
      expect(asset.timezone_warning).toMatch(/Could not determine site timezone/);
      expect(result.timezone_note).toContain("WARNING");
      expect(result.timezone_note).toContain("fallback");
    });

    it("passes timezone to window aggregation", async () => {
      const topo = buildTopologyResponse({ presenceSensors: 1, siteTimezone: "Asia/Tokyo" });
      setupTopologyMocks(topo);

      const builder = mockReportingBuilder({
        data: [{ time: "2025-10-14T15:00:00Z", value: 4 }],
      });
      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(() => builder as any);

      await executeGetOccupancyTimeseries({
        asset_ids: ["room_100"],
        interval: "1h",
        start: "-24h",
        stop: "now",
      });

      // Verify .window() was called with the site timezone
      expect(builder.window).toHaveBeenCalledWith("1h", "median", "Asia/Tokyo");
    });
  });

  // Salesforce Indy Tower Floor 7: the old "Pilot - *" room was archived
  // when the floor was re-drawn, and its "_V2" copy took over its sensors
  // with `replacesID` pointing back at it.
  describe("Archived and replaced spaces", () => {
    // 01:30 UTC on Oct 21 is 18:30 on Oct 20 in Los Angeles (the site tz).
    const ARCHIVED_AT = "2026-10-21T01:30:00Z";

    function setupFloor7(opts?: { successorName?: string }) {
      const topo = buildTopologyResponse({ presenceSensors: 1, roomId: "room_v2" });
      const rooms = topo.topology.data.sites.data[0].buildings[0].floors[0].rooms as Array<
        Record<string, unknown>
      >;
      rooms[0].name = opts?.successorName ?? "Drop In_V2";
      rooms[0].replacesID = "room_old";
      rooms.push({
        id: "room_old",
        name: "Pilot - Drop In",
        floorID: "space_100",
        capacity: { max: 4 },
        archivedAt: ARCHIVED_AT,
      });
      setupTopologyMocks(topo);
    }

    it("an archived room returns its history with an archive note instead of the 0-sensor guess", async () => {
      setupFloor7();
      const presenceBuilder = mockReportingBuilder({
        data: [
          { time: "2026-10-19T04:00:00Z", value: 3 },
          { time: "2026-10-20T04:00:00Z", value: 2 },
        ],
      });
      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(
        () => presenceBuilder as any
      );

      const result = await executeGetOccupancyTimeseries({
        asset_ids: ["room_old"],
        interval: "1d",
        start: "2026-10-01T00:00:00Z",
        stop: "2026-10-23T00:00:00Z",
      });

      const asset = result.assets[0];
      expect(presenceBuilder.measurements).toHaveBeenCalledWith(["room_occupancy"]);
      expect(asset.presence.available).toBe(true);
      expect(asset.presence.timeseries).toHaveLength(2);
      expect(asset.presence.coverage_note).toBe(
        "This room was archived on 2026-10-20; history recorded until then."
      );
      expect(asset.presence.coverage_note).not.toMatch(/assigned to it earlier/);
      expect(asset.archived_at).toBe(ARCHIVED_AT);
      expect(asset.replaced_by).toEqual([{ id: "room_v2", name: "Drop In_V2" }]);
      expect(asset.history_note).toContain("archived on 2026-10-20; history recorded until then");
      expect(asset.history_note).toContain('Replaced by "Drop In_V2" (room_v2)');
      expect(asset.recommended_measurement).toBe("presence");
    });

    it("an archived room with no data in range explains the archive, not 'instrument it'", async () => {
      setupFloor7();
      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(
        () => mockReportingBuilder({ data: [] }) as any
      );

      const result = await executeGetOccupancyTimeseries({
        asset_ids: ["room_old"],
        interval: "1h",
        start: "2026-10-22T00:00:00Z",
        stop: "2026-10-23T00:00:00Z",
      });

      const asset = result.assets[0];
      expect(asset.presence.available).toBe(false);
      expect(asset.recommended_measurement).toBe("none");
      expect(asset.recommendation_reason).toMatch(/archived on 2026-10-20/);
      expect(asset.recommendation_reason).toContain('"Drop In_V2" (room_v2)');
      expect(asset.recommendation_reason).not.toMatch(/Contact facilities/);
    });

    it("a failed lookup on an archived room warns on that asset without failing the batch", async () => {
      setupFloor7();
      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(() => {
        let roomId = "";
        const builder = mockReportingBuilder(null);
        builder.assets.mockImplementation((_type: string, ids: string[]) => {
          roomId = ids[0];
          return builder;
        });
        builder.execute.mockImplementation(async () => {
          if (roomId === "room_old") throw new reportingClient.ApiError(503, "Unavailable");
          return { data: [{ time: "2026-10-22T04:00:00Z", value: 1 }] };
        });
        return builder as any;
      });

      const result = await executeGetOccupancyTimeseries({
        asset_ids: ["room_old", "room_v2"],
        interval: "1d",
        start: "2026-10-01T00:00:00Z",
        stop: "2026-10-23T00:00:00Z",
      });

      const [old, v2] = result.assets;
      expect(v2.presence.timeseries).toHaveLength(1);
      expect(old.presence.warning).toContain("Failed to retrieve");
      expect(old.presence.coverage_note).toMatch(/archived on 2026-10-20, and the lookup/);
      expect(old.recommendation_reason).toContain("Failed");
    });

    it("a replacement names its predecessor so the caller can fetch the earlier history", async () => {
      setupFloor7();
      const presenceBuilder = mockReportingBuilder({
        data: [{ time: "2026-10-22T04:00:00Z", value: 5 }],
      });
      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(
        () => presenceBuilder as any
      );

      const result = await executeGetOccupancyTimeseries({
        asset_ids: ["room_v2"],
        interval: "1d",
        start: "2026-10-01T00:00:00Z",
        stop: "2026-10-23T00:00:00Z",
      });

      const asset = result.assets[0];
      // v1 does not merge series: one query, for this room only.
      expect(presenceBuilder.execute).toHaveBeenCalledTimes(1);
      expect(presenceBuilder.assets).toHaveBeenCalledWith("room", ["room_v2"]);
      expect(asset.presence.timeseries).toHaveLength(1);
      expect(asset.archived_at).toBeUndefined();
      expect(asset.replaces).toEqual({
        id: "room_old",
        name: "Pilot - Drop In",
        archived_at: ARCHIVED_AT,
      });
      expect(asset.history_note).toBe(
        'This room replaces "Pilot - Drop In" (room_old), archived on 2026-10-20. ' +
          "This series covers room_v2 only; for history before the switch-over, query room_old separately."
      );
    });

    it("an active space that replaces nothing carries no lifecycle fields", async () => {
      setupTopologyMocks(buildTopologyResponse({ presenceSensors: 1 }));
      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(
        () => mockReportingBuilder({ data: [] }) as any
      );

      const result = await executeGetOccupancyTimeseries({
        asset_ids: ["room_100"],
        interval: "1h",
        start: "-24h",
        stop: "now",
      });

      const asset = result.assets[0];
      for (const key of ["archived_at", "replaces", "replaced_by", "history_note"]) {
        expect(asset).not.toHaveProperty(key);
      }
    });

    describe("against an API without the archive fields", () => {
      // What the API's validator answers when the extended topology query
      // selects fields its schema does not have yet.
      const rejected = {
        data: undefined,
        error: new CombinedGraphQLErrors({
          errors: [{ message: 'Cannot query field "archivedAt" on type "Room".' }],
        }),
      };

      function mockApiWithoutArchiveFields(topo: ReturnType<typeof buildTopologyResponse>) {
        vi.mocked(apolloClient.query).mockImplementation((async (opts: { query: unknown }) => {
          if (opts.query === GET_FULL_TOPOLOGY) return rejected;
          if (opts.query === GET_FULL_TOPOLOGY_LEGACY) return topo.topology;
          if (opts.query === GET_ALL_SENSORS) return topo.sensors;
          throw new Error("unexpected query");
        }) as never);
      }

      it("falls back to the legacy topology query and keeps the v0.6.2 behaviour", async () => {
        const topo = buildTopologyResponse({ presenceSensors: 0, roomId: "room_old" });
        mockApiWithoutArchiveFields(topo);
        vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(
          () => mockReportingBuilder({ data: [{ time: "2026-10-01T04:00:00Z", value: 3 }] }) as any
        );

        const result = await executeGetOccupancyTimeseries({
          asset_ids: ["room_old"],
          interval: "1d",
          start: "2026-09-20T00:00:00Z",
          stop: "2026-10-16T00:00:00Z",
        });

        const sent = vi.mocked(apolloClient.query).mock.calls.map((c) => c[0].query);
        expect(sent).toEqual([GET_FULL_TOPOLOGY, GET_ALL_SENSORS, GET_FULL_TOPOLOGY_LEGACY]);
        const asset = result.assets[0];
        expect(asset.presence.available).toBe(true);
        expect(asset.presence.coverage_note).toMatch(/assigned to it earlier/);
        expect(asset).not.toHaveProperty("archived_at");
      });

      it("goes straight to the legacy query on the next call", async () => {
        const topo = buildTopologyResponse({ presenceSensors: 1 });
        mockApiWithoutArchiveFields(topo);
        vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(
          () => mockReportingBuilder({ data: [] }) as any
        );
        const args = {
          asset_ids: ["room_100"],
          interval: "1h" as const,
          start: "-24h",
          stop: "now",
        };

        await executeGetOccupancyTimeseries(args);
        vi.mocked(apolloClient.query).mockClear();
        await executeGetOccupancyTimeseries(args);

        const sent = vi.mocked(apolloClient.query).mock.calls.map((c) => c[0].query);
        expect(sent).toEqual([GET_FULL_TOPOLOGY_LEGACY, GET_ALL_SENSORS]);
      });

      it("still fails on an unrelated topology error", async () => {
        vi.mocked(apolloClient.query).mockImplementation((async (opts: { query: unknown }) => {
          if (opts.query === GET_FULL_TOPOLOGY) {
            return {
              data: undefined,
              error: new CombinedGraphQLErrors({ errors: [{ message: "Internal server error" }] }),
            };
          }
          return buildTopologyResponse().sensors;
        }) as never);

        await expect(
          executeGetOccupancyTimeseries({
            asset_ids: ["room_100"],
            interval: "1h",
            start: "-24h",
            stop: "now",
          })
        ).rejects.toThrow(/Internal server error/);
        const sent = vi.mocked(apolloClient.query).mock.calls.map((c) => c[0].query);
        expect(sent).not.toContain(GET_FULL_TOPOLOGY_LEGACY);
      });
    });
  });
});
