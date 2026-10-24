import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { parseTimeString, resolveTimeToIso } from "../time-resolver.js";

describe("time-resolver", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("parseTimeString", () => {
    it("resolves 'now' to the current time", () => {
      expect(parseTimeString("now").toISOString()).toBe("2026-08-05T12:00:00.000Z");
    });

    it("resolves relative minutes", () => {
      expect(parseTimeString("-30m").toISOString()).toBe("2026-08-05T11:30:00.000Z");
    });

    it("resolves relative hours", () => {
      expect(parseTimeString("-24h").toISOString()).toBe("2026-08-04T12:00:00.000Z");
    });

    it("resolves relative days", () => {
      expect(parseTimeString("-7d").toISOString()).toBe("2026-07-29T12:00:00.000Z");
    });

    it("passes through ISO-8601 strings", () => {
      expect(parseTimeString("2025-01-13T00:00:00Z").toISOString()).toBe(
        "2025-01-13T00:00:00.000Z"
      );
    });

    it("throws on unrecognized input", () => {
      expect(() => parseTimeString("not-a-date")).toThrow("Invalid time format");
      expect(() => parseTimeString("24h")).toThrow("Invalid time format");
    });
  });

  describe("resolveTimeToIso", () => {
    it("returns absolute ISO-8601 strings for relative input", () => {
      expect(resolveTimeToIso("-1h")).toBe("2026-08-05T11:00:00.000Z");
      expect(resolveTimeToIso("now")).toBe("2026-08-05T12:00:00.000Z");
    });

    it("normalizes ISO input to UTC with milliseconds", () => {
      expect(resolveTimeToIso("2025-01-13T14:30:00-08:00")).toBe("2025-01-13T22:30:00.000Z");
    });
  });

  describe("shared `now`", () => {
    it('anchors "now" and relative forms to the instant passed in, not the clock', () => {
      const now = new Date("2026-10-23T08:00:00.123Z");
      expect(resolveTimeToIso("now", now)).toBe("2026-10-23T08:00:00.123Z");
      expect(resolveTimeToIso("-5m", now)).toBe("2026-10-23T07:55:00.123Z");
      // A range resolved against one instant is exact, whatever the clock does in between.
      const span = parseTimeString("now", now).getTime() - parseTimeString("-5m", now).getTime();
      expect(span).toBe(5 * 60 * 1000);
    });
  });

  describe("validateTimeRange", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("resolves both ends from one clock read, so exactly 1h passes the 1m limit", async () => {
      const { validateTimeRange } = await import("../time-range-validator.js");
      // A clock that ticks 1 ms on every read: two separate reads would make
      // "-1h".."now" one millisecond longer than an hour.
      const RealDate = Date;
      let t = RealDate.parse("2026-10-23T12:00:00Z");
      class TickingDate extends RealDate {
        constructor(...args: ConstructorParameters<typeof Date>) {
          if (args.length === 0) super(t++);
          else super(...args);
        }
        static now() {
          return t++;
        }
      }
      vi.stubGlobal("Date", TickingDate);
      expect(() => validateTimeRange("1m", "-1h", "now")).not.toThrow();
    });
  });
});
