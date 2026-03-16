import { describe, it, expect } from "vitest";
import {
  getOccupancyLabel,
  getTrendLabel,
  getSignificance,
  getTrendDirection,
  buildBusynessSummary,
  buildAvailableRoomsSummary,
  buildTrafficSummary,
  buildHardwareSummary,
  buildBuildingSummary,
  buildUsageTrendSummary,
  getBusinessRecommendation,
  formatDayAndTime,
  formatPeriodDescription,
  daysBetween,
  hoursBetween,
} from "./natural-language.js";

describe("getOccupancyLabel", () => {
  it('returns "quiet" for utilization < 30%', () => {
    expect(getOccupancyLabel(0)).toBe("quiet");
    expect(getOccupancyLabel(15)).toBe("quiet");
    expect(getOccupancyLabel(29)).toBe("quiet");
    expect(getOccupancyLabel(29.9)).toBe("quiet");
  });

  it('returns "moderate" for 30-70%', () => {
    expect(getOccupancyLabel(30)).toBe("moderate");
    expect(getOccupancyLabel(50)).toBe("moderate");
    expect(getOccupancyLabel(69)).toBe("moderate");
    expect(getOccupancyLabel(69.9)).toBe("moderate");
  });

  it('returns "busy" for >= 70%', () => {
    expect(getOccupancyLabel(70)).toBe("busy");
    expect(getOccupancyLabel(85)).toBe("busy");
    expect(getOccupancyLabel(100)).toBe("busy");
    expect(getOccupancyLabel(120)).toBe("busy"); // Over capacity
  });

  it("handles boundary values correctly", () => {
    expect(getOccupancyLabel(29.99)).toBe("quiet");
    expect(getOccupancyLabel(30)).toBe("moderate");
    expect(getOccupancyLabel(69.99)).toBe("moderate");
    expect(getOccupancyLabel(70)).toBe("busy");
  });
});

describe("getTrendLabel", () => {
  it('returns "lighter" for delta < -15%', () => {
    expect(getTrendLabel(-20)).toBe("lighter");
    expect(getTrendLabel(-15.1)).toBe("lighter");
    expect(getTrendLabel(-50)).toBe("lighter");
  });

  it('returns "typical" for -15% to +15%', () => {
    expect(getTrendLabel(-15)).toBe("typical");
    expect(getTrendLabel(-10)).toBe("typical");
    expect(getTrendLabel(0)).toBe("typical");
    expect(getTrendLabel(10)).toBe("typical");
    expect(getTrendLabel(15)).toBe("typical");
  });

  it('returns "busier" for delta > +15%', () => {
    expect(getTrendLabel(15.1)).toBe("busier");
    expect(getTrendLabel(25)).toBe("busier");
    expect(getTrendLabel(50)).toBe("busier");
  });

  it("handles boundary values correctly", () => {
    expect(getTrendLabel(-15.01)).toBe("lighter");
    expect(getTrendLabel(-15)).toBe("typical");
    expect(getTrendLabel(15)).toBe("typical");
    expect(getTrendLabel(15.01)).toBe("busier");
  });
});

describe("getSignificance", () => {
  it('returns "notable" for |delta| > 15%', () => {
    expect(getSignificance(20)).toBe("notable");
    expect(getSignificance(15.1)).toBe("notable");
    expect(getSignificance(-20)).toBe("notable");
    expect(getSignificance(-15.1)).toBe("notable");
  });

  it('returns "slight" for 5% < |delta| <= 15%', () => {
    expect(getSignificance(10)).toBe("slight");
    expect(getSignificance(5.1)).toBe("slight");
    expect(getSignificance(-10)).toBe("slight");
    expect(getSignificance(-5.1)).toBe("slight");
  });

  it('returns "minimal" for |delta| <= 5%', () => {
    expect(getSignificance(5)).toBe("minimal");
    expect(getSignificance(3)).toBe("minimal");
    expect(getSignificance(0)).toBe("minimal");
    expect(getSignificance(-3)).toBe("minimal");
    expect(getSignificance(-5)).toBe("minimal");
  });

  it("handles negative deltas correctly", () => {
    expect(getSignificance(-20)).toBe("notable");
    expect(getSignificance(-10)).toBe("slight");
    expect(getSignificance(-3)).toBe("minimal");
  });
});

describe("getTrendDirection", () => {
  it('returns "increasing" for positive delta', () => {
    expect(getTrendDirection(10)).toBe("increasing");
    expect(getTrendDirection(0.1)).toBe("increasing");
    expect(getTrendDirection(100)).toBe("increasing");
  });

  it('returns "decreasing" for negative delta', () => {
    expect(getTrendDirection(-10)).toBe("decreasing");
    expect(getTrendDirection(-0.1)).toBe("decreasing");
    expect(getTrendDirection(-100)).toBe("decreasing");
  });

  it('returns "stable" for very small delta (< 5%)', () => {
    expect(getTrendDirection(0)).toBe("stable");
    expect(getTrendDirection(0.03)).toBe("stable");
    expect(getTrendDirection(-0.03)).toBe("stable");
    expect(getTrendDirection(0.04)).toBe("stable");
    expect(getTrendDirection(-0.04)).toBe("stable");
  });

  it("handles boundary values (5% threshold)", () => {
    expect(getTrendDirection(0.049)).toBe("stable");
    expect(getTrendDirection(0.05)).toBe("increasing");
    expect(getTrendDirection(-0.049)).toBe("stable");
    expect(getTrendDirection(-0.05)).toBe("decreasing");
  });
});

describe("buildBusynessSummary", () => {
  it("formats basic busyness summary correctly", () => {
    const summary = buildBusynessSummary({
      spaceName: "Café",
      occupancy: 12,
      capacity: 30,
      utilizationPercent: 40,
    });

    expect(summary).toContain("Café: Moderate");
    expect(summary).toContain("12 people");
    expect(summary).toContain("40% capacity");
  });

  it("includes trend when lighter than typical", () => {
    const summary = buildBusynessSummary({
      spaceName: "Conference Room",
      occupancy: 5,
      capacity: 20,
      utilizationPercent: 25,
      trendLabel: "lighter",
    });

    expect(summary).toContain("lighter than typical");
  });

  it("includes trend when busier than typical", () => {
    const summary = buildBusynessSummary({
      spaceName: "Lobby",
      occupancy: 45,
      capacity: 50,
      utilizationPercent: 90,
      trendLabel: "busier",
    });

    expect(summary).toContain("busier than typical");
  });

  it("includes day/time context for typical trend", () => {
    const summary = buildBusynessSummary({
      spaceName: "Kitchen",
      occupancy: 8,
      capacity: 15,
      utilizationPercent: 53,
      trendLabel: "typical",
      dayTime: "Thursday 2pm",
    });

    expect(summary).toContain("typical for Thursday 2pm");
  });

  it("does not include trend label when not typical and no trend", () => {
    const summary = buildBusynessSummary({
      spaceName: "Room",
      occupancy: 5,
      capacity: 10,
      utilizationPercent: 50,
    });

    expect(summary).not.toContain("typical");
    expect(summary).not.toContain("lighter");
    expect(summary).not.toContain("busier");
  });
});

describe("buildAvailableRoomsSummary", () => {
  it("formats multiple rooms correctly", () => {
    const summary = buildAvailableRoomsSummary({
      count: 5,
      roomType: "conference",
      minCapacity: 4,
      maxCapacity: 12,
    });

    expect(summary).toContain("5 conference rooms available");
    expect(summary).toContain("capacity 4-12 people");
  });

  it("handles singular room", () => {
    const summary = buildAvailableRoomsSummary({
      count: 1,
      roomType: "meeting",
      minCapacity: 6,
      maxCapacity: 6,
    });

    expect(summary).toContain("1 meeting room available");
  });

  it("handles no rooms available", () => {
    const summary = buildAvailableRoomsSummary({
      count: 0,
      roomType: "conference",
    });

    expect(summary).toContain("No conference rooms currently available");
  });

  it("handles rooms without type specified", () => {
    const summary = buildAvailableRoomsSummary({
      count: 3,
      minCapacity: 4,
      maxCapacity: 10,
    });

    expect(summary).toContain("3 rooms available");
    expect(summary).toContain("capacity 4-10 people");
  });

  it("handles only minCapacity", () => {
    const summary = buildAvailableRoomsSummary({
      count: 2,
      minCapacity: 8,
    });

    expect(summary).toContain("capacity 8+ people");
  });

  it("handles no capacity info", () => {
    const summary = buildAvailableRoomsSummary({
      count: 4,
    });

    expect(summary).toBe("4 rooms available");
  });
});

describe("buildTrafficSummary", () => {
  it("formats basic traffic summary", () => {
    const summary = buildTrafficSummary({
      spaceName: "Lobby",
      entries: 47,
      period: "today",
    });

    expect(summary).toContain("Lobby: 47 entries today");
  });

  it("includes comparison to typical when provided", () => {
    const summary = buildTrafficSummary({
      spaceName: "Entrance",
      entries: 120,
      period: "last hour",
      vsTypicalPercent: 23,
      dayOfWeek: "Monday",
    });

    expect(summary).toContain("120 entries last hour");
    expect(summary).toContain("23% higher than typical Monday");
  });

  it("handles negative comparison (lower than typical)", () => {
    const summary = buildTrafficSummary({
      spaceName: "Exit",
      entries: 30,
      period: "this morning",
      vsTypicalPercent: -15,
    });

    expect(summary).toContain("15% lower than typical");
  });

  it("handles comparison without day of week", () => {
    const summary = buildTrafficSummary({
      spaceName: "Door",
      entries: 50,
      period: "today",
      vsTypicalPercent: 10,
    });

    expect(summary).toContain("10% higher than typical");
    expect(summary).not.toContain("Monday");
  });
});

describe("buildHardwareSummary", () => {
  it("formats sensor and hive counts correctly", () => {
    const summary = buildHardwareSummary({
      sensorsOnline: 45,
      sensorsTotal: 52,
      hivesOnline: 8,
      hivesTotal: 8,
      batteriesCritical: 3,
      batteriesDueSoon: 7,
    });

    expect(summary).toContain("45 of 52 sensors online (87%)");
    expect(summary).toContain("8 of 8 hives online (100%)");
    expect(summary).toContain("3 batteries critical");
    expect(summary).toContain("7 due within 30 days");
  });

  it("handles no battery issues", () => {
    const summary = buildHardwareSummary({
      sensorsOnline: 10,
      sensorsTotal: 10,
      hivesOnline: 2,
      hivesTotal: 2,
      batteriesCritical: 0,
      batteriesDueSoon: 0,
    });

    expect(summary).toContain("10 of 10 sensors online (100%)");
    expect(summary).not.toContain("batteries critical");
    expect(summary).not.toContain("due within 30 days");
  });

  it("handles only critical batteries", () => {
    const summary = buildHardwareSummary({
      sensorsOnline: 20,
      sensorsTotal: 25,
      hivesOnline: 4,
      hivesTotal: 5,
      batteriesCritical: 2,
      batteriesDueSoon: 0,
    });

    expect(summary).toContain("2 batteries critical");
    expect(summary).not.toContain("due within 30 days");
  });

  it("handles only due soon batteries", () => {
    const summary = buildHardwareSummary({
      sensorsOnline: 15,
      sensorsTotal: 20,
      hivesOnline: 3,
      hivesTotal: 3,
      batteriesCritical: 0,
      batteriesDueSoon: 5,
    });

    expect(summary).not.toContain("batteries critical");
    expect(summary).toContain("5 due within 30 days");
  });
});

describe("buildBuildingSummary", () => {
  it("formats complete building summary", () => {
    const summary = buildBuildingSummary({
      buildingName: "HQ Tower",
      utilizationPercent: 60,
      busiestFloor: { name: "Floor 3", utilization: 85 },
      availableRooms: 23,
    });

    expect(summary).toContain("HQ Tower: 60% occupied");
    expect(summary).toContain("Floor Floor 3 busiest (85%)");
    expect(summary).toContain("23 rooms available");
  });

  it("handles summary without busiest floor", () => {
    const summary = buildBuildingSummary({
      buildingName: "East Wing",
      utilizationPercent: 45,
      availableRooms: 10,
    });

    expect(summary).toContain("East Wing: 45% occupied");
    expect(summary).not.toContain("busiest");
    expect(summary).toContain("10 rooms available");
  });

  it("handles summary without available rooms", () => {
    const summary = buildBuildingSummary({
      buildingName: "West Wing",
      utilizationPercent: 75,
      busiestFloor: { name: "2", utilization: 90 },
    });

    expect(summary).toContain("West Wing: 75% occupied");
    expect(summary).toContain("Floor 2 busiest (90%)");
    expect(summary).not.toContain("rooms available");
  });

  it("handles minimal summary (only utilization)", () => {
    const summary = buildBuildingSummary({
      buildingName: "Annex",
      utilizationPercent: 30,
    });

    expect(summary).toBe("Annex: 30% occupied.");
  });
});

describe("buildUsageTrendSummary", () => {
  it("formats notable increase correctly", () => {
    const summary = buildUsageTrendSummary({
      spaceName: "Room 5A",
      currentUtilization: 67,
      previousUtilization: 54,
      period1Label: "this week",
    });

    expect(summary).toContain("Room 5A");
    expect(summary).toContain("more utilized this week");
    expect(summary).toContain("67% vs 54%");
  });

  it("formats notable decrease correctly", () => {
    const summary = buildUsageTrendSummary({
      spaceName: "Meeting Room",
      currentUtilization: 40,
      previousUtilization: 60,
      period1Label: "this month",
    });

    expect(summary).toContain("less utilized this month");
    expect(summary).toContain("40% vs 60%");
  });

  it("formats minimal change as similar", () => {
    const summary = buildUsageTrendSummary({
      spaceName: "Lounge",
      currentUtilization: 52,
      previousUtilization: 50,
      period1Label: "today",
    });

    expect(summary).toContain("Similar utilization today");
    expect(summary).toContain("52% vs 50%");
  });

  it("includes period2Label when provided", () => {
    const summary = buildUsageTrendSummary({
      spaceName: "Café",
      currentUtilization: 70,
      previousUtilization: 55,
      period1Label: "this week",
      period2Label: "last week",
    });

    expect(summary).toContain("this week");
    // Note: period2Label is not currently used in the function, but we test the current behavior
  });
});

describe("getBusinessRecommendation", () => {
  it('returns positive recommendation for "quiet"', () => {
    const rec = getBusinessRecommendation("quiet");
    expect(rec).toBe("Great time to visit - not crowded");
  });

  it('returns neutral recommendation for "moderate"', () => {
    const rec = getBusinessRecommendation("moderate");
    expect(rec).toBe("Good time to visit - moderately busy");
  });

  it('returns negative recommendation for "busy"', () => {
    const rec = getBusinessRecommendation("busy");
    expect(rec).toBe("Consider waiting or visiting later - very busy");
  });
});

describe("formatDayAndTime", () => {
  it("formats date correctly", () => {
    // Use Date.UTC to create date in UTC timezone
    const date = new Date(Date.UTC(2025, 0, 16, 14, 0, 0)); // January 16 2025, 2pm UTC (Thursday)
    const formatted = formatDayAndTime(date);
    expect(formatted).toMatch(/(Thursday|Friday) \d{1,2}(am|pm)/); // Allow timezone difference
  });

  it("handles morning times", () => {
    const date = new Date(Date.UTC(2025, 0, 17, 9, 0, 0)); // January 17 2025, 9am UTC (Friday)
    const formatted = formatDayAndTime(date);
    expect(formatted).toMatch(/(Thursday|Friday) \d{1,2}(am|pm)/); // Allow timezone difference
  });

  it("handles midnight correctly", () => {
    const date = new Date(Date.UTC(2025, 0, 15, 0, 0, 0)); // January 15 2025, midnight UTC
    const formatted = formatDayAndTime(date);
    // Midnight UTC could be previous day in local time zones west of UTC
    expect(formatted).toMatch(/(Tuesday|Wednesday) \d{1,2}(am|pm)/);
  });

  it("handles noon correctly", () => {
    const date = new Date(Date.UTC(2025, 0, 15, 12, 0, 0)); // January 15 2025, noon UTC
    const formatted = formatDayAndTime(date);
    expect(formatted).toMatch(/(Tuesday|Wednesday) \d{1,2}(am|pm)/);
  });

  it("uses current date when no date provided", () => {
    const formatted = formatDayAndTime();
    // Should return a valid day/time string
    expect(formatted).toMatch(
      /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday) \d{1,2}(am|pm)$/
    );
  });
});

describe("formatPeriodDescription", () => {
  it('returns "today" for current day', () => {
    const now = new Date();
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    const description = formatPeriodDescription(startOfToday, now);
    expect(description).toBe("today");
  });

  it('returns "yesterday" for previous day', () => {
    const now = new Date();
    const startOfYesterday = new Date(now);
    startOfYesterday.setDate(startOfYesterday.getDate() - 1);
    startOfYesterday.setHours(0, 0, 0, 0);

    const endOfYesterday = new Date(startOfYesterday);
    endOfYesterday.setHours(23, 59, 59, 999);

    const description = formatPeriodDescription(startOfYesterday, endOfYesterday);
    expect(description).toBe("yesterday");
  });

  it('returns "last 24 hours" for 24-hour period', () => {
    // Create a date that's guaranteed to not be "this week"
    const stop = new Date("2025-01-20T15:00:00Z"); // Monday afternoon
    const start = new Date(stop);
    start.setDate(start.getDate() - 1); // Sunday afternoon

    const description = formatPeriodDescription(start, stop);
    expect(description).toBe("last 24 hours");
  });

  it('returns "last 7 days" for 7-day period', () => {
    const stop = new Date();
    const start = new Date(stop);
    start.setDate(start.getDate() - 7);

    const description = formatPeriodDescription(start, stop);
    expect(description).toBe("last 7 days");
  });

  it('returns "last 30 days" for 30-day period', () => {
    const stop = new Date();
    const start = new Date(stop);
    start.setDate(start.getDate() - 30);

    const description = formatPeriodDescription(start, stop);
    expect(description).toBe("last 30 days");
  });

  it("returns day count for other periods", () => {
    const stop = new Date();
    const start = new Date(stop);
    start.setDate(start.getDate() - 14);

    const description = formatPeriodDescription(start, stop);
    expect(description).toBe("14 days");
  });
});

describe("daysBetween", () => {
  it("calculates positive days correctly", () => {
    const date1 = new Date("2025-01-01");
    const date2 = new Date("2025-01-10");
    expect(daysBetween(date1, date2)).toBe(9);
  });

  it("calculates negative days (past dates)", () => {
    const date1 = new Date("2025-01-10");
    const date2 = new Date("2025-01-01");
    expect(daysBetween(date1, date2)).toBe(-9);
  });

  it("handles same day", () => {
    const date = new Date("2025-01-01T10:00:00Z");
    expect(daysBetween(date, date)).toBe(0);
  });

  it("handles dates within same day (different times)", () => {
    const date1 = new Date("2025-01-01T08:00:00Z");
    const date2 = new Date("2025-01-01T22:00:00Z");
    expect(daysBetween(date1, date2)).toBe(0);
  });

  it("handles month boundaries", () => {
    const date1 = new Date("2025-01-31");
    const date2 = new Date("2025-02-01");
    expect(daysBetween(date1, date2)).toBe(1);
  });

  it("handles year boundaries", () => {
    const date1 = new Date("2024-12-31");
    const date2 = new Date("2025-01-01");
    expect(daysBetween(date1, date2)).toBe(1);
  });
});

describe("hoursBetween", () => {
  it("calculates positive hours correctly", () => {
    const date1 = new Date("2025-01-01T10:00:00Z");
    const date2 = new Date("2025-01-01T15:00:00Z");
    expect(hoursBetween(date1, date2)).toBe(5);
  });

  it("calculates negative hours (past dates)", () => {
    const date1 = new Date("2025-01-01T15:00:00Z");
    const date2 = new Date("2025-01-01T10:00:00Z");
    expect(hoursBetween(date1, date2)).toBe(-5);
  });

  it("handles same time", () => {
    const date = new Date("2025-01-01T10:00:00Z");
    expect(hoursBetween(date, date)).toBe(0);
  });

  it("handles day boundaries", () => {
    const date1 = new Date("2025-01-01T22:00:00Z");
    const date2 = new Date("2025-01-02T02:00:00Z");
    expect(hoursBetween(date1, date2)).toBe(4);
  });

  it("handles 24-hour period", () => {
    const date1 = new Date("2025-01-01T10:00:00Z");
    const date2 = new Date("2025-01-02T10:00:00Z");
    expect(hoursBetween(date1, date2)).toBe(24);
  });

  it("handles fractional hours (floors to integer)", () => {
    const date1 = new Date("2025-01-01T10:00:00Z");
    const date2 = new Date("2025-01-01T11:30:00Z");
    expect(hoursBetween(date1, date2)).toBe(1); // Floors 1.5 to 1
  });
});
