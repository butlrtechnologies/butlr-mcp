import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import * as reportingClient from "../../clients/reporting-client.js";
import {
  buildHistoryProbeRequest,
  declaredHistoryEnd,
  fetchHistoryEnd,
  historyEndDay,
  historyProbeStart,
  resolveHistoryEnd,
} from "../history-end.js";
import { isRetired } from "../archived-spaces.js";
import { formatLocalDate } from "../timezone-helpers.js";

vi.mock("../../clients/reporting-client.js", async () => {
  const actual = await vi.importActual<typeof import("../../clients/reporting-client.js")>(
    "../../clients/reporting-client.js"
  );
  return { ...actual, queryReporting: vi.fn() };
});

interface ConformanceCase {
  name: string;
  timezone: string;
  now: string;
  declared: { archivedAt?: string; sensorsRemovedAt?: string };
  rows: Array<{ time: string; value: number | null }> | null;
  expected: { endDay: string | null; windowStart: string; outsideWindow?: boolean };
}

interface RetiredCase {
  name: string;
  attributedSensors: number;
  archivedAt?: string;
  sensorsRemovedAt?: string;
  expected: boolean;
}

const conformance = JSON.parse(
  readFileSync(new URL("../../__fixtures__/history-end-conformance.json", import.meta.url), "utf8")
) as { historyEnd: ConformanceCase[]; retired: RetiredCase[] };

const INDY = "America/Indiana/Indianapolis";
/** Oct 23 2026, mid-day in Indianapolis. */
const NOW = new Date("2026-10-23T16:00:00Z");

describe("conformance fixtures (shared with the dashboard)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(conformance.historyEnd)("$name", async (c) => {
    const now = new Date(c.now);
    vi.mocked(reportingClient.queryReporting).mockResolvedValue({ data: c.rows ?? [] } as never);

    const end = await fetchHistoryEnd(
      "room",
      "room_x",
      c.timezone,
      declaredHistoryEnd(c.declared, c.timezone),
      now
    );

    expect(end).toEqual(
      c.expected.outsideWindow
        ? c.expected
        : { endDay: c.expected.endDay, windowStart: c.expected.windowStart }
    );
    // A declared end older than the window needs no query.
    expect(reportingClient.queryReporting).toHaveBeenCalledTimes(c.rows === null ? 0 : 1);
  });

  it.each(conformance.retired)("retired: $name", (c) => {
    expect(
      isRetired(
        { archivedAt: c.archivedAt, sensorsRemovedAt: c.sensorsRemovedAt },
        c.attributedSensors
      )
    ).toBe(c.expected);
  });
});

describe("historyEndDay (data-derived end, E2)", () => {
  /** A daily bucket for local `day`, labelled with its END (next local midnight, EDT). */
  function bucket(day: string, value: number | null) {
    const end = new Date(`${day}T04:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    return { time: end.toISOString(), value };
  }

  it("reads each bucket's day from its end label (stepped back 1 ms)", () => {
    expect(historyEndDay([{ time: "2026-10-21T04:00:00Z", value: 4 }], INDY)).toBe("2026-10-20");
  });

  it("counts zero-occupancy days and ends on the day before the newest", () => {
    expect(historyEndDay([bucket("2026-10-10", 0), bucket("2026-10-11", 0)], INDY)).toBe(
      "2026-10-10"
    );
  });

  it("treats today's composed partial bucket as the newest (partial) day", () => {
    // Reporting adds today's partial bucket, stamped at the query's stop,
    // whenever there are rows today: a still-recording space ends yesterday.
    const today = { time: NOW.toISOString(), value: 1 };
    expect(historyEndDay([bucket("2026-10-21", 3), bucket("2026-10-22", 2), today], INDY)).toBe(
      "2026-10-22"
    );
  });

  it("skips null values and unusable rows, and ignores order", () => {
    const points = [
      bucket("2026-10-19", 5),
      bucket("2026-10-18", 2),
      bucket("2026-10-20", null),
      { time: "not a time", value: 3 },
      { value: 1 },
    ];
    expect(historyEndDay(points, INDY)).toBe("2026-10-18");
    expect(historyEndDay([], INDY)).toBeNull();
  });
});

describe("declaredHistoryEnd", () => {
  it("prefers sensorsRemovedAt, then archivedAt, as the day before their local date", () => {
    expect(
      declaredHistoryEnd(
        { sensorsRemovedAt: "2026-10-21T01:30:00Z", archivedAt: "2026-10-23T15:00:00Z" },
        INDY
      )
    ).toBe("2026-10-19");
    expect(declaredHistoryEnd({ archivedAt: "2026-03-01T15:00:00Z" }, INDY)).toBe("2026-02-28");
    expect(declaredHistoryEnd({ archivedAt: null, sensorsRemovedAt: null }, INDY)).toBeUndefined();
    expect(declaredHistoryEnd({ archivedAt: "garbage" }, INDY)).toBeUndefined();
  });

  it("returns min(declared, data end), and null with no row on or before the declared day", () => {
    const rows = [
      { time: "2026-10-15T04:00:00Z", value: 6 },
      { time: "2026-10-16T04:00:00Z", value: 0 },
    ];
    expect(resolveHistoryEnd(rows, "2026-10-20", INDY, "2026-04-29").endDay).toBe("2026-10-14");
    expect(resolveHistoryEnd(rows, "2026-10-14", INDY, "2026-04-29").endDay).toBe("2026-10-14");
    expect(resolveHistoryEnd(rows, "2026-10-13", INDY, "2026-04-29").endDay).toBeNull();
  });
});

/**
 * Port of go-libs `etl.resolveBackendWithNow` (pkg/etl/router.go) plus the
 * tiered-reporting handler's -24h widening of a `1d` window's start. The
 * cutoff is computed in the START's location; the probe sends `Z`, so UTC.
 * Go's AddDate normalizes overflow by rolling over, which Date.UTC
 * reproduces. `serverNow` is the API's clock, separate from ours.
 */
function routedTier(start: Date, serverNow: Date): "hot" | "warm" | "cold" {
  const widened = start.getTime() - 24 * 3600 * 1000;
  const cutoff = (months: number) =>
    Date.UTC(serverNow.getUTCFullYear(), serverNow.getUTCMonth() - months, serverNow.getUTCDate());
  if (widened >= cutoff(3)) return "hot";
  if (widened >= cutoff(6)) return "warm";
  return "cold";
}

describe("historyProbeStart (E1: local midnight of today - 177 days)", () => {
  it("is local midnight 177 days back", () => {
    expect(historyProbeStart(NOW, INDY).toISOString()).toBe("2026-04-29T04:00:00.000Z");
    expect(historyProbeStart(new Date("2026-08-31T16:00:00Z"), INDY).toISOString()).toBe(
      "2026-03-07T05:00:00.000Z"
    );
    // Late evening UTC is already the next day in Tokyo.
    expect(historyProbeStart(new Date("2026-10-23T20:00:00Z"), "Asia/Tokyo").toISOString()).toBe(
      "2026-04-29T15:00:00.000Z"
    );
  });

  it("never reaches the cold tier in any IANA zone at month-end UTC midnights, with +-10 s of clock skew", () => {
    const cold: string[] = [];
    const zones = Intl.supportedValuesOf("timeZone");
    for (let year = 2026; year <= 2027; year++) {
      for (let month = 0; month < 12; month++) {
        // The first instant of a month in UTC, where Go's AddDate rollover
        // jumps the cutoff (e.g. Feb 28 -> Mar 1 moves it by four days).
        const serverNow = new Date(Date.UTC(year, month, 1));
        for (const skew of [-10_000, 10_000]) {
          const ourNow = new Date(serverNow.getTime() + skew);
          for (const tz of zones) {
            if (routedTier(historyProbeStart(ourNow, tz), serverNow) === "cold") {
              cold.push(`${tz} ours=${ourNow.toISOString()}`);
            }
          }
        }
      }
    }
    expect(cold).toEqual([]);
  });

  it("never reaches the cold tier every six hours over a year for the reviewed zones", () => {
    const zones = [
      "Europe/London",
      "Asia/Kolkata",
      "Asia/Tokyo",
      "America/Los_Angeles",
      "America/Indiana/Indianapolis",
      "UTC",
      "Pacific/Auckland",
      "Pacific/Kiritimati",
      "Pacific/Pago_Pago",
    ];
    const cold: string[] = [];
    const from = Date.parse("2026-01-01T00:00:00Z");
    for (const tz of zones) {
      for (let t = from; t < from + 365 * 86400000; t += 6 * 3600 * 1000) {
        const now = new Date(t);
        if (routedTier(historyProbeStart(now, tz), now) === "cold")
          cold.push(`${tz} ${now.toISOString()}`);
      }
    }
    expect(cold).toEqual([]);
  });
});

describe("history probe request", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queries daily max occupancy for the space over [start, now], zeros included", () => {
    const start = historyProbeStart(NOW, INDY);
    expect(buildHistoryProbeRequest("zone", "zone_1", INDY, start, NOW)).toMatchObject({
      group_by: { raw: true },
      window: { every: "1d", function: "max", timezone: INDY },
      filter: {
        measurements: ["zone_occupancy"],
        zones: { eq: ["zone_1"] },
        value: { gte: 0 },
        start: "2026-04-29T04:00:00.000Z",
        stop: "2026-10-23T16:00:00.000Z",
      },
    });
    const room = buildHistoryProbeRequest("room", "room_1", INDY, start, NOW);
    expect(room.filter.measurements).toEqual(["room_occupancy"]);
    expect(room.filter.rooms).toEqual({ eq: ["room_1"] });
    expect(room.filter.zones).toBeUndefined();
  });

  it("queries up to now even with a declared end, and tolerates an empty {} response", async () => {
    vi.mocked(reportingClient.queryReporting).mockResolvedValueOnce({ data: {} } as never);
    await expect(fetchHistoryEnd("room", "room_1", INDY, "2026-10-16", NOW)).resolves.toEqual({
      endDay: null,
      windowStart: "2026-04-29",
    });
    const request = vi.mocked(reportingClient.queryReporting).mock.calls[0][0];
    expect(request.filter.stop).toBe(NOW.toISOString());
    expect(formatLocalDate(Date.parse(request.filter.start), INDY)).toBe("2026-04-29");
  });
});
