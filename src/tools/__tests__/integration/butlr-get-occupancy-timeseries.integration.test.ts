import { describe, it, expect, beforeEach, vi } from "vitest";
import { executeGetOccupancyTimeseries } from "../../butlr-get-occupancy-timeseries.js";
import { apolloClient } from "../../../clients/graphql-client.js";
import * as reportingClient from "../../../clients/reporting-client.js";

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
});
