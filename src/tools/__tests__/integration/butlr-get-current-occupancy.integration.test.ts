import { describe, it, expect, beforeEach, vi } from "vitest";
import { executeGetCurrentOccupancy } from "../../butlr-get-current-occupancy.js";
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
 * Build a mock topology response with sensors attached to a room.
 * The fixture includes a site with timezone, one building, one floor, and one room.
 * Optionally includes presence and/or traffic sensors.
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
  const siteTimezone = opts?.siteTimezone !== undefined ? opts.siteTimezone : "America/New_York";
  const presenceCount = opts?.presenceSensors ?? 1;
  const trafficCount = opts?.trafficSensors ?? 0;

  const presenceSensors = Array.from({ length: presenceCount }, (_, i) => ({
    id: `sensor_p${i}`,
    name: `Presence Sensor ${i}`,
    mac_address: `aa:bb:cc:dd:ee:0${i}`,
    mode: "presence",
    model: "M50",
    floor_id: floorId,
    room_id: roomId,
    hive_serial: "HIVE001",
    is_online: true,
    is_entrance: false,
    height: 3,
    center: [0, 0],
    orientation: [0, 0],
    field_of_view: 120,
    door_line: 0,
    in_direction: 0,
    parallel_to_door: false,
    sensitivity: 5,
  }));

  const trafficSensors = Array.from({ length: trafficCount }, (_, i) => ({
    id: `sensor_t${i}`,
    name: `Traffic Sensor ${i}`,
    mac_address: `aa:bb:cc:dd:ff:0${i}`,
    mode: "traffic",
    model: "M50",
    floor_id: floorId,
    room_id: roomId,
    hive_serial: "HIVE001",
    is_online: true,
    is_entrance: false, // room-level traffic (not entrance)
    height: 3,
    center: [0, 0],
    orientation: [0, 0],
    field_of_view: 120,
    door_line: 0,
    in_direction: 0,
    parallel_to_door: false,
    sensitivity: 5,
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

/**
 * Create a mock ReportingRequestBuilder that returns the given response on execute().
 */
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

/**
 * Set up apolloClient.query to return topology, then sensors, in order.
 */
function setupTopologyMocks(topo: ReturnType<typeof buildTopologyResponse>) {
  vi.mocked(apolloClient.query)
    .mockResolvedValueOnce(topo.topology as any) // GET_FULL_TOPOLOGY
    .mockResolvedValueOnce(topo.sensors as any); // GET_ALL_SENSORS
}

describe("butlr_get_current_occupancy - Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Basic room query", () => {
    it("returns current presence occupancy for a room", async () => {
      const topo = buildTopologyResponse({ presenceSensors: 2 });
      setupTopologyMocks(topo);

      // Mock the ReportingRequestBuilder to return presence data, then empty traffic
      const presenceBuilder = mockReportingBuilder({
        data: [{ time: "2025-10-14T15:04:00Z", value: 3 }],
      });
      const trafficBuilder = mockReportingBuilder({ data: [] });

      let callCount = 0;
      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(() => {
        callCount++;
        return (callCount === 1 ? presenceBuilder : trafficBuilder) as any;
      });

      const result = await executeGetCurrentOccupancy({
        asset_ids: ["room_100"],
      });

      expect(result.assets).toHaveLength(1);
      const asset = result.assets[0];
      expect(asset.asset_id).toBe("room_100");
      expect(asset.asset_type).toBe("room");
      expect(asset.asset_name).toBe("Conference Room A");
      expect(asset.presence.available).toBe(true);
      expect(asset.presence.current_occupancy).toBe(3);
      expect(asset.presence.sensor_count).toBe(2);
      expect(asset.traffic.available).toBe(false);
      expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(result.timezone_note).toContain("UTC");
    });
  });

  describe("Asset type validation", () => {
    it("throws for building IDs (only floor/room/zone supported)", async () => {
      const topo = buildTopologyResponse();
      setupTopologyMocks(topo);

      await expect(executeGetCurrentOccupancy({ asset_ids: ["building_123"] })).rejects.toThrow(
        /must be a floor, room, or zone/
      );
    });

    it("throws for site IDs", async () => {
      const topo = buildTopologyResponse();
      setupTopologyMocks(topo);

      await expect(executeGetCurrentOccupancy({ asset_ids: ["site_123"] })).rejects.toThrow(
        /must be a floor, room, or zone/
      );
    });
  });

  describe("Recommendation logic", () => {
    it("recommends presence when presence data was actually retrieved", async () => {
      const topo = buildTopologyResponse({ presenceSensors: 1 });
      setupTopologyMocks(topo);

      const presenceBuilder = mockReportingBuilder({
        data: [{ time: "2025-10-14T15:04:00Z", value: 5 }],
      });

      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(
        () => presenceBuilder as any
      );

      const result = await executeGetCurrentOccupancy({
        asset_ids: ["room_100"],
      });

      const asset = result.assets[0];
      expect(asset.recommended_measurement).toBe("presence");
      expect(asset.recommendation_reason).toContain("Presence");
    });

    it("recommends none when sensors exist but query returns empty data", async () => {
      const topo = buildTopologyResponse({ presenceSensors: 1 });
      setupTopologyMocks(topo);

      // Sensors exist but the reporting API returns no data points
      const emptyBuilder = mockReportingBuilder({ data: [] });

      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(
        () => emptyBuilder as any
      );

      const result = await executeGetCurrentOccupancy({
        asset_ids: ["room_100"],
      });

      const asset = result.assets[0];
      expect(asset.recommended_measurement).toBe("none");
    });
  });

  describe("Warning on query failure", () => {
    it("adds warning when presence query fails but sensors exist", async () => {
      const topo = buildTopologyResponse({ presenceSensors: 2 });
      setupTopologyMocks(topo);

      const failingBuilder = mockReportingBuilder(null);
      failingBuilder.execute.mockRejectedValue(new Error("API timeout"));

      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(
        () => failingBuilder as any
      );

      const result = await executeGetCurrentOccupancy({
        asset_ids: ["room_100"],
      });

      const asset = result.assets[0];
      expect(asset.presence.warning).toContain("Failed to retrieve");
      expect(asset.presence.current_occupancy).toBeUndefined();
      expect(asset.recommended_measurement).toBe("none");
    });
  });

  describe("Multiple assets in one call", () => {
    it("processes two rooms independently", async () => {
      // Build topology with two rooms on the same floor
      const floorId = "space_200";
      const topoData = {
        topology: {
          data: {
            sites: {
              data: [
                {
                  id: "site_001",
                  name: "Test Site",
                  timezone: "America/New_York",
                  org_id: "org_001",
                  buildings: [
                    {
                      id: "building_001",
                      name: "Main Building",
                      site_id: "site_001",
                      floors: [
                        {
                          id: floorId,
                          name: "Floor 2",
                          building_id: "building_001",
                          rooms: [
                            {
                              id: "room_201",
                              name: "Room Alpha",
                              floorID: floorId,
                              capacity: { max: 8 },
                            },
                            {
                              id: "room_202",
                              name: "Room Beta",
                              floorID: floorId,
                              capacity: { max: 12 },
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
              data: [
                {
                  id: "sensor_a1",
                  mac_address: "aa:00:00:00:00:01",
                  mode: "presence",
                  floor_id: floorId,
                  room_id: "room_201",
                  hive_serial: "HIVE001",
                  is_entrance: false,
                  is_online: true,
                },
                {
                  id: "sensor_b1",
                  mac_address: "aa:00:00:00:00:02",
                  mode: "presence",
                  floor_id: floorId,
                  room_id: "room_202",
                  hive_serial: "HIVE001",
                  is_entrance: false,
                  is_online: true,
                },
              ],
            },
          },
          loading: false,
          networkStatus: 7,
        },
      };

      vi.mocked(apolloClient.query)
        .mockResolvedValueOnce(topoData.topology as any)
        .mockResolvedValueOnce(topoData.sensors as any);

      // Each room gets its own ReportingRequestBuilder call
      const builders = [
        mockReportingBuilder({ data: [{ time: "2025-10-14T15:04:00Z", value: 4 }] }),
        mockReportingBuilder({ data: [{ time: "2025-10-14T15:04:00Z", value: 7 }] }),
      ];
      let callIdx = 0;
      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(
        () => builders[callIdx++] as any
      );

      const result = await executeGetCurrentOccupancy({
        asset_ids: ["room_201", "room_202"],
      });

      expect(result.assets).toHaveLength(2);
      expect(result.assets[0].asset_id).toBe("room_201");
      expect(result.assets[0].asset_name).toBe("Room Alpha");
      expect(result.assets[0].presence.current_occupancy).toBe(4);
      expect(result.assets[1].asset_id).toBe("room_202");
      expect(result.assets[1].asset_name).toBe("Room Beta");
      expect(result.assets[1].presence.current_occupancy).toBe(7);
    });
  });

  describe("Both presence and traffic data", () => {
    it("returns both measurement types when both sensor types exist", async () => {
      const topo = buildTopologyResponse({
        presenceSensors: 1,
        trafficSensors: 1,
      });
      setupTopologyMocks(topo);

      const presenceBuilder = mockReportingBuilder({
        data: [{ time: "2025-10-14T15:04:00Z", value: 5 }],
      });
      const trafficBuilder = mockReportingBuilder({
        data: [{ time: "2025-10-14T15:04:00Z", value: 12 }],
      });

      let callCount = 0;
      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(() => {
        callCount++;
        return (callCount === 1 ? presenceBuilder : trafficBuilder) as any;
      });

      const result = await executeGetCurrentOccupancy({
        asset_ids: ["room_100"],
      });

      const asset = result.assets[0];
      expect(asset.presence.available).toBe(true);
      expect(asset.presence.current_occupancy).toBe(5);
      expect(asset.traffic.available).toBe(true);
      expect(asset.traffic.current_occupancy).toBe(12);
      expect(asset.recommended_measurement).toBe("presence");
      expect(asset.recommendation_reason).toContain("Both available");
    });
  });

  describe("Response structure", () => {
    it("includes timezone metadata from the site", async () => {
      const topo = buildTopologyResponse({ presenceSensors: 1 });
      setupTopologyMocks(topo);

      const builder = mockReportingBuilder({
        data: [{ time: "2025-10-14T15:04:00Z", value: 2 }],
      });
      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(() => builder as any);

      const result = await executeGetCurrentOccupancy({
        asset_ids: ["room_100"],
      });

      const asset = result.assets[0];
      expect(asset.site_timezone).toBe("America/New_York");
      expect(asset.timezone_offset).toBeDefined();
      expect(asset.timezone_abbr).toBeDefined();
    });
  });

  // Regression test for B3: zones have separate sensor attribution from rooms —
  // `zone_occupancy` is computed server-side and there's no client-visible sensor
  // count. Pre-fix, the tool gated the presence query on `presenceSensors.length > 0`
  // (which is always 0 for zones because zones don't have direct sensor assignments),
  // so the query never fired and zones reported `available: false` even when the
  // Reporting API had data for them.
  describe("Regression: B3 — always query zone_occupancy regardless of sensor count", () => {
    it("queries zone_occupancy for a zone with no client-visible sensors", async () => {
      const floorId = "space_zone_test";
      const zoneTopo = {
        topology: {
          data: {
            sites: {
              data: [
                {
                  id: "site_001",
                  name: "Test Site",
                  timezone: "America/New_York",
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
                          rooms: [
                            {
                              id: "room_parent",
                              name: "Parent Room",
                              floor_id: floorId,
                              capacity: {},
                            },
                          ],
                          zones: [
                            {
                              id: "zone_target",
                              name: "Test Zone A",
                              floor_id: floorId,
                              room_id: "room_parent",
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
          // No sensors at all — zones still have no client-visible attribution
          data: { sensors: { data: [] } },
          loading: false,
          networkStatus: 7,
        },
      };
      setupTopologyMocks(zoneTopo);

      // The Reporting API has zone_occupancy data for this zone (server-derived).
      const presenceBuilder = mockReportingBuilder({
        data: [{ time: "2025-10-14T15:04:00Z", value: 2 }],
      });
      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(
        () => presenceBuilder as any
      );

      const result = await executeGetCurrentOccupancy({ asset_ids: ["zone_target"] });

      const asset = result.assets[0];
      expect(asset.asset_id).toBe("zone_target");
      expect(asset.asset_type).toBe("zone");
      expect(asset.asset_name).toBe("Test Zone A");
      // Pre-fix: available was false (sensor_count === 0). Post-fix: zones are
      // always available — actual data presence is reflected in current_occupancy.
      expect(asset.presence.available).toBe(true);
      expect(asset.presence.current_occupancy).toBe(2);
      expect(asset.presence.sensor_count).toBe(0); // zones genuinely have no client-side sensors
      expect(asset.recommended_measurement).toBe("presence");
      // The presence query MUST have been issued for the zone — pre-fix this builder
      // would never have been touched.
      expect(presenceBuilder.execute).toHaveBeenCalledTimes(1);
      // zone_occupancy is the correct measurement name (not room_occupancy).
      expect(presenceBuilder.measurements).toHaveBeenCalledWith(["zone_occupancy"]);
    });

    it("zone with no Reporting data still reports available=true (we can ask) but recommended=none", async () => {
      const floorId = "space_zone_test";
      const zoneTopo = {
        topology: {
          data: {
            sites: {
              data: [
                {
                  id: "site_001",
                  name: "Test Site",
                  timezone: "America/New_York",
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
                              id: "zone_dark",
                              name: "Dark Zone",
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

      // The Reporting API returns no data for this zone.
      const emptyBuilder = mockReportingBuilder({ data: [] });
      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(
        () => emptyBuilder as any
      );

      const result = await executeGetCurrentOccupancy({ asset_ids: ["zone_dark"] });

      const asset = result.assets[0];
      expect(asset.presence.available).toBe(true); // we can ask
      expect(asset.presence.current_occupancy).toBeUndefined(); // but no data
      expect(asset.recommended_measurement).toBe("none");
    });

    it("reports correct sensor_count for a zone with directly-attributed sensors", async () => {
      // Pre-fix: sensor_count was hardcoded to 0 for every zone, so an LLM
      // consumer would see "no sensors configured" even when the zone has
      // a real presence sensor attached via the GraphQL zone.sensors relation.
      const floorId = "space_zone_with_sensor";
      const zoneTopo = {
        topology: {
          data: {
            sites: {
              data: [
                {
                  id: "site_001",
                  name: "Test Site",
                  timezone: "America/New_York",
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
                              id: "zone_with_sensor",
                              name: "Test Zone A",
                              floor_id: floorId,
                              sensors: [
                                {
                                  id: "sensor_zone_p1",
                                  name: "Test Sensor A",
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
          // The flat sensors list does NOT contain zone-attributed sensors —
          // they only appear nested under zone.sensors in the topology.
          data: { sensors: { data: [] } },
          loading: false,
          networkStatus: 7,
        },
      };
      setupTopologyMocks(zoneTopo);

      const presenceBuilder = mockReportingBuilder({
        data: [{ time: "2025-10-14T15:04:00Z", value: 1 }],
      });
      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(
        () => presenceBuilder as any
      );

      const result = await executeGetCurrentOccupancy({ asset_ids: ["zone_with_sensor"] });
      const asset = result.assets[0];
      expect(asset.asset_type).toBe("zone");
      expect(asset.presence.sensor_count).toBe(1); // NOT 0 (pre-fix value)
      expect(asset.presence.available).toBe(true);
      expect(asset.presence.current_occupancy).toBe(1);
      // Coverage note should reflect the real sensor count.
      expect(asset.presence.coverage_note).not.toMatch(/^Zones support presence/);
    });
  });

  describe("Null site timezone fallback", () => {
    it("falls back to UTC and includes warnings when site timezone is null", async () => {
      const topo = buildTopologyResponse({ presenceSensors: 1, siteTimezone: null });
      setupTopologyMocks(topo);

      const builder = mockReportingBuilder({
        data: [{ time: "2025-10-14T15:04:00Z", value: 5 }],
      });
      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(() => builder as any);

      const result = await executeGetCurrentOccupancy({
        asset_ids: ["room_100"],
      });

      const asset = result.assets[0];
      expect(asset.site_timezone).toBe("UTC");
      expect(asset.timezone_warning).toMatch(/Could not determine site timezone/);
      expect(asset.timezone_warning).toMatch(/UTC/);
      expect(result.timezone_note).toContain("WARNING");
      expect(result.timezone_note).toContain("fallback");
    });

    it("does not include warnings when site timezone is valid", async () => {
      const topo = buildTopologyResponse({ presenceSensors: 1, siteTimezone: "America/New_York" });
      setupTopologyMocks(topo);

      const builder = mockReportingBuilder({
        data: [{ time: "2025-10-14T15:04:00Z", value: 5 }],
      });
      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(() => builder as any);

      const result = await executeGetCurrentOccupancy({
        asset_ids: ["room_100"],
      });

      const asset = result.assets[0];
      expect(asset.timezone_warning).toBeUndefined();
      expect(result.timezone_note).not.toContain("WARNING");
    });
  });
});
