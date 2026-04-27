import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getTimezoneForAsset } from "../timezone-helpers.js";
import type { Site, Building, Floor } from "../../clients/types.js";

function makeSite(timezone: string | null): Site {
  return {
    id: "site_001",
    name: "Test Site",
    timezone,
    org_id: "org_001",
    buildings: [],
  };
}

function makeBuilding(siteId: string): Building {
  return {
    id: "building_001",
    name: "Test Building",
    site_id: siteId,
    capacity: {},
    floors: [],
    site: makeSite(null),
  };
}

function makeFloor(buildingId: string): Floor {
  return {
    id: "floor_001",
    name: "Floor 1",
    building_id: buildingId,
    timezone: null,
    installation_date: 0,
    capacity: {},
    area: {},
    metadata: {},
    rooms: [{ id: "room_001", name: "Room A", floorID: "floor_001", capacity: {} }],
    zones: [{ id: "zone_001", name: "Zone A", capacity: {} }],
  } as Floor;
}

describe("getTimezoneForAsset", () => {
  const site = makeSite("America/New_York");
  const building = makeBuilding("site_001");
  const floor = makeFloor("building_001");

  it("returns site timezone for a floor", () => {
    const result = getTimezoneForAsset("floor_001", "floor", [floor], [building], [site]);
    expect(result.timezone).toBe("America/New_York");
    expect(result.isFallback).toBe(false);
  });

  it("returns site timezone for a room", () => {
    const result = getTimezoneForAsset("room_001", "room", [floor], [building], [site]);
    expect(result.timezone).toBe("America/New_York");
    expect(result.isFallback).toBe(false);
  });

  it("returns site timezone for a zone", () => {
    const result = getTimezoneForAsset("zone_001", "zone", [floor], [building], [site]);
    expect(result.timezone).toBe("America/New_York");
    expect(result.isFallback).toBe(false);
  });

  describe("null site timezone fallback", () => {
    const nullTzSite = makeSite(null);
    let originalEnv: string | undefined;

    beforeEach(() => {
      originalEnv = process.env.BUTLR_TIMEZONE;
    });

    afterEach(() => {
      if (originalEnv === undefined) {
        delete process.env.BUTLR_TIMEZONE;
      } else {
        process.env.BUTLR_TIMEZONE = originalEnv;
      }
    });

    it("falls back to UTC when site timezone is null", () => {
      delete process.env.BUTLR_TIMEZONE;
      const result = getTimezoneForAsset("floor_001", "floor", [floor], [building], [nullTzSite]);
      expect(result.timezone).toBe("UTC");
      expect(result.isFallback).toBe(true);
    });

    it("falls back to BUTLR_TIMEZONE env var when set", () => {
      process.env.BUTLR_TIMEZONE = "Europe/London";
      const result = getTimezoneForAsset("floor_001", "floor", [floor], [building], [nullTzSite]);
      expect(result.timezone).toBe("Europe/London");
      expect(result.isFallback).toBe(true);
    });

    it("falls back when asset not found in topology", () => {
      delete process.env.BUTLR_TIMEZONE;
      const result = getTimezoneForAsset("floor_999", "floor", [floor], [building], [nullTzSite]);
      expect(result.timezone).toBe("UTC");
      expect(result.isFallback).toBe(true);
    });

    it("falls back for room when site timezone is null", () => {
      delete process.env.BUTLR_TIMEZONE;
      const result = getTimezoneForAsset("room_001", "room", [floor], [building], [nullTzSite]);
      expect(result.timezone).toBe("UTC");
      expect(result.isFallback).toBe(true);
    });

    it("falls back for zone when site timezone is null", () => {
      delete process.env.BUTLR_TIMEZONE;
      const result = getTimezoneForAsset("zone_001", "zone", [floor], [building], [nullTzSite]);
      expect(result.timezone).toBe("UTC");
      expect(result.isFallback).toBe(true);
    });
  });
});
