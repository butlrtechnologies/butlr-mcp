import { describe, it, expect } from "vitest";
import {
  buildRecommendation,
  getPresenceMeasurement,
  getTrafficMeasurement,
  getPresenceCoverageNote,
  getTrafficCoverageNote,
  resolveAssetContext,
  type TopologyContext,
} from "../occupancy-helpers.js";
import type { BaseMeasurementData } from "../../types/responses.js";
import type { Sensor, Site, Building, Floor } from "../../clients/types.js";

// ---------------------------------------------------------------------------
// Helpers for building BaseMeasurementData fixtures
// ---------------------------------------------------------------------------

function makePresenceData(overrides: Partial<BaseMeasurementData> = {}): BaseMeasurementData {
  return { available: true, sensor_count: 3, ...overrides };
}

function makeTrafficData(overrides: Partial<BaseMeasurementData> = {}): BaseMeasurementData {
  return { available: true, entrance_sensor_count: 2, ...overrides };
}

// ---------------------------------------------------------------------------
// buildRecommendation
// ---------------------------------------------------------------------------

describe("buildRecommendation", () => {
  it('recommends "presence" when both presence and traffic have data', () => {
    const result = buildRecommendation(makePresenceData(), makeTrafficData(), true, true);
    expect(result.recommended_measurement).toBe("presence");
    expect(result.recommendation_reason).toMatch(/Both available/);
  });

  it('recommends "presence" when only presence has data', () => {
    const result = buildRecommendation(
      makePresenceData(),
      makeTrafficData({ available: false }),
      true,
      false
    );
    expect(result.recommended_measurement).toBe("presence");
    expect(result.recommendation_reason).toMatch(/Presence available/);
  });

  it('recommends "traffic" when only traffic has data', () => {
    const result = buildRecommendation(
      makePresenceData({ available: false }),
      makeTrafficData(),
      false,
      true
    );
    expect(result.recommended_measurement).toBe("traffic");
    expect(result.recommendation_reason).toMatch(/Traffic available/);
  });

  it('recommends "none" when neither has data', () => {
    const result = buildRecommendation(
      makePresenceData({ available: false }),
      makeTrafficData({ available: false }),
      false,
      false
    );
    expect(result.recommended_measurement).toBe("none");
  });

  it('recommends "none" when presence sensors exist but query failed (warning set, no data)', () => {
    const result = buildRecommendation(
      makePresenceData({ available: true, warning: "Query timed out" }),
      makeTrafficData({ available: false }),
      false,
      false
    );
    expect(result.recommended_measurement).toBe("none");
    expect(result.recommendation_reason).toMatch(/Query timed out/);
  });

  it('recommends "none" when both have data but presence has a warning', () => {
    // presence has warning → presenceSucceeded = false; traffic has no data → trafficSucceeded = false
    const result = buildRecommendation(
      makePresenceData({ available: true, warning: "Partial data" }),
      makeTrafficData({ available: true }),
      true,
      false
    );
    expect(result.recommended_measurement).toBe("none");
  });

  it('recommends "traffic" when presence has a warning but traffic succeeded', () => {
    const result = buildRecommendation(
      makePresenceData({ available: true, warning: "Sensor offline" }),
      makeTrafficData(),
      true,
      true
    );
    expect(result.recommended_measurement).toBe("traffic");
  });
});

// ---------------------------------------------------------------------------
// getPresenceMeasurement
// ---------------------------------------------------------------------------

describe("getPresenceMeasurement", () => {
  it('returns "floor_occupancy" for floor', () => {
    expect(getPresenceMeasurement("floor")).toBe("floor_occupancy");
  });

  it('returns "room_occupancy" for room', () => {
    expect(getPresenceMeasurement("room")).toBe("room_occupancy");
  });

  it('returns "zone_occupancy" for zone', () => {
    expect(getPresenceMeasurement("zone")).toBe("zone_occupancy");
  });
});

// ---------------------------------------------------------------------------
// getTrafficMeasurement
// ---------------------------------------------------------------------------

describe("getTrafficMeasurement", () => {
  it('returns "traffic_floor_occupancy" for floor', () => {
    expect(getTrafficMeasurement("floor")).toBe("traffic_floor_occupancy");
  });

  it('returns "traffic_room_occupancy" for room', () => {
    expect(getTrafficMeasurement("room")).toBe("traffic_room_occupancy");
  });
});

// ---------------------------------------------------------------------------
// getPresenceCoverageNote
// ---------------------------------------------------------------------------

describe("getPresenceCoverageNote", () => {
  it('mentions "Zones support presence" for zone with 0 sensors', () => {
    const note = getPresenceCoverageNote("zone", 0);
    expect(note).toMatch(/Zones support presence/);
  });

  it('mentions "No presence sensors" for room with 0 sensors', () => {
    const note = getPresenceCoverageNote("room", 0);
    expect(note).toMatch(/No presence sensors/);
  });

  it('mentions "No presence sensors" for floor with 0 sensors', () => {
    const note = getPresenceCoverageNote("floor", 0);
    expect(note).toMatch(/No presence sensors/);
  });

  it('mentions "3 sensors" and "may not cover" for floor with 3 sensors', () => {
    const note = getPresenceCoverageNote("floor", 3);
    expect(note).toMatch(/3 sensors/);
    expect(note).toMatch(/may not cover/);
  });

  it('mentions "2 sensors" for room with 2 sensors', () => {
    const note = getPresenceCoverageNote("room", 2);
    expect(note).toMatch(/2 sensors/);
  });

  it('does not mention "may not cover" for room', () => {
    const note = getPresenceCoverageNote("room", 2);
    expect(note).not.toMatch(/may not cover/);
  });
});

// ---------------------------------------------------------------------------
// getTrafficCoverageNote
// ---------------------------------------------------------------------------

describe("getTrafficCoverageNote", () => {
  it('returns "Zones do not support traffic" for zone with 0 sensors', () => {
    const note = getTrafficCoverageNote("zone", 0);
    expect(note).toBe("Zones do not support traffic.");
  });

  it('returns "No main entrance sensors." for floor with 0 sensors', () => {
    const note = getTrafficCoverageNote("floor", 0);
    expect(note).toBe("No main entrance sensors.");
  });

  it('returns "No traffic sensors." for room with 0 sensors', () => {
    const note = getTrafficCoverageNote("room", 0);
    expect(note).toBe("No traffic sensors.");
  });

  it('mentions "2 main entrance sensors" for floor with 2 sensors', () => {
    const note = getTrafficCoverageNote("floor", 2);
    expect(note).toMatch(/2 main entrance sensors/);
  });

  it('mentions "2 sensors" for room with 2 sensors', () => {
    const note = getTrafficCoverageNote("room", 2);
    expect(note).toMatch(/2 sensors/);
  });

  it('does not mention "main entrance" for room', () => {
    const note = getTrafficCoverageNote("room", 3);
    expect(note).not.toMatch(/main entrance/);
  });
});

// ---------------------------------------------------------------------------
// resolveAssetContext — sensor partitioning by mode + is_entrance (B2 regression)
// ---------------------------------------------------------------------------

function makeSensor(overrides: Partial<Sensor> & { id: string }): Sensor {
  return {
    id: overrides.id,
    mac_address: `aa:bb:cc:dd:ee:${overrides.id.slice(-2).padStart(2, "0")}`,
    mode: "presence",
    is_online: true,
    is_entrance: false,
    ...overrides,
  } as Sensor;
}

function makeTopologyContext(opts: {
  floors: Floor[];
  sensors: Sensor[];
  siteTimezone?: string;
}): TopologyContext {
  const sites: Site[] = [
    {
      id: "site_001",
      name: "Test Site",
      timezone: opts.siteTimezone ?? "America/New_York",
      buildings: [
        {
          id: "building_001",
          name: "Building",
          site_id: "site_001",
          floors: opts.floors,
        } as Building,
      ],
    } as Site,
  ];
  const buildings = sites.flatMap((s) => s.buildings || []);
  const floors = buildings.flatMap((b) => b.floors || []);
  return { sites, buildings, floors, productionSensors: opts.sensors };
}

describe("resolveAssetContext — B2 regression: room-level traffic ignores is_entrance flag", () => {
  it("counts traffic-mode sensors at a room regardless of is_entrance (B2 fix)", () => {
    const floor: Floor = {
      id: "space_floor1",
      name: "Floor 1",
      building_id: "building_001",
      rooms: [{ id: "room_cafe", name: "Café", floor_id: "space_floor1" }],
      zones: [],
    } as Floor;

    const ctx = makeTopologyContext({
      floors: [floor],
      sensors: [
        makeSensor({
          id: "sensor_t1",
          mode: "traffic",
          floor_id: "space_floor1",
          room_id: "room_cafe",
          is_entrance: true,
        }),
        makeSensor({
          id: "sensor_t2",
          mode: "traffic",
          floor_id: "space_floor1",
          room_id: "room_cafe",
          is_entrance: true,
        }),
      ],
    });

    const result = resolveAssetContext("room_cafe", ctx);
    expect(result.assetType).toBe("room");
    expect(result.trafficSensors).toHaveLength(2);
    expect(result.trafficSensors.map((s) => s.id).sort()).toEqual(["sensor_t1", "sensor_t2"]);
  });

  it("floor-level traffic still filters to is_entrance=true only (negative guard for B2)", () => {
    const floor: Floor = {
      id: "space_floor1",
      name: "Floor 1",
      building_id: "building_001",
      rooms: [],
      zones: [],
    } as Floor;

    const ctx = makeTopologyContext({
      floors: [floor],
      sensors: [
        makeSensor({
          id: "sensor_entry",
          mode: "traffic",
          floor_id: "space_floor1",
          is_entrance: true,
        }),
        makeSensor({
          id: "sensor_interior",
          mode: "traffic",
          floor_id: "space_floor1",
          is_entrance: false,
        }),
      ],
    });

    const result = resolveAssetContext("space_floor1", ctx);
    expect(result.assetType).toBe("floor");
    expect(result.trafficSensors).toHaveLength(1);
    expect(result.trafficSensors[0].id).toBe("sensor_entry");
  });
});
