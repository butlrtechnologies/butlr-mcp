import { describe, it, expect } from "vitest";
import { StatsRequestBuilder, calculateStatistics } from "./stats-client.js";

describe("stats-client", () => {
  describe("StatsRequestBuilder", () => {
    it("builds basic stats request", () => {
      const request = new StatsRequestBuilder()
        .measurements(["occupancy_avg_presence"])
        .assets(["room_123"])
        .build();

      expect(request.measurements).toEqual(["occupancy_avg_presence"]);
      expect(request.items).toEqual(["room_123"]);
      // No default time range anymore (must be set explicitly)
      expect(request.start).toBeUndefined();
    });

    it("converts relative times to ISO-8601", () => {
      const request = new StatsRequestBuilder()
        .measurements(["occupancy_avg_presence"])
        .assets(["room_123"])
        .timeRange("-7d")
        .build();

      // Should be converted to ISO-8601
      expect(request.start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(request.stop).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it("handles multiple measurements", () => {
      const request = new StatsRequestBuilder()
        .measurements(["occupancy_avg_presence", "occupancy_median_presence"])
        .assets(["room_123"])
        .build();

      expect(request.measurements).toEqual(["occupancy_avg_presence", "occupancy_median_presence"]);
    });

    it("handles multiple asset IDs", () => {
      const request = new StatsRequestBuilder()
        .measurements(["occupancy_avg_presence"])
        .assets(["room_123", "room_456", "room_789"])
        .build();

      expect(request.items).toEqual(["room_123", "room_456", "room_789"]);
    });

    it("allows custom time range with start only (auto-adds stop)", () => {
      const request = new StatsRequestBuilder()
        .measurements(["occupancy_avg_presence"])
        .assets(["room_123"])
        .timeRange("-30d")
        .build();

      // Start is converted from relative to ISO-8601
      expect(request.start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      // Stop is auto-set to "now" (converted to ISO-8601)
      expect(request.stop).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it("allows custom time range with start and stop", () => {
      const request = new StatsRequestBuilder()
        .measurements(["occupancy_avg_presence"])
        .assets(["room_123"])
        .timeRange("2025-01-01T00:00:00Z", "2025-01-31T23:59:59Z")
        .build();

      expect(request.start).toBe("2025-01-01T00:00:00Z");
      expect(request.stop).toBe("2025-01-31T23:59:59Z");
    });

    it("supports fluent chaining", () => {
      const request = new StatsRequestBuilder()
        .measurements(["occupancy_avg_presence"])
        .assets(["room_123"])
        .timeRange("-14d", "now")
        .build();

      expect(request.measurements).toBeDefined();
      expect(request.items).toBeDefined();
      // Start is converted from relative
      expect(request.start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      // Stop is converted from "now" to ISO-8601
      expect(request.stop).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it("throws error when measurements not specified", () => {
      const builder = new StatsRequestBuilder().assets(["room_123"]);

      expect(() => builder.build()).toThrow("At least one measurement is required");
    });

    it("throws error when assets not specified", () => {
      const builder = new StatsRequestBuilder().measurements(["occupancy_avg_presence"]);

      expect(() => builder.build()).toThrow("At least one asset ID is required");
    });

    it("throws error when both measurements and assets missing", () => {
      const builder = new StatsRequestBuilder();

      expect(() => builder.build()).toThrow("At least one measurement is required");
    });

    it("converts relative time strings to ISO-8601", () => {
      const timeRanges = ["-1h", "-24h", "-7d", "-30d", "-90d"];

      timeRanges.forEach((range) => {
        const request = new StatsRequestBuilder()
          .measurements(["occupancy_avg_presence"])
          .assets(["room_123"])
          .timeRange(range)
          .build();

        // Should be converted to ISO-8601
        expect(request.start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(request.stop).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      });
    });

    it("passes through ISO-8601 timestamps unchanged", () => {
      const request = new StatsRequestBuilder()
        .measurements(["occupancy_avg_presence"])
        .assets(["room_123"])
        .timeRange("2025-01-13T00:00:00Z", "2025-01-20T00:00:00Z")
        .build();

      expect(request.start).toBe("2025-01-13T00:00:00Z");
      expect(request.stop).toBe("2025-01-20T00:00:00Z");
    });
  });

  describe("calculateStatistics", () => {
    it("calculates correct statistics for sample data", () => {
      const values = [1, 2, 3, 4, 5];
      const stats = calculateStatistics(values);

      expect(stats.count).toBe(5);
      expect(stats.first).toBe(1);
      expect(stats.last).toBe(5);
      expect(stats.min).toBe(1);
      expect(stats.max).toBe(5);
      expect(stats.sum).toBe(15);
      expect(stats.mean).toBe(3);
      expect(stats.median).toBe(3);
      expect(stats.stdev).toBeCloseTo(1.41, 1); // sqrt(2) ≈ 1.41
    });

    it("handles single value", () => {
      const stats = calculateStatistics([42]);

      expect(stats.count).toBe(1);
      expect(stats.first).toBe(42);
      expect(stats.last).toBe(42);
      expect(stats.min).toBe(42);
      expect(stats.max).toBe(42);
      expect(stats.mean).toBe(42);
      expect(stats.median).toBe(42);
      expect(stats.stdev).toBe(0);
      expect(stats.sum).toBe(42);
    });

    it("handles empty array", () => {
      const stats = calculateStatistics([]);

      expect(stats.count).toBe(0);
      expect(stats.first).toBe(0);
      expect(stats.last).toBe(0);
      expect(stats.min).toBe(0);
      expect(stats.max).toBe(0);
      expect(stats.mean).toBe(0);
      expect(stats.median).toBe(0);
      expect(stats.stdev).toBe(0);
      expect(stats.sum).toBe(0);
    });

    it("calculates median correctly for even-length array", () => {
      const values = [1, 2, 3, 4];
      const stats = calculateStatistics(values);

      expect(stats.median).toBe(2.5); // (2 + 3) / 2
    });

    it("calculates median correctly for odd-length array", () => {
      const values = [1, 2, 3, 4, 5];
      const stats = calculateStatistics(values);

      expect(stats.median).toBe(3);
    });

    it("handles unsorted input data", () => {
      const values = [5, 1, 3, 2, 4];
      const stats = calculateStatistics(values);

      expect(stats.median).toBe(3);
      expect(stats.min).toBe(1);
      expect(stats.max).toBe(5);
      expect(stats.first).toBe(5); // First in input order
      expect(stats.last).toBe(4); // Last in input order
    });

    it("handles duplicate values", () => {
      const values = [5, 5, 5, 5, 5];
      const stats = calculateStatistics(values);

      expect(stats.count).toBe(5);
      expect(stats.mean).toBe(5);
      expect(stats.median).toBe(5);
      expect(stats.min).toBe(5);
      expect(stats.max).toBe(5);
      expect(stats.stdev).toBe(0);
      expect(stats.sum).toBe(25);
    });

    it("handles negative values", () => {
      const values = [-5, -3, -1, 0, 1, 3, 5];
      const stats = calculateStatistics(values);

      expect(stats.mean).toBe(0);
      expect(stats.median).toBe(0);
      expect(stats.min).toBe(-5);
      expect(stats.max).toBe(5);
      expect(stats.sum).toBe(0);
    });

    it("handles decimal values", () => {
      const values = [1.5, 2.5, 3.5];
      const stats = calculateStatistics(values);

      expect(stats.mean).toBe(2.5);
      expect(stats.median).toBe(2.5);
      expect(stats.sum).toBe(7.5);
    });

    it("handles large numbers", () => {
      const values = [1000, 2000, 3000, 4000, 5000];
      const stats = calculateStatistics(values);

      expect(stats.mean).toBe(3000);
      expect(stats.median).toBe(3000);
      expect(stats.sum).toBe(15000);
    });

    it("handles zero values", () => {
      const values = [0, 0, 0, 0];
      const stats = calculateStatistics(values);

      expect(stats.count).toBe(4);
      expect(stats.mean).toBe(0);
      expect(stats.median).toBe(0);
      expect(stats.stdev).toBe(0);
      expect(stats.sum).toBe(0);
    });

    it("rounds mean, median, and stdev to 2 decimal places", () => {
      const values = [1, 2, 3];
      const stats = calculateStatistics(values);

      expect(stats.mean).toBe(2); // Exactly 2.00
      expect(stats.median).toBe(2); // Exactly 2.00

      // Standard deviation should be rounded to 2 decimals
      expect(Number.isInteger(stats.stdev * 100)).toBe(true);
    });

    it("preserves original array (immutability)", () => {
      const values = [5, 1, 3, 2, 4];
      const originalValues = [...values];

      calculateStatistics(values);

      expect(values).toEqual(originalValues);
    });

    it("handles outliers correctly", () => {
      const values = [1, 2, 3, 4, 100]; // 100 is an outlier
      const stats = calculateStatistics(values);

      expect(stats.mean).toBe(22); // Affected by outlier
      expect(stats.median).toBe(3); // Less affected by outlier
      expect(stats.max).toBe(100);
    });

    it("calculates standard deviation correctly", () => {
      // Known dataset: [2, 4, 4, 4, 5, 5, 7, 9]
      // Mean = 5, Variance = 4, StdDev = 2
      const values = [2, 4, 4, 4, 5, 5, 7, 9];
      const stats = calculateStatistics(values);

      expect(stats.mean).toBe(5);
      expect(stats.stdev).toBe(2); // Exactly 2.00
    });

    it("handles very small differences in values", () => {
      const values = [1.001, 1.002, 1.003];
      const stats = calculateStatistics(values);

      // Mean is rounded to 2 decimal places (1.00)
      expect(stats.mean).toBe(1);
      expect(stats.median).toBe(1);
    });
  });

  describe("edge cases", () => {
    it("handles empty measurements array", () => {
      const builder = new StatsRequestBuilder().measurements([]).assets(["room_123"]);

      expect(() => builder.build()).toThrow("At least one measurement is required");
    });

    it("handles empty assets array", () => {
      const builder = new StatsRequestBuilder().measurements(["occupancy_avg_presence"]).assets([]);

      expect(() => builder.build()).toThrow("At least one asset ID is required");
    });

    it("handles very long asset lists", () => {
      const manyAssets = Array.from({ length: 100 }, (_, i) => `room_${i}`);

      const request = new StatsRequestBuilder()
        .measurements(["occupancy_avg_presence"])
        .assets(manyAssets)
        .build();

      expect(request.items).toHaveLength(100);
    });

    it("handles special characters in asset IDs", () => {
      const request = new StatsRequestBuilder()
        .measurements(["occupancy_avg_presence"])
        .assets(["room_ABC-123_xyz"])
        .build();

      expect(request.items).toEqual(["room_ABC-123_xyz"]);
    });

    it("handles multiple measurements simultaneously", () => {
      const request = new StatsRequestBuilder()
        .measurements([
          "occupancy_avg_presence",
          "occupancy_median_presence",
          "occupancy_avg_traffic",
        ])
        .assets(["room_123"])
        .build();

      expect(request.measurements).toHaveLength(3);
    });
  });

  describe("time range validation", () => {
    it("converts various relative time formats to ISO-8601", () => {
      const formats = ["-1m", "-5m", "-1h", "-6h", "-24h", "-1d", "-7d", "-30d", "-90d"];

      formats.forEach((format) => {
        const request = new StatsRequestBuilder()
          .measurements(["occupancy_avg_presence"])
          .assets(["room_123"])
          .timeRange(format)
          .build();

        // Should be converted to ISO-8601
        expect(request.start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(request.stop).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      });
    });

    it("passes through ISO-8601 date strings", () => {
      const request = new StatsRequestBuilder()
        .measurements(["occupancy_avg_presence"])
        .assets(["room_123"])
        .timeRange("2025-01-01T00:00:00Z", "2025-01-31T23:59:59Z")
        .build();

      expect(request.start).toBe("2025-01-01T00:00:00Z");
      expect(request.stop).toBe("2025-01-31T23:59:59Z");
    });

    it("converts 'now' to current timestamp", () => {
      const request = new StatsRequestBuilder()
        .measurements(["occupancy_avg_presence"])
        .assets(["room_123"])
        .timeRange("-7d", "now")
        .build();

      // "now" should be converted to ISO-8601
      expect(request.stop).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });

  describe("calculateStatistics - stress tests", () => {
    it("handles large datasets efficiently", () => {
      const largeDataset = Array.from({ length: 10000 }, (_, i) => i);
      const startTime = Date.now();

      const stats = calculateStatistics(largeDataset);

      const duration = Date.now() - startTime;

      expect(stats.count).toBe(10000);
      expect(stats.mean).toBe(4999.5);
      expect(stats.median).toBe(4999.5);
      expect(duration).toBeLessThan(100); // Should complete in <100ms
    });

    it("handles all identical values", () => {
      const values = new Array(100).fill(7);
      const stats = calculateStatistics(values);

      expect(stats.mean).toBe(7);
      expect(stats.median).toBe(7);
      expect(stats.stdev).toBe(0);
      expect(stats.min).toBe(7);
      expect(stats.max).toBe(7);
    });

    it("handles extreme variance", () => {
      const values = [0, 1000000];
      const stats = calculateStatistics(values);

      expect(stats.mean).toBe(500000);
      expect(stats.median).toBe(500000);
      expect(stats.min).toBe(0);
      expect(stats.max).toBe(1000000);
    });
  });
});
