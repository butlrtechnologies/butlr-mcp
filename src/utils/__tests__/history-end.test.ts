import { describe, it, expect, vi, beforeEach } from "vitest";
import * as reportingClient from "../../clients/reporting-client.js";
import {
  buildHistoryProbeRequest,
  fetchHistoryEndDay,
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

/** A daily bucket for local `day`, labelled with its END (next local midnight, EDT). */
function bucket(day: string, value: number | null) {
  const end = new Date(`${day}T04:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return { time: end.toISOString(), value };
}

describe("historyEndDay", () => {
  it("reads each bucket's day from its stop label (stepped back 1 ms)", () => {
    // Labelled Oct 21 00:00 local, so the bucket is Oct 20.
    expect(historyEndDay([{ time: "2026-10-21T04:00:00Z", value: 4 }], INDY)).toBe("2026-10-20");
  });

  it("Indy Floor 7: 13 on Oct 19, 0 on Oct 20, 0 on Oct 21 -> Oct 20", () => {
    const points = [bucket("2026-10-19", 13), bucket("2026-10-20", 0), bucket("2026-10-21", 0)];
    expect(historyEndDay(points, INDY)).toBe("2026-10-20");
  });

  it("counts zero-occupancy days as history", () => {
    const points = [bucket("2026-10-10", 0), bucket("2026-10-11", 0)];
    expect(historyEndDay(points, INDY)).toBe("2026-10-10");
  });

  it("returns the only day when there is a single recorded day", () => {
    expect(historyEndDay([bucket("2026-10-19", 0)], INDY)).toBe("2026-10-19");
  });

  it("skips null values and unusable rows", () => {
    const points = [
      bucket("2026-10-18", 2),
      bucket("2026-10-19", 5),
      bucket("2026-10-20", null),
      { time: "not a time", value: 3 },
      { value: 1 },
    ];
    expect(historyEndDay(points, INDY)).toBe("2026-10-18");
  });

  it("returns null with no recorded days, and ignores input order", () => {
    expect(historyEndDay([], INDY)).toBeNull();
    expect(historyEndDay([bucket("2026-10-20", null)], INDY)).toBeNull();
    const shuffled = [bucket("2026-10-21", 0), bucket("2026-10-19", 13), bucket("2026-10-20", 0)];
    expect(historyEndDay(shuffled, INDY)).toBe("2026-10-20");
  });
});

describe("history probe request", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts 6 months back plus a day, at local midnight", () => {
    const now = new Date("2026-10-23T18:00:00Z");
    expect(historyProbeStart(now, INDY).toISOString()).toBe("2026-04-24T04:00:00.000Z");
    expect(historyProbeStart(now, "UTC").toISOString()).toBe("2026-04-24T00:00:00.000Z");
    // Late evening UTC is already the next day in Tokyo.
    expect(historyProbeStart(new Date("2026-10-23T20:00:00Z"), "Asia/Tokyo").toISOString()).toBe(
      "2026-04-24T15:00:00.000Z"
    );
    // Aug 31 - 6 months clamps to Feb 28, then +1 day.
    expect(historyProbeStart(new Date("2026-08-31T12:00:00Z"), "UTC").toISOString()).toBe(
      "2026-03-01T00:00:00.000Z"
    );
  });

  it("lands on local midnight of the 1st west of UTC (month ends clamp, then +1 day)", () => {
    // These used to walk days early: the start is the 1st of a month, and
    // getLocalMidnight compared only the day of the month.
    // Aug 31 -> Feb 28 (clamped) -> Mar 1, EST
    expect(historyProbeStart(new Date("2026-08-31T16:00:00Z"), INDY).toISOString()).toBe(
      "2026-03-01T05:00:00.000Z"
    );
    // Oct 31 -> Apr 30 (clamped) -> May 1, EDT
    expect(historyProbeStart(new Date("2026-10-31T16:00:00Z"), INDY).toISOString()).toBe(
      "2026-05-01T04:00:00.000Z"
    );
    // Dec 31 -> Jun 30 (clamped) -> Jul 1, EDT
    expect(historyProbeStart(new Date("2026-12-31T16:00:00Z"), INDY).toISOString()).toBe(
      "2026-07-01T04:00:00.000Z"
    );
    expect(
      historyProbeStart(new Date("2026-12-31T20:00:00Z"), "America/Los_Angeles").toISOString()
    ).toBe("2026-07-01T07:00:00.000Z");
  });

  it("queries daily max occupancy for the space, zeros included", () => {
    const now = new Date("2026-10-23T18:00:00Z");
    expect(buildHistoryProbeRequest("zone", "zone_1", INDY, now)).toMatchObject({
      group_by: { raw: true },
      window: { every: "1d", function: "max", timezone: INDY },
      filter: {
        measurements: ["zone_occupancy"],
        zones: { eq: ["zone_1"] },
        value: { gte: 0 },
        start: "2026-04-24T04:00:00.000Z",
        stop: "2026-10-23T18:00:00.000Z",
      },
    });
    const room = buildHistoryProbeRequest("room", "room_1", INDY, now);
    expect(room.filter.measurements).toEqual(["room_occupancy"]);
    expect(room.filter.rooms).toEqual({ eq: ["room_1"] });
    expect(room.filter.zones).toBeUndefined();
  });

  it("fetchHistoryEndDay tolerates an empty grouped response shaped as {}", async () => {
    vi.mocked(reportingClient.queryReporting).mockResolvedValueOnce({ data: {} } as never);
    await expect(fetchHistoryEndDay("room", "room_1", INDY)).resolves.toBeNull();

    vi.mocked(reportingClient.queryReporting).mockResolvedValueOnce({
      data: [bucket("2026-10-19", 13), bucket("2026-10-20", 0), bucket("2026-10-21", 0)],
    } as never);
    await expect(fetchHistoryEndDay("room", "room_1", INDY)).resolves.toBe("2026-10-20");
  });
});
