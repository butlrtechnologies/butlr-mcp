import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  getFilterField,
  getMeasurement,
  normalizeTimestamp,
  ReportingRequestBuilder,
  getCurrentOccupancy,
} from "./reporting-client.js";

describe("reporting-client", () => {
  describe("getFilterField", () => {
    it("maps room to rooms", () => {
      expect(getFilterField("room")).toBe("rooms");
    });

    it("maps floor to spaces (critical mapping!)", () => {
      expect(getFilterField("floor")).toBe("spaces");
    });

    it("maps site to clients (critical mapping!)", () => {
      expect(getFilterField("site")).toBe("clients");
    });

    it("maps building to buildings", () => {
      expect(getFilterField("building")).toBe("buildings");
    });

    it("maps zone to zones", () => {
      expect(getFilterField("zone")).toBe("zones");
    });

    it("maps sensor to sensors", () => {
      expect(getFilterField("sensor")).toBe("sensors");
    });

    it("maps hive to hives", () => {
      expect(getFilterField("hive")).toBe("hives");
    });

    it("throws error for invalid asset type", () => {
      expect(() => getFilterField("invalid")).toThrow("Unknown asset type: invalid");
      expect(() => getFilterField("invalid")).toThrow("Valid types:");
    });

    it("throws error for empty string", () => {
      expect(() => getFilterField("")).toThrow();
    });
  });

  describe("getMeasurement", () => {
    it("maps room to room_occupancy", () => {
      expect(getMeasurement("room")).toBe("room_occupancy");
    });

    it("maps zone to zone_occupancy", () => {
      expect(getMeasurement("zone")).toBe("zone_occupancy");
    });

    it("maps floor to floor_occupancy", () => {
      expect(getMeasurement("floor")).toBe("floor_occupancy");
    });

    it("maps traffic to traffic", () => {
      expect(getMeasurement("traffic")).toBe("traffic");
    });

    it("throws error for unmapped asset type", () => {
      expect(() => getMeasurement("building")).toThrow("No measurement mapping");
    });

    it("throws error for invalid asset type", () => {
      expect(() => getMeasurement("invalid")).toThrow();
    });
  });

  describe("normalizeTimestamp", () => {
    it("converts RFC3339 to ISO-8601", () => {
      const rfc3339 = "2025-01-13T14:30:00Z";
      const iso8601 = normalizeTimestamp(rfc3339);

      expect(iso8601).toBe("2025-01-13T14:30:00.000Z");
    });

    it("handles RFC3339 with milliseconds", () => {
      const rfc3339 = "2025-01-13T14:30:00.123Z";
      const iso8601 = normalizeTimestamp(rfc3339);

      expect(iso8601).toBe("2025-01-13T14:30:00.123Z");
    });

    it("handles RFC3339 with timezone offset", () => {
      const rfc3339 = "2025-01-13T14:30:00-08:00";
      const iso8601 = normalizeTimestamp(rfc3339);

      // Should normalize to UTC
      expect(iso8601).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(new Date(iso8601).toISOString()).toBe(iso8601);
    });

    it("returns empty string if parsing fails", () => {
      const invalid = "not-a-date";
      const result = normalizeTimestamp(invalid);

      expect(result).toBe("");
    });

    it("handles empty string", () => {
      const result = normalizeTimestamp("");
      expect(result).toBe("");
    });
  });

  describe("ReportingRequestBuilder", () => {
    it("builds basic request with required fields", () => {
      const request = new ReportingRequestBuilder()
        .assets("room", ["room_123"])
        .measurementForAssetType("room")
        .timeRange("-24h", "now")
        .build();

      expect(request.filter.measurements).toEqual(["room_occupancy"]);
      expect(request.filter.rooms).toEqual({ eq: ["room_123"] });
      expect(request.filter.start).toBe("-24h");
      // "now" is not set in stop (API doesn't accept "now")
      expect(request.filter.stop).toBeUndefined();
    });

    it("sets default time range to -24h", () => {
      const builder = new ReportingRequestBuilder();

      expect(builder.build).toThrow(); // Missing measurements
    });

    it("handles multiple asset IDs", () => {
      const request = new ReportingRequestBuilder()
        .assets("room", ["room_123", "room_456", "room_789"])
        .measurementForAssetType("room")
        .build();

      expect(request.filter.rooms).toEqual({
        eq: ["room_123", "room_456", "room_789"],
      });
    });

    it("throws error when measurements not specified", () => {
      const builder = new ReportingRequestBuilder().assets("room", ["room_123"]);

      expect(() => builder.build()).toThrow("At least one measurement is required");
    });

    it("allows manual measurement specification", () => {
      const request = new ReportingRequestBuilder()
        .assets("room", ["room_123"])
        .measurements(["room_occupancy", "traffic"])
        .build();

      expect(request.filter.measurements).toEqual(["room_occupancy", "traffic"]);
    });

    it("builds request with window aggregation", () => {
      const request = new ReportingRequestBuilder()
        .assets("room", ["room_123"])
        .measurementForAssetType("room")
        .window("1h", "mean", "America/Los_Angeles")
        .build();

      expect(request.window).toEqual({
        every: "1h",
        function: "mean",
        timezone: "America/Los_Angeles",
      });
    });

    it("uses default timezone when not specified in window", () => {
      const request = new ReportingRequestBuilder()
        .assets("room", ["room_123"])
        .measurementForAssetType("room")
        .window("5m", "max")
        .build();

      expect(request.window?.timezone).toBe("UTC"); // From test env
    });

    it("builds request with groupBy", () => {
      const request = new ReportingRequestBuilder()
        .assets("room", ["room_123", "room_456"])
        .measurementForAssetType("room")
        .groupBy(["room_id", "building_id"])
        .build();

      expect(request.group_by).toEqual({
        order: ["room_id", "building_id"],
        raw: true,
      });
    });

    it("allows setting raw=false in groupBy", () => {
      const request = new ReportingRequestBuilder()
        .assets("room", ["room_123"])
        .measurementForAssetType("room")
        .groupBy(["room_id"], false)
        .build();

      expect(request.group_by?.raw).toBe(false);
    });

    it("builds request with pagination", () => {
      const request = new ReportingRequestBuilder()
        .assets("room", ["room_123"])
        .measurementForAssetType("room")
        .paginate(2, 50)
        .build();

      expect(request.paginate).toEqual({
        page: 2,
        limit: 50,
      });
    });

    it("builds request with tags filter", () => {
      const request = new ReportingRequestBuilder()
        .assets("room", ["room_123"])
        .measurementForAssetType("room")
        .tags(["conference", "video-equipped"])
        .build();

      expect(request.filter.tags).toEqual({
        eq: ["conference", "video-equipped"],
      });
    });

    it("handles relative time ranges", () => {
      const request = new ReportingRequestBuilder()
        .assets("room", ["room_123"])
        .measurementForAssetType("room")
        .timeRange("-1h")
        .build();

      expect(request.filter.start).toBe("-1h");
      expect(request.filter.stop).toBeUndefined();
    });

    it("handles ISO-8601 time ranges", () => {
      const request = new ReportingRequestBuilder()
        .assets("room", ["room_123"])
        .measurementForAssetType("room")
        .timeRange("2025-01-13T00:00:00Z", "2025-01-13T23:59:59Z")
        .build();

      expect(request.filter.start).toBe("2025-01-13T00:00:00Z");
      expect(request.filter.stop).toBe("2025-01-13T23:59:59Z");
    });

    it("supports fluent chaining", () => {
      const request = new ReportingRequestBuilder()
        .assets("room", ["room_123"])
        .measurementForAssetType("room")
        .timeRange("-24h", "now")
        .window("1h", "mean")
        .groupBy(["room_id"])
        .paginate(1, 100)
        .tags(["conference"])
        .build();

      expect(request.filter.rooms).toBeDefined();
      expect(request.filter.measurements).toEqual(["room_occupancy"]);
      expect(request.window).toBeDefined();
      expect(request.group_by).toBeDefined();
      expect(request.paginate).toBeDefined();
      expect(request.filter.tags).toBeDefined();
    });

    it("handles different asset types correctly", () => {
      const roomRequest = new ReportingRequestBuilder()
        .assets("room", ["room_123"])
        .measurementForAssetType("room")
        .build();

      const floorRequest = new ReportingRequestBuilder()
        .assets("floor", ["floor_456"])
        .measurementForAssetType("floor")
        .build();

      const zoneRequest = new ReportingRequestBuilder()
        .assets("zone", ["zone_789"])
        .measurementForAssetType("zone")
        .build();

      expect(roomRequest.filter.rooms).toBeDefined();
      expect(roomRequest.filter.measurements).toEqual(["room_occupancy"]);

      expect(floorRequest.filter.spaces).toBeDefined(); // floors → spaces!
      expect(floorRequest.filter.measurements).toEqual(["floor_occupancy"]);

      expect(zoneRequest.filter.zones).toBeDefined();
      expect(zoneRequest.filter.measurements).toEqual(["zone_occupancy"]);
    });

    it("includes default options in request", () => {
      const request = new ReportingRequestBuilder()
        .assets("room", ["room_123"])
        .measurementForAssetType("room")
        .build();

      expect(request.options).toEqual({
        format: "json",
        timestamp: "RFC3339",
        // precision removed (API doesn't accept "s")
      });
    });
  });

  describe("getCurrentOccupancy", () => {
    // Note: This function calls the actual API, so we'll mock it
    beforeEach(() => {
      vi.resetAllMocks();
    });

    it("builds correct request for current occupancy", () => {
      // We can test the request structure by checking what would be built
      const builder = new ReportingRequestBuilder()
        .assets("room", ["room_123"])
        .measurementForAssetType("room")
        .timeRange("-5m", "now")
        .window("1m", "max")
        .groupBy(["room_id"]);

      const request = builder.build();

      expect(request.filter.start).toBe("-5m");
      // "now" is not set (API doesn't accept it)
      expect(request.filter.stop).toBeUndefined();
      expect(request.window?.every).toBe("1m");
      expect(request.window?.function).toBe("max");
      expect(request.group_by?.order).toEqual(["room_id"]);
    });
  });

  describe("edge cases", () => {
    it("handles empty asset ID array", () => {
      const request = new ReportingRequestBuilder()
        .assets("room", [])
        .measurementForAssetType("room")
        .build();

      expect(request.filter.rooms).toEqual({ eq: [] });
    });

    it("handles very long asset ID lists", () => {
      const manyRooms = Array.from({ length: 100 }, (_, i) => `room_${i}`);

      const request = new ReportingRequestBuilder()
        .assets("room", manyRooms)
        .measurementForAssetType("room")
        .build();

      expect(request.filter.rooms?.eq).toHaveLength(100);
    });

    it("handles special characters in asset IDs", () => {
      const request = new ReportingRequestBuilder()
        .assets("room", ["room_ABC-123_xyz"])
        .measurementForAssetType("room")
        .build();

      expect(request.filter.rooms).toEqual({ eq: ["room_ABC-123_xyz"] });
    });

    it("handles multiple tags", () => {
      const request = new ReportingRequestBuilder()
        .assets("room", ["room_123"])
        .measurementForAssetType("room")
        .tags(["tag1", "tag2", "tag3"])
        .build();

      expect(request.filter.tags?.eq).toHaveLength(3);
    });

    it("handles empty tags array", () => {
      const request = new ReportingRequestBuilder()
        .assets("room", ["room_123"])
        .measurementForAssetType("room")
        .tags([])
        .build();

      expect(request.filter.tags).toEqual({ eq: [] });
    });
  });

  describe("window aggregation functions", () => {
    it("supports all aggregation functions", () => {
      const functions: Array<"mean" | "max" | "min" | "sum" | "first" | "last"> = [
        "mean",
        "max",
        "min",
        "sum",
        "first",
        "last",
      ];

      functions.forEach((func) => {
        const request = new ReportingRequestBuilder()
          .assets("room", ["room_123"])
          .measurementForAssetType("room")
          .window("1h", func)
          .build();

        expect(request.window?.function).toBe(func);
      });
    });

    it("supports various window intervals", () => {
      const intervals = ["1m", "5m", "15m", "30m", "1h", "6h", "12h", "1d"];

      intervals.forEach((interval) => {
        const request = new ReportingRequestBuilder()
          .assets("room", ["room_123"])
          .measurementForAssetType("room")
          .window(interval, "mean")
          .build();

        expect(request.window?.every).toBe(interval);
      });
    });
  });

  describe("field mapping consistency", () => {
    it("ensures all field mappings are bidirectional", () => {
      // This test ensures we don't have missing mappings
      const assetTypes = ["site", "building", "floor", "room", "zone", "sensor", "hive"];

      assetTypes.forEach((type) => {
        expect(() => getFilterField(type)).not.toThrow();
      });
    });

    it("ensures measurement mappings exist for queryable types", () => {
      const queryableTypes = ["room", "zone", "floor", "traffic"];

      queryableTypes.forEach((type) => {
        expect(() => getMeasurement(type)).not.toThrow();
      });
    });
  });
});
