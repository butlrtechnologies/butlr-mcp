import { describe, it, expect, vi, beforeEach } from "vitest";
import * as reportingClient from "../../clients/reporting-client.js";
import {
  buildHistoryProbeRequest,
  declaredHistoryEnd,
  fetchHistoryEnd,
  historyEndDay,
  historyProbeStart,
} from "../history-end.js";

vi.mock("../../clients/reporting-client.js", async () => {
  const actual = await vi.importActual<typeof import("../../clients/reporting-client.js")>(
    "../../clients/reporting-client.js"
  );
  return { ...actual, queryReporting: vi.fn() };
});

const INDY = "America/Indiana/Indianapolis";
/** Oct 23 2026, mid-day in Indianapolis: "yesterday" is Oct 22. */
const NOW = new Date("2026-10-23T16:00:00Z");

/** A daily bucket for local `day`, labelled with its END (next local midnight, EDT). */
function bucket(day: string, value: number | null) {
  const end = new Date(`${day}T04:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return { time: end.toISOString(), value };
}

describe("historyEndDay (data-derived end, D2(c))", () => {
  it("reads each bucket's day from its stop label (stepped back 1 ms)", () => {
    // Labelled Oct 21 00:00 local, so the bucket is Oct 20; the only day.
    expect(historyEndDay([{ time: "2026-10-21T04:00:00Z", value: 4 }], INDY, NOW)).toBe(
      "2026-10-20"
    );
  });

  it("Indy Floor 7: 13 on Oct 19, 0 on Oct 20, 0 on Oct 21 -> Oct 20", () => {
    const points = [bucket("2026-10-19", 13), bucket("2026-10-20", 0), bucket("2026-10-21", 0)];
    expect(historyEndDay(points, INDY, NOW)).toBe("2026-10-20");
  });

  it("counts zero-occupancy days as history", () => {
    const points = [bucket("2026-10-10", 0), bucket("2026-10-11", 0)];
    expect(historyEndDay(points, INDY, NOW)).toBe("2026-10-10");
  });

  it("returns the only day when there is a single recorded day", () => {
    expect(historyEndDay([bucket("2026-10-19", 0)], INDY, NOW)).toBe("2026-10-19");
  });

  it("treats a space whose newest closed bucket is yesterday as still recording", () => {
    // Reporting never returns today's partial bucket, so data through
    // yesterday means recording has not stopped: the end is yesterday.
    const points = [bucket("2026-10-20", 3), bucket("2026-10-21", 0), bucket("2026-10-22", 0)];
    expect(historyEndDay(points, INDY, NOW)).toBe("2026-10-22");
    expect(historyEndDay([bucket("2026-10-22", 0)], INDY, NOW)).toBe("2026-10-22");
  });

  it("skips null values and unusable rows", () => {
    const points = [
      bucket("2026-10-18", 2),
      bucket("2026-10-19", 5),
      bucket("2026-10-20", null),
      { time: "not a time", value: 3 },
      { value: 1 },
    ];
    expect(historyEndDay(points, INDY, NOW)).toBe("2026-10-18");
  });

  it("returns null with no recorded days, and ignores input order", () => {
    expect(historyEndDay([], INDY, NOW)).toBeNull();
    expect(historyEndDay([bucket("2026-10-20", null)], INDY, NOW)).toBeNull();
    const shuffled = [bucket("2026-10-21", 0), bucket("2026-10-19", 13), bucket("2026-10-20", 0)];
    expect(historyEndDay(shuffled, INDY, NOW)).toBe("2026-10-20");
  });
});

describe("declaredHistoryEnd (D2(a)/(b))", () => {
  it("prefers sensorsRemovedAt, then archivedAt, as the day before their local date", () => {
    // 01:30 UTC Oct 21 is the evening of Oct 20 in Indianapolis.
    expect(
      declaredHistoryEnd(
        { sensorsRemovedAt: "2026-10-21T01:30:00Z", archivedAt: "2026-10-23T15:00:00Z" },
        INDY
      )
    ).toBe("2026-10-19");
    expect(declaredHistoryEnd({ archivedAt: "2026-10-23T15:00:00Z" }, INDY)).toBe("2026-10-22");
    expect(declaredHistoryEnd({ archivedAt: "2026-03-01T15:00:00Z" }, INDY)).toBe("2026-02-28");
    expect(declaredHistoryEnd({ archivedAt: null, sensorsRemovedAt: null }, INDY)).toBeUndefined();
    expect(declaredHistoryEnd({ archivedAt: "garbage" }, INDY)).toBeUndefined();
  });
});

/**
 * Port of go-libs `etl.resolveBackendWithNow` (pkg/etl/router.go) plus the
 * tiered-reporting handler's -24h widening of a `1d` window's start. The
 * cutoff is computed in the START's location; the probe sends `Z`, so UTC.
 * Go's AddDate normalizes overflow by rolling over (Aug 31 - 6 months =
 * "Feb 31" = Mar 3), which Date.UTC reproduces.
 */
function routedTier(start: Date, now: Date): "hot" | "warm" | "cold" {
  const widened = start.getTime() - 24 * 3600 * 1000;
  const cutoff = (months: number) =>
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, now.getUTCDate());
  if (widened >= cutoff(3)) return "hot";
  if (widened >= cutoff(6)) return "warm";
  return "cold";
}

describe("historyProbeStart (D1)", () => {
  const ZONES = [
    "Europe/London",
    "Asia/Kolkata",
    "Asia/Tokyo",
    "America/Los_Angeles",
    "America/Indiana/Indianapolis",
    "UTC",
    "Pacific/Auckland",
  ];
  // Zeke's sample days plus the month ends where Go's rollover and dayjs
  // clamping disagree.
  const DAYS = [
    "2026-10-23",
    "2026-10-24",
    "2026-08-29",
    "2026-08-30",
    "2026-08-31",
    "2026-10-31",
    "2026-12-31",
    "2027-03-31",
    "2027-05-31",
  ];

  it("never routes to the cold tier, at any half hour of the listed days", () => {
    const cold: string[] = [];
    for (const tz of ZONES) {
      for (const day of DAYS) {
        for (let half = 0; half < 48; half++) {
          const now = new Date(Date.parse(`${day}T00:00:00Z`) + half * 30 * 60 * 1000);
          const start = historyProbeStart(now, tz);
          if (routedTier(start, now) === "cold") cold.push(`${tz} ${now.toISOString()}`);
        }
      }
    }
    expect(cold).toEqual([]);
  });

  it("never routes to the cold tier on any day of a year, every six hours", () => {
    const cold: string[] = [];
    const from = Date.parse("2026-01-01T00:00:00Z");
    for (const tz of ZONES) {
      for (let t = from; t < from + 365 * 86400000; t += 6 * 3600 * 1000) {
        const now = new Date(t);
        if (routedTier(historyProbeStart(now, tz), now) === "cold") {
          cold.push(`${tz} ${now.toISOString()}`);
        }
      }
    }
    expect(cold).toEqual([]);
  });

  it("still looks back about six months", () => {
    for (const tz of ZONES) {
      for (const day of DAYS) {
        const now = new Date(`${day}T12:00:00Z`);
        const days = (now.getTime() - historyProbeStart(now, tz).getTime()) / 86400000;
        expect(days, `${tz} ${day}`).toBeGreaterThan(175);
        expect(days, `${tz} ${day}`).toBeLessThan(184);
      }
    }
  });

  it("uses rollover month arithmetic plus three days, at local midnight", () => {
    // Aug 31 - 6 months rolls over to Mar 3 (2026 is not a leap year); +3 = Mar 6.
    expect(historyProbeStart(new Date("2026-08-31T16:00:00Z"), INDY).toISOString()).toBe(
      "2026-03-06T05:00:00.000Z"
    );
    // Oct 23 -> Apr 23 -> Apr 26, EDT
    expect(historyProbeStart(NOW, INDY).toISOString()).toBe("2026-04-26T04:00:00.000Z");
    // Dec 31 -> "Jun 31" = Jul 1 -> Jul 4, PDT
    expect(
      historyProbeStart(new Date("2026-12-31T20:00:00Z"), "America/Los_Angeles").toISOString()
    ).toBe("2026-07-04T07:00:00.000Z");
    // Late evening UTC is already the next day in Tokyo: Oct 24 -> Apr 27, JST
    expect(historyProbeStart(new Date("2026-10-23T20:00:00Z"), "Asia/Tokyo").toISOString()).toBe(
      "2026-04-26T15:00:00.000Z"
    );
  });
});

describe("history probe request", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queries daily max occupancy for the space, zeros included", () => {
    expect(buildHistoryProbeRequest("zone", "zone_1", INDY, NOW)).toMatchObject({
      group_by: { raw: true },
      window: { every: "1d", function: "max", timezone: INDY },
      filter: {
        measurements: ["zone_occupancy"],
        zones: { eq: ["zone_1"] },
        value: { gte: 0 },
        start: "2026-04-26T04:00:00.000Z",
        stop: "2026-10-23T16:00:00.000Z",
      },
    });
    const room = buildHistoryProbeRequest("room", "room_1", INDY, NOW);
    expect(room.filter.measurements).toEqual(["room_occupancy"]);
    expect(room.filter.rooms).toEqual({ eq: ["room_1"] });
    expect(room.filter.zones).toBeUndefined();
  });

  it("tolerates an empty grouped response shaped as {}", async () => {
    vi.mocked(reportingClient.queryReporting).mockResolvedValueOnce({ data: {} } as never);
    await expect(fetchHistoryEnd("room", "room_1", INDY, undefined, NOW)).resolves.toBeNull();

    vi.mocked(reportingClient.queryReporting).mockResolvedValueOnce({
      data: [bucket("2026-10-19", 13), bucket("2026-10-20", 0), bucket("2026-10-21", 0)],
    } as never);
    await expect(fetchHistoryEnd("room", "room_1", INDY, undefined, NOW)).resolves.toBe(
      "2026-10-20"
    );
  });

  it("with a declared end, answers it when the window holds history, and stops the query there", async () => {
    // An archived zone that kept receiving 0-valued rows until yesterday.
    vi.mocked(reportingClient.queryReporting).mockResolvedValueOnce({
      data: [bucket("2026-10-15", 4), bucket("2026-10-16", 0)],
    } as never);

    await expect(fetchHistoryEnd("zone", "zone_1", INDY, "2026-10-16", NOW)).resolves.toBe(
      "2026-10-16"
    );
    const request = vi.mocked(reportingClient.queryReporting).mock.calls[0][0];
    // Cut off at the end of Oct 16 local (Oct 17 00:00 EDT).
    expect(request.filter.stop).toBe("2026-10-17T04:00:00.000Z");
  });

  it("with a declared end, answers null when the window holds nothing", async () => {
    vi.mocked(reportingClient.queryReporting).mockResolvedValueOnce({ data: [] } as never);
    await expect(fetchHistoryEnd("room", "room_1", INDY, "2026-10-16", NOW)).resolves.toBeNull();
  });

  it("does not query when the declared end is older than the window", async () => {
    await expect(fetchHistoryEnd("room", "room_1", INDY, "2026-02-01", NOW)).resolves.toBeNull();
    expect(reportingClient.queryReporting).not.toHaveBeenCalled();
  });
});
