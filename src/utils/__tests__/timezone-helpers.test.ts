import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getLocalMidnight, getTimezoneForAsset } from "../timezone-helpers.js";
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

describe("getLocalMidnight", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns local midnight on the same local day", () => {
    const at = new Date("2026-04-24T12:00:00Z");
    expect(getLocalMidnight(at, "America/Indiana/Indianapolis").toISOString()).toBe(
      "2026-04-24T04:00:00.000Z"
    );
    expect(getLocalMidnight(at, "UTC").toISOString()).toBe("2026-04-24T00:00:00.000Z");
  });

  it("is not thrown a day back by an ICU build that prints midnight as hour 24", () => {
    // Some ICU builds (e.g. CI's Node) format local midnight as "24" under hour12:false.
    const original = Intl.DateTimeFormat.prototype.formatToParts;
    vi.spyOn(Intl.DateTimeFormat.prototype, "formatToParts").mockImplementation(function (
      this: Intl.DateTimeFormat,
      date?: Date | number
    ) {
      return original
        .call(this, date)
        .map((p) => (p.type === "hour" && p.value === "00" ? { ...p, value: "24" } : p));
    });
    const at = new Date("2026-04-24T12:00:00Z");
    expect(getLocalMidnight(at, "America/Indiana/Indianapolis").toISOString()).toBe(
      "2026-04-24T04:00:00.000Z"
    );
    expect(getLocalMidnight(at, "UTC").toISOString()).toBe("2026-04-24T00:00:00.000Z");
  });

  it("lands on the 1st of the month west of UTC, not days early", () => {
    // The first estimate (UTC midnight on Nov 1) reads Oct 31 in Los Angeles;
    // a day-of-month comparison took that for "ahead" and walked back to Oct 28.
    expect(
      getLocalMidnight(new Date("2026-11-01T15:00:00Z"), "America/Los_Angeles").toISOString()
    ).toBe("2026-11-01T07:00:00.000Z");
    expect(
      getLocalMidnight(
        new Date("2026-03-01T15:00:00Z"),
        "America/Indiana/Indianapolis"
      ).toISOString()
    ).toBe("2026-03-01T05:00:00.000Z");
    // Year boundary
    expect(
      getLocalMidnight(new Date("2027-01-01T15:00:00Z"), "America/Los_Angeles").toISOString()
    ).toBe("2027-01-01T08:00:00.000Z");
  });

  it("lands on the 1st east of UTC, and on month ends", () => {
    // Local Nov 1 starts on Oct 31 UTC in Tokyo.
    expect(getLocalMidnight(new Date("2026-11-01T02:00:00Z"), "Asia/Tokyo").toISOString()).toBe(
      "2026-10-31T15:00:00.000Z"
    );
    expect(
      getLocalMidnight(new Date("2026-10-31T20:00:00Z"), "America/Los_Angeles").toISOString()
    ).toBe("2026-10-31T07:00:00.000Z");
    expect(
      getLocalMidnight(new Date("2026-12-31T20:00:00Z"), "America/Los_Angeles").toISOString()
    ).toBe("2026-12-31T08:00:00.000Z");
  });

  it("handles a DST switch day (local midnight before the change)", () => {
    // Nov 1 2026 is the US fall-back day; midnight is still PDT (UTC-7).
    expect(
      getLocalMidnight(new Date("2026-11-01T20:00:00Z"), "America/Los_Angeles").toISOString()
    ).toBe("2026-11-01T07:00:00.000Z");
    // Mar 8 2026 spring-forward; midnight is PST (UTC-8).
    expect(
      getLocalMidnight(new Date("2026-03-08T20:00:00Z"), "America/Los_Angeles").toISOString()
    ).toBe("2026-03-08T08:00:00.000Z");
  });

  it("returns the first instant of the day where DST skips midnight", () => {
    // Cairo springs forward at 00:00 on 2026-04-24: the day starts at 01:00
    // EEST (UTC+3) = 2026-04-23T22:00Z. The old loop bounced and returned
    // 23:00 of the day before.
    expect(getLocalMidnight(new Date("2026-04-24T12:00:00Z"), "Africa/Cairo").toISOString()).toBe(
      "2026-04-23T22:00:00.000Z"
    );
    // Beirut springs forward at 00:00 on 2026-03-29: day starts 01:00 EEST.
    expect(getLocalMidnight(new Date("2026-03-29T12:00:00Z"), "Asia/Beirut").toISOString()).toBe(
      "2026-03-28T22:00:00.000Z"
    );
    // The day after, midnight exists again.
    expect(getLocalMidnight(new Date("2026-04-25T12:00:00Z"), "Africa/Cairo").toISOString()).toBe(
      "2026-04-24T21:00:00.000Z"
    );
  });

  it("is the first instant of its local day in every IANA zone on sampled days", () => {
    const fmt = (tz: string) =>
      new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      });
    const zones = Intl.supportedValuesOf("timeZone");
    const days = ["2026-01-01", "2026-03-29", "2026-04-24", "2026-10-31", "2026-11-01"];
    for (const tz of zones) {
      const f = fmt(tz);
      for (const day of days) {
        const at = new Date(`${day}T12:00:00Z`);
        const result = getLocalMidnight(at, tz);
        const want = f.format(at);
        expect(f.format(result), `${tz} ${day}`).toBe(want);
        expect(f.format(new Date(result.getTime() - 1000)) < want, `${tz} ${day}`).toBe(true);
      }
    }
  });
});
