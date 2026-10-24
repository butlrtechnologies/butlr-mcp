import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { executeGetCurrentOccupancy } from "../../butlr-get-current-occupancy.js";
import { apolloClient } from "../../../clients/graphql-client.js";
import * as reportingClient from "../../../clients/reporting-client.js";

// Mock the GraphQL client
import { clearHistoryEndCache } from "../../../cache/history-end-cache.js";
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
    // The history-end probe calls queryReporting directly.
    queryReporting: vi.fn(),
  };
});

/** Answer the history-end probe per space id; unlisted spaces have no history. */
function mockHistoryProbe(bySpace: Record<string, Array<{ time: string; value: number }> | Error>) {
  vi.mocked(reportingClient.queryReporting).mockImplementation(async (request) => {
    const id = request.filter.rooms?.eq[0] ?? request.filter.zones?.eq[0] ?? "";
    const answer = bySpace[id];
    if (answer instanceof Error) throw answer;
    return { data: answer ?? [] };
  });
}

/** Stop-labelled daily buckets (local midnight, New York): 13 on Oct 19, 0 on Oct 20, 0 on Oct 21. */
const INDY_PROBE_DAYS = [
  { time: "2026-10-20T04:00:00Z", value: 13 },
  { time: "2026-10-21T04:00:00Z", value: 0 },
  { time: "2026-10-22T04:00:00Z", value: 0 },
];

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

/** Archived on Oct 22 in New York (the fixture's site timezone). */
const ARCHIVED_OCT_22 = "2026-10-22T20:00:00Z";

describe("butlr_get_current_occupancy - Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockHistoryProbe({});
    clearHistoryEndCache();
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

  describe("Archived and replaced spaces", () => {
    // These fixtures use fixed October 2026 dates; freeze the clock so the
    // lookup window (177 days back from now) keeps covering them.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-23T18:00:00Z"));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    // Archived on Oct 22 (16:00 in New York, the site tz), a day after the
    // sensors moved, so the archive date is not where the history ends.
    const ARCHIVED_AT = "2026-10-22T20:00:00Z";

    function setupArchivedFloor() {
      const topo = buildTopologyResponse({ presenceSensors: 1, roomId: "room_v2" });
      const floor = topo.topology.data.sites.data[0].buildings[0].floors[0] as Record<string, any>;
      floor.rooms[0].name = "Drop In_V2";
      floor.rooms[0].replacesID = "room_old";
      floor.rooms.push({
        id: "room_old",
        name: "Pilot - Drop In",
        floorID: "space_100",
        capacity: { max: 4 },
        archivedAt: ARCHIVED_AT,
      });
      floor.zones.push({
        id: "zone_old",
        name: "Pilot Desk Zone",
        floor_id: "space_100",
        archivedAt: ARCHIVED_AT,
      });
      setupTopologyMocks(topo);
    }

    it("sends one history lookup when a batch names the same archived room twice", async () => {
      setupArchivedFloor();
      mockHistoryProbe({ room_old: INDY_PROBE_DAYS });

      const result = await executeGetCurrentOccupancy({ asset_ids: ["room_old", "room_old"] });

      expect(reportingClient.queryReporting).toHaveBeenCalledTimes(1);
      expect(result.assets.map((a) => a.history_end)).toEqual(["2026-10-20", "2026-10-20"]);
    });

    it("reports an archived room as having no live data instead of querying it", async () => {
      setupArchivedFloor();
      mockHistoryProbe({ room_old: INDY_PROBE_DAYS });
      const builder = mockReportingBuilder({ data: [] });
      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(() => builder as any);

      const result = await executeGetCurrentOccupancy({ asset_ids: ["room_old"] });

      expect(reportingClient.ReportingRequestBuilder).not.toHaveBeenCalled();
      const asset = result.assets[0];
      expect(asset.presence.available).toBe(false);
      expect(asset.presence.coverage_note).toBe(
        "No sensors assigned (archived on 2026-10-22). Recorded history runs up to 2026-10-20."
      );
      // min(day before the archive = Oct 21, data end = Oct 20).
      expect(asset.history_end).toBe("2026-10-20");
      expect(asset.traffic.coverage_note).toBe(asset.presence.coverage_note);
      expect(asset.recommended_measurement).toBe("none");
      expect(asset.recommendation_reason).toBe(
        "This room has no sensors assigned (archived on 2026-10-22), so it has no live readings. " +
          "Its recorded history runs up to 2026-10-20; use butlr_get_occupancy_timeseries for it. " +
          'Its replacement is "Drop In_V2" (room_v2).'
      );
      expect(asset.archived_at).toBe(ARCHIVED_AT);
      expect(asset.replaced_by).toEqual([{ id: "room_v2", name: "Drop In_V2" }]);
      expect(asset.history_note).toContain("butlr_get_occupancy_timeseries");
      expect(asset.history_note).toContain('query its replacement: "Drop In_V2" (room_v2)');
    });

    it("does not query an archived zone, so a reporting error cannot fail the call", async () => {
      setupArchivedFloor();
      const failing = mockReportingBuilder(null);
      failing.execute.mockRejectedValue(new reportingClient.ApiError(400, "Invalid zone"));
      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(() => failing as any);

      const result = await executeGetCurrentOccupancy({ asset_ids: ["zone_old"] });

      expect(failing.execute).not.toHaveBeenCalled();
      const asset = result.assets[0];
      expect(asset.asset_type).toBe("zone");
      expect(asset.presence.available).toBe(false);
      expect(asset.presence.coverage_note).toBe(
        "No sensors assigned (archived on 2026-10-22). No recorded history since 2026-04-29."
      );
      expect(asset.traffic.coverage_note).toBe("Zones do not support traffic.");
      expect(asset.recommendation_reason).toBe(
        "This zone has no sensors assigned (archived on 2026-10-22), so it has no live readings. " +
          "It has no recorded history since 2026-04-29; use butlr_get_occupancy_timeseries to check older ranges."
      );
    });

    it("keeps the archive-date note and warns when the history-end probe fails", async () => {
      setupArchivedFloor();
      mockHistoryProbe({ room_old: new reportingClient.ApiError(503, "Unavailable") });

      const result = await executeGetCurrentOccupancy({ asset_ids: ["room_old"] });

      const asset = result.assets[0];
      expect(asset.presence.coverage_note).toBe(
        "No sensors assigned (archived on 2026-10-22). Use butlr_get_occupancy_timeseries for any history it recorded."
      );
      expect(asset.history_warning).toMatch(/recorded history ends; the lookup failed/);
      expect(asset.history_note).toContain("Use butlr_get_occupancy_timeseries for its history.");
      expect(asset).not.toHaveProperty("history_end");
    });

    it("does not probe an unarchived room with no sensors; points at the timeseries tool", async () => {
      setupTopologyMocks(buildTopologyResponse({ presenceSensors: 0, roomId: "room_bare" }));
      mockHistoryProbe({ room_bare: INDY_PROBE_DAYS });

      const result = await executeGetCurrentOccupancy({ asset_ids: ["room_bare"] });

      const asset = result.assets[0];
      expect(reportingClient.queryReporting).not.toHaveBeenCalled();
      expect(asset.presence.coverage_note).toBe(
        "No sensors assigned. Use butlr_get_occupancy_timeseries for any history it recorded."
      );
      expect(asset).not.toHaveProperty("archived_at");
      expect(asset).not.toHaveProperty("history_end");
      expect(asset.recommendation_reason).toMatch(/No presence sensors configured/);
    });

    it("still reads the live replacement, and points at its predecessor's history", async () => {
      setupArchivedFloor();
      const builder = mockReportingBuilder({ data: [{ time: "2026-10-23T15:04:00Z", value: 2 }] });
      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(() => builder as any);

      const result = await executeGetCurrentOccupancy({ asset_ids: ["room_v2"] });

      const asset = result.assets[0];
      expect(asset.presence.current_occupancy).toBe(2);
      expect(asset.archived_at).toBeUndefined();
      expect(asset.replaces).toEqual({
        id: "room_old",
        name: "Pilot - Drop In",
        archived_at: ARCHIVED_AT,
      });
      expect(asset.history_note).toMatch(/query room_old with butlr_get_occupancy_timeseries/);
    });
  });

  describe("Sensorless detection and probe ordering (review follow-ups)", () => {
    // These fixtures use fixed October 2026 dates; freeze the clock so the
    // lookup window (177 days back from now) keeps covering them.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-23T18:00:00Z"));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    function liveZoneTopology() {
      const topo = buildTopologyResponse({ presenceSensors: 1 });
      (topo.topology.data.sites.data[0].buildings[0].floors[0] as any).zones.push({
        id: "zone_live",
        name: "Lounge Zone",
        floor_id: "space_100",
      });
      return topo;
    }

    it("does not probe a zone with no attributed sensors that reads live", async () => {
      setupTopologyMocks(liveZoneTopology());
      mockHistoryProbe({ zone_live: INDY_PROBE_DAYS });
      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(
        () => mockReportingBuilder({ data: [{ time: "2026-10-23T15:04:00Z", value: 3 }] }) as any
      );

      const result = await executeGetCurrentOccupancy({ asset_ids: ["zone_live"] });

      const asset = result.assets[0];
      expect(reportingClient.queryReporting).not.toHaveBeenCalled();
      expect(asset.presence.current_occupancy).toBe(3);
      expect(asset.presence.coverage_note).not.toMatch(/No sensors assigned/);
      expect(asset).not.toHaveProperty("history_end");
    });

    it("does not probe or call a non-archived zone sensorless when its live read is empty", async () => {
      setupTopologyMocks(liveZoneTopology());
      mockHistoryProbe({ zone_live: INDY_PROBE_DAYS });
      const builder = mockReportingBuilder({ data: [] });
      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(() => builder as any);

      const result = await executeGetCurrentOccupancy({ asset_ids: ["zone_live"] });

      const asset = result.assets[0];
      expect(builder.execute).toHaveBeenCalled();
      expect(reportingClient.queryReporting).not.toHaveBeenCalled();
      expect(asset.presence.available).toBe(true);
      expect(asset.presence.coverage_note).toBe("Zones support presence measurement only.");
      expect(asset.recommendation_reason).not.toMatch(/no live data|No sensors/);
      expect(asset).not.toHaveProperty("history_end");
    });

    it("does not probe a room ID that is not in the topology", async () => {
      setupTopologyMocks(buildTopologyResponse({ presenceSensors: 1 }));
      mockHistoryProbe({ room_typo: INDY_PROBE_DAYS });

      const result = await executeGetCurrentOccupancy({ asset_ids: ["room_typo"] });

      const asset = result.assets[0];
      expect(reportingClient.queryReporting).not.toHaveBeenCalled();
      expect(asset.presence.coverage_note).toBe("No presence sensors on this room.");
      expect(asset).not.toHaveProperty("history_end");
    });

    it("runs the history probes concurrently", async () => {
      const topo = buildTopologyResponse({ presenceSensors: 0, roomId: "room_a" });
      const rooms = topo.topology.data.sites.data[0].buildings[0].floors[0].rooms as any[];
      rooms[0].archivedAt = ARCHIVED_OCT_22;
      rooms.push({
        id: "room_b",
        name: "Pilot - B",
        floorID: "space_100",
        capacity: { max: 4 },
        archivedAt: ARCHIVED_OCT_22,
      });
      setupTopologyMocks(topo);
      let inFlight = 0;
      let maxInFlight = 0;
      vi.mocked(reportingClient.queryReporting).mockImplementation(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return { data: INDY_PROBE_DAYS };
      });

      const result = await executeGetCurrentOccupancy({ asset_ids: ["room_a", "room_b"] });

      expect(maxInFlight).toBe(2);
      expect(result.assets.map((a) => a.history_end)).toEqual(["2026-10-20", "2026-10-20"]);
    });

    it("reuses a cached history end instead of querying again", async () => {
      const args = { asset_ids: ["room_old9"] };
      const archivedTopo = () => {
        const topo = buildTopologyResponse({ presenceSensors: 0, roomId: "room_old9" });
        (topo.topology.data.sites.data[0].buildings[0].floors[0].rooms[0] as any).archivedAt =
          ARCHIVED_OCT_22;
        return topo;
      };
      setupTopologyMocks(archivedTopo());
      mockHistoryProbe({ room_old9: INDY_PROBE_DAYS });
      const first = await executeGetCurrentOccupancy(args);

      setupTopologyMocks(archivedTopo());
      const second = await executeGetCurrentOccupancy(args);

      expect(reportingClient.queryReporting).toHaveBeenCalledTimes(1);
      expect(first.assets[0].history_end).toBe("2026-10-20");
      expect(second.assets[0].history_end).toBe("2026-10-20");
    });

    it("runs the probes alongside the live reads instead of before them", async () => {
      // The archived room's probe only answers once the live room has been
      // read; awaiting all probes before the live loop would deadlock.
      const topo = buildTopologyResponse({ presenceSensors: 1, roomId: "room_live" });
      (topo.topology.data.sites.data[0].buildings[0].floors[0].rooms as any[]).push({
        id: "room_gone",
        name: "Pilot - Gone",
        floorID: "space_100",
        capacity: { max: 4 },
        archivedAt: ARCHIVED_OCT_22,
      });
      setupTopologyMocks(topo);
      let liveRead!: () => void;
      const liveReadDone = new Promise<void>((resolve) => (liveRead = resolve));
      vi.mocked(reportingClient.queryReporting).mockImplementation(async () => {
        await liveReadDone;
        return { data: INDY_PROBE_DAYS };
      });
      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(() => {
        const builder = mockReportingBuilder(null);
        builder.execute.mockImplementation(async () => {
          liveRead();
          return { data: [{ time: "2026-10-23T15:04:00Z", value: 1 }] };
        });
        return builder as any;
      });

      const result = await executeGetCurrentOccupancy({ asset_ids: ["room_gone", "room_live"] });

      expect(result.assets.map((a) => a.asset_id)).toEqual(["room_gone", "room_live"]);
      expect(result.assets[0].history_end).toBe("2026-10-20");
      expect(result.assets[1].presence.current_occupancy).toBe(1);
    });

    it("reads an archived room live when sensors are still attributed (E4)", async () => {
      const topo = buildTopologyResponse({ presenceSensors: 1 });
      (topo.topology.data.sites.data[0].buildings[0].floors[0].rooms[0] as any).archivedAt =
        ARCHIVED_OCT_22;
      setupTopologyMocks(topo);
      const builder = mockReportingBuilder({ data: [{ time: "2026-10-23T15:04:00Z", value: 2 }] });
      vi.mocked(reportingClient.ReportingRequestBuilder).mockImplementation(() => builder as any);

      const result = await executeGetCurrentOccupancy({ asset_ids: ["room_100"] });

      const asset = result.assets[0];
      expect(builder.execute).toHaveBeenCalled();
      expect(reportingClient.queryReporting).not.toHaveBeenCalled();
      expect(asset.presence.current_occupancy).toBe(2);
      expect(asset.presence.coverage_note).not.toMatch(/No sensors assigned/);
      expect(asset.archived_at).toBe(ARCHIVED_OCT_22);
      expect(asset.history_note).toBe(
        "This room was archived on 2026-10-22 but still has 1 sensor attributed (a data-integrity issue), so it is read like an active room."
      );
    });

    it("flags a declared end older than the lookup window and sends no query", async () => {
      // Archived eight months ago: its declared end is before the window.
      const topo = buildTopologyResponse({ presenceSensors: 0, roomId: "room_old8" });
      (topo.topology.data.sites.data[0].buildings[0].floors[0].rooms[0] as any).archivedAt =
        "2026-02-10T20:00:00Z";
      setupTopologyMocks(topo);

      const result = await executeGetCurrentOccupancy({ asset_ids: ["room_old8"] });

      const asset = result.assets[0];
      expect(reportingClient.queryReporting).not.toHaveBeenCalled();
      expect(asset.history_end).toBe("2026-02-09");
      expect(asset.presence.coverage_note).toBe(
        "No sensors assigned (archived on 2026-02-10). Recorded history runs up to 2026-02-09 " +
          "(before the lookup window, so not checked against the data)."
      );
      expect(asset.history_note).toContain("Use butlr_get_occupancy_timeseries for its history.");
    });

    it("says 'no recorded history since <window start>' and keeps the timeseries pointer", async () => {
      // Archived in the window, but nothing recorded in it (older data may exist).
      const topo = buildTopologyResponse({ presenceSensors: 0, roomId: "room_quiet" });
      (topo.topology.data.sites.data[0].buildings[0].floors[0].rooms[0] as any).archivedAt =
        "2026-06-10T20:00:00Z";
      setupTopologyMocks(topo);
      mockHistoryProbe({});

      const result = await executeGetCurrentOccupancy({ asset_ids: ["room_quiet"] });

      const asset = result.assets[0];
      expect(asset.presence.coverage_note).toBe(
        "No sensors assigned (archived on 2026-06-10). No recorded history since 2026-04-29."
      );
      expect(asset.history_note).toContain(
        "No recorded history since 2026-04-29. Use butlr_get_occupancy_timeseries for its history."
      );
      expect(asset.recommendation_reason).toContain(
        "use butlr_get_occupancy_timeseries to check older ranges"
      );
    });

    it("treats a room retired only by sensorsRemovedAt as retired, with a history_note", async () => {
      const topo = buildTopologyResponse({ presenceSensors: 0, roomId: "room_rm" });
      (topo.topology.data.sites.data[0].buildings[0].floors[0].rooms[0] as any).sensorsRemovedAt =
        "2026-10-21T15:00:00Z";
      setupTopologyMocks(topo);
      mockHistoryProbe({ room_rm: INDY_PROBE_DAYS });

      const result = await executeGetCurrentOccupancy({ asset_ids: ["room_rm"] });

      const asset = result.assets[0];
      expect(reportingClient.queryReporting).toHaveBeenCalledTimes(1);
      expect(asset.history_end).toBe("2026-10-20");
      expect(asset.presence.coverage_note).toBe(
        "No sensors assigned (sensors removed on 2026-10-21). Recorded history runs up to 2026-10-20."
      );
      expect(asset.history_note).toMatch(/sensors were removed on 2026-10-21; it has no live data/);
    });

    it("keys the history-end cache on the declared end", async () => {
      const topo = () => {
        const t = buildTopologyResponse({ presenceSensors: 0, roomId: "room_key" });
        (t.topology.data.sites.data[0].buildings[0].floors[0].rooms[0] as any).archivedAt =
          ARCHIVED_OCT_22;
        return t;
      };
      setupTopologyMocks(topo());
      mockHistoryProbe({ room_key: INDY_PROBE_DAYS });
      await executeGetCurrentOccupancy({ asset_ids: ["room_key"] });

      // The archive date changes (the space was re-archived): a new answer.
      const later = topo();
      (later.topology.data.sites.data[0].buildings[0].floors[0].rooms[0] as any).archivedAt =
        "2026-10-20T20:00:00Z";
      setupTopologyMocks(later);
      const result = await executeGetCurrentOccupancy({ asset_ids: ["room_key"] });

      expect(reportingClient.queryReporting).toHaveBeenCalledTimes(2);
      expect(result.assets[0].history_end).toBe("2026-10-19");
    });

    it("caps the history lookups at 5 in flight", async () => {
      const topo = buildTopologyResponse({ presenceSensors: 0, roomId: "room_c0" });
      const rooms = topo.topology.data.sites.data[0].buildings[0].floors[0].rooms as any[];
      rooms[0].archivedAt = ARCHIVED_OCT_22;
      for (let i = 1; i < 7; i++) {
        rooms.push({
          id: `room_c${i}`,
          name: `Old ${i}`,
          floorID: "space_100",
          archivedAt: ARCHIVED_OCT_22,
        });
      }
      setupTopologyMocks(topo);
      let inFlight = 0;
      let maxInFlight = 0;
      vi.mocked(reportingClient.queryReporting).mockImplementation(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return { data: INDY_PROBE_DAYS };
      });

      const result = await executeGetCurrentOccupancy({ asset_ids: rooms.map((r) => r.id) });

      expect(reportingClient.queryReporting).toHaveBeenCalledTimes(7);
      expect(maxInFlight).toBe(5);
      expect(result.assets.every((a) => a.history_end === "2026-10-20")).toBe(true);
    });
  });
});
