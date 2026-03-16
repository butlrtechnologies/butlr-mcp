import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  generateOccupancyCacheKey,
  getCachedOccupancy,
  getBulkCachedOccupancy,
  setCachedOccupancy,
  setBulkCachedOccupancy,
  clearOccupancyCache,
  invalidateAssetOccupancy,
  getOccupancyCacheStats,
  getCacheHitRate,
  resetCacheMetrics,
  occupancyCache,
} from "./occupancy-cache.js";

describe("occupancy-cache", () => {
  beforeEach(() => {
    // Clear cache before each test
    clearOccupancyCache();
    resetCacheMetrics();
  });

  afterEach(() => {
    // Clean up after each test
    clearOccupancyCache();
    resetCacheMetrics();
  });

  describe("generateOccupancyCacheKey", () => {
    it("truncates to minute bucket", () => {
      const date1 = new Date("2025-01-13T14:30:45.123Z");
      const date2 = new Date("2025-01-13T14:30:12.000Z");

      const key1 = generateOccupancyCacheKey("room_123", date1);
      const key2 = generateOccupancyCacheKey("room_123", date2);

      // Same minute = same key
      expect(key1).toBe(key2);
      expect(key1).toBe("occupancy:room_123:202501131430");
    });

    it("generates different keys for different minutes", () => {
      const date1 = new Date("2025-01-13T14:30:00Z");
      const date2 = new Date("2025-01-13T14:31:00Z");

      const key1 = generateOccupancyCacheKey("room_123", date1);
      const key2 = generateOccupancyCacheKey("room_123", date2);

      expect(key1).not.toBe(key2);
      expect(key1).toBe("occupancy:room_123:202501131430");
      expect(key2).toBe("occupancy:room_123:202501131431");
    });

    it("generates different keys for different asset IDs", () => {
      const date = new Date("2025-01-13T14:30:00Z");

      const key1 = generateOccupancyCacheKey("room_123", date);
      const key2 = generateOccupancyCacheKey("room_456", date);

      expect(key1).not.toBe(key2);
      expect(key1).toContain("room_123");
      expect(key2).toContain("room_456");
    });

    it("uses current time when no timestamp provided", () => {
      const key = generateOccupancyCacheKey("room_123");

      expect(key).toMatch(/^occupancy:room_123:\d{12}$/);
    });

    it("formats month correctly (01-12 not 0-11)", () => {
      const date = new Date("2025-01-05T10:15:00Z"); // January (month 0 in JS)
      const key = generateOccupancyCacheKey("room_123", date);

      // Should be 202501 not 202500
      expect(key).toContain("202501");
    });
  });

  describe("getCachedOccupancy and setCachedOccupancy", () => {
    it("stores and retrieves occupancy data", () => {
      const timestamp = new Date("2025-01-13T14:30:00Z");

      setCachedOccupancy("room_123", 5, "room", timestamp);
      const cached = getCachedOccupancy("room_123", timestamp);

      expect(cached).toBeDefined();
      expect(cached?.occupancy).toBe(5);
      expect(cached?.asset_id).toBe("room_123");
      expect(cached?.asset_type).toBe("room");
    });

    it("returns undefined for non-existent entry", () => {
      const cached = getCachedOccupancy("room_nonexistent");
      expect(cached).toBeUndefined();
    });

    it("overwrites existing entry with same key", () => {
      const timestamp = new Date("2025-01-13T14:30:00Z");

      setCachedOccupancy("room_123", 5, "room", timestamp);
      setCachedOccupancy("room_123", 10, "room", timestamp);

      const cached = getCachedOccupancy("room_123", timestamp);
      expect(cached?.occupancy).toBe(10); // Should have new value
    });

    it("stores different entries for different minute buckets", () => {
      const timestamp1 = new Date("2025-01-13T14:30:00Z");
      const timestamp2 = new Date("2025-01-13T14:31:00Z");

      setCachedOccupancy("room_123", 5, "room", timestamp1);
      setCachedOccupancy("room_123", 10, "room", timestamp2);

      const cached1 = getCachedOccupancy("room_123", timestamp1);
      const cached2 = getCachedOccupancy("room_123", timestamp2);

      expect(cached1?.occupancy).toBe(5);
      expect(cached2?.occupancy).toBe(10);
    });
  });

  describe("getBulkCachedOccupancy", () => {
    it("separates hits and misses", () => {
      const timestamp = new Date("2025-01-13T14:30:00Z");

      setCachedOccupancy("room_1", 5, "room", timestamp);
      setCachedOccupancy("room_2", 10, "room", timestamp);
      // room_3 not cached

      const result = getBulkCachedOccupancy(["room_1", "room_2", "room_3"], timestamp);

      expect(Object.keys(result.hits)).toHaveLength(2);
      expect(result.hits["room_1"]?.occupancy).toBe(5);
      expect(result.hits["room_2"]?.occupancy).toBe(10);
      expect(result.misses).toEqual(["room_3"]);
    });

    it("returns all misses when cache is empty", () => {
      const result = getBulkCachedOccupancy(["room_1", "room_2", "room_3"]);

      expect(Object.keys(result.hits)).toHaveLength(0);
      expect(result.misses).toEqual(["room_1", "room_2", "room_3"]);
    });

    it("returns all hits when all assets cached", () => {
      const timestamp = new Date("2025-01-13T14:30:00Z");

      setCachedOccupancy("room_1", 5, "room", timestamp);
      setCachedOccupancy("room_2", 10, "room", timestamp);
      setCachedOccupancy("room_3", 15, "room", timestamp);

      const result = getBulkCachedOccupancy(["room_1", "room_2", "room_3"], timestamp);

      expect(Object.keys(result.hits)).toHaveLength(3);
      expect(result.misses).toHaveLength(0);
    });

    it("handles empty array", () => {
      const result = getBulkCachedOccupancy([]);

      expect(Object.keys(result.hits)).toHaveLength(0);
      expect(result.misses).toHaveLength(0);
    });
  });

  describe("setBulkCachedOccupancy", () => {
    it("stores multiple entries at once", () => {
      const timestamp = new Date("2025-01-13T14:30:00Z");

      setBulkCachedOccupancy([
        { assetId: "room_1", occupancy: 5, assetType: "room", timestamp },
        { assetId: "room_2", occupancy: 10, assetType: "room", timestamp },
        { assetId: "room_3", occupancy: 15, assetType: "room", timestamp },
      ]);

      const cached1 = getCachedOccupancy("room_1", timestamp);
      const cached2 = getCachedOccupancy("room_2", timestamp);
      const cached3 = getCachedOccupancy("room_3", timestamp);

      expect(cached1?.occupancy).toBe(5);
      expect(cached2?.occupancy).toBe(10);
      expect(cached3?.occupancy).toBe(15);
    });

    it("handles empty array", () => {
      expect(() => setBulkCachedOccupancy([])).not.toThrow();
    });

    it("handles entries with different timestamps", () => {
      const timestamp1 = new Date("2025-01-13T14:30:00Z");
      const timestamp2 = new Date("2025-01-13T14:31:00Z");

      setBulkCachedOccupancy([
        { assetId: "room_1", occupancy: 5, assetType: "room", timestamp: timestamp1 },
        { assetId: "room_1", occupancy: 10, assetType: "room", timestamp: timestamp2 },
      ]);

      const cached1 = getCachedOccupancy("room_1", timestamp1);
      const cached2 = getCachedOccupancy("room_1", timestamp2);

      expect(cached1?.occupancy).toBe(5);
      expect(cached2?.occupancy).toBe(10);
    });
  });

  describe("invalidateAssetOccupancy", () => {
    it("clears all cache entries for specific asset", () => {
      const timestamp1 = new Date("2025-01-13T14:30:00Z");
      const timestamp2 = new Date("2025-01-13T14:31:00Z");
      const timestamp3 = new Date("2025-01-13T14:32:00Z");

      // Cache same asset at multiple times
      setCachedOccupancy("room_123", 5, "room", timestamp1);
      setCachedOccupancy("room_123", 10, "room", timestamp2);
      setCachedOccupancy("room_123", 15, "room", timestamp3);
      // Cache different asset
      setCachedOccupancy("room_456", 20, "room", timestamp1);

      // Invalidate room_123
      invalidateAssetOccupancy("room_123");

      // room_123 should be cleared
      expect(getCachedOccupancy("room_123", timestamp1)).toBeUndefined();
      expect(getCachedOccupancy("room_123", timestamp2)).toBeUndefined();
      expect(getCachedOccupancy("room_123", timestamp3)).toBeUndefined();

      // room_456 should still be cached
      expect(getCachedOccupancy("room_456", timestamp1)?.occupancy).toBe(20);
    });

    it("handles invalidation of non-existent asset", () => {
      expect(() => invalidateAssetOccupancy("room_nonexistent")).not.toThrow();
    });

    it("clears all time buckets for asset", () => {
      // Create entries across many minutes
      for (let i = 0; i < 10; i++) {
        const timestamp = new Date(`2025-01-13T14:${30 + i}:00Z`);
        setCachedOccupancy("room_123", i, "room", timestamp);
      }

      invalidateAssetOccupancy("room_123");

      // All should be cleared
      for (let i = 0; i < 10; i++) {
        const timestamp = new Date(`2025-01-13T14:${30 + i}:00Z`);
        expect(getCachedOccupancy("room_123", timestamp)).toBeUndefined();
      }
    });
  });

  describe("clearOccupancyCache", () => {
    it("removes all entries from cache", () => {
      const timestamp = new Date("2025-01-13T14:30:00Z");

      setCachedOccupancy("room_1", 5, "room", timestamp);
      setCachedOccupancy("room_2", 10, "room", timestamp);
      setCachedOccupancy("room_3", 15, "room", timestamp);

      clearOccupancyCache();

      expect(getCachedOccupancy("room_1", timestamp)).toBeUndefined();
      expect(getCachedOccupancy("room_2", timestamp)).toBeUndefined();
      expect(getCachedOccupancy("room_3", timestamp)).toBeUndefined();
      expect(occupancyCache.size).toBe(0);
    });

    it("handles empty cache", () => {
      expect(() => clearOccupancyCache()).not.toThrow();
    });
  });

  describe("getOccupancyCacheStats", () => {
    it("returns correct cache statistics", () => {
      const timestamp = new Date("2025-01-13T14:30:00Z");

      setCachedOccupancy("room_1", 5, "room", timestamp);
      setCachedOccupancy("room_2", 10, "room", timestamp);
      setCachedOccupancy("room_3", 15, "room", timestamp);

      const stats = getOccupancyCacheStats();

      expect(stats.size).toBe(3);
      expect(stats.maxSize).toBe(500);
      expect(stats.ttl).toBe(60); // Default TTL in seconds
      expect(stats.utilizationPercent).toBeCloseTo(0.6, 1); // 3/500 = 0.6%
    });

    it("returns zero stats for empty cache", () => {
      const stats = getOccupancyCacheStats();

      expect(stats.size).toBe(0);
      expect(stats.utilizationPercent).toBe(0);
    });

    it("calculates utilization percentage correctly", () => {
      const timestamp = new Date("2025-01-13T14:30:00Z");

      // Add 50 entries
      for (let i = 0; i < 50; i++) {
        setCachedOccupancy(`room_${i}`, i, "room", timestamp);
      }

      const stats = getOccupancyCacheStats();

      expect(stats.size).toBe(50);
      expect(stats.utilizationPercent).toBe(10); // 50/500 = 10%
    });
  });

  describe("getCacheHitRate", () => {
    it("calculates hit rate correctly", () => {
      const timestamp = new Date("2025-01-13T14:30:00Z");

      // Set up cache with 2 entries
      setCachedOccupancy("room_1", 5, "room", timestamp);
      setCachedOccupancy("room_2", 10, "room", timestamp);

      // 2 hits
      getCachedOccupancy("room_1", timestamp);
      getCachedOccupancy("room_2", timestamp);

      // 1 miss
      getCachedOccupancy("room_3", timestamp);

      const hitRate = getCacheHitRate();

      expect(hitRate.hits).toBe(2);
      expect(hitRate.misses).toBe(1);
      expect(hitRate.hitRate).toBeCloseTo(66.67, 1); // 2/3 = 66.67%
    });

    it("returns 0% hit rate when no queries", () => {
      const hitRate = getCacheHitRate();

      expect(hitRate.hits).toBe(0);
      expect(hitRate.misses).toBe(0);
      expect(hitRate.hitRate).toBe(0);
    });

    it("returns 100% hit rate when all hits", () => {
      const timestamp = new Date("2025-01-13T14:30:00Z");

      setCachedOccupancy("room_1", 5, "room", timestamp);
      setCachedOccupancy("room_2", 10, "room", timestamp);

      getCachedOccupancy("room_1", timestamp);
      getCachedOccupancy("room_2", timestamp);

      const hitRate = getCacheHitRate();

      expect(hitRate.hitRate).toBe(100);
    });

    it("returns 0% hit rate when all misses", () => {
      getCachedOccupancy("room_1");
      getCachedOccupancy("room_2");
      getCachedOccupancy("room_3");

      const hitRate = getCacheHitRate();

      expect(hitRate.hitRate).toBe(0);
    });
  });

  describe("resetCacheMetrics", () => {
    it("resets hit/miss counters", () => {
      const timestamp = new Date("2025-01-13T14:30:00Z");

      setCachedOccupancy("room_1", 5, "room", timestamp);
      getCachedOccupancy("room_1", timestamp); // hit
      getCachedOccupancy("room_2", timestamp); // miss

      let hitRate = getCacheHitRate();
      expect(hitRate.hits).toBe(1);
      expect(hitRate.misses).toBe(1);

      resetCacheMetrics();

      hitRate = getCacheHitRate();
      expect(hitRate.hits).toBe(0);
      expect(hitRate.misses).toBe(0);
      expect(hitRate.hitRate).toBe(0);
    });
  });

  describe("cache TTL behavior", () => {
    it("stores timestamp with cached entry", () => {
      const timestamp = new Date("2025-01-13T14:30:00Z");

      setCachedOccupancy("room_123", 5, "room", timestamp);
      const cached = getCachedOccupancy("room_123", timestamp);

      expect(cached?.timestamp).toBeDefined();
      expect(new Date(cached!.timestamp).getTime()).toBe(timestamp.getTime());
    });

    // Note: Testing actual TTL expiration requires mocking timers or waiting,
    // which is not practical in fast unit tests. TTL is tested implicitly
    // through LRU cache behavior.
  });

  describe("edge cases", () => {
    it("handles zero occupancy", () => {
      const timestamp = new Date("2025-01-13T14:30:00Z");

      setCachedOccupancy("room_123", 0, "room", timestamp);
      const cached = getCachedOccupancy("room_123", timestamp);

      expect(cached?.occupancy).toBe(0);
    });

    it("handles negative occupancy (shouldn't happen but test robustness)", () => {
      const timestamp = new Date("2025-01-13T14:30:00Z");

      setCachedOccupancy("room_123", -1, "room", timestamp);
      const cached = getCachedOccupancy("room_123", timestamp);

      expect(cached?.occupancy).toBe(-1);
    });

    it("handles large occupancy values", () => {
      const timestamp = new Date("2025-01-13T14:30:00Z");

      setCachedOccupancy("room_123", 999999, "room", timestamp);
      const cached = getCachedOccupancy("room_123", timestamp);

      expect(cached?.occupancy).toBe(999999);
    });

    it("handles special characters in asset IDs", () => {
      const timestamp = new Date("2025-01-13T14:30:00Z");

      setCachedOccupancy("room_ABC-123_xyz", 5, "room", timestamp);
      const cached = getCachedOccupancy("room_ABC-123_xyz", timestamp);

      expect(cached?.occupancy).toBe(5);
    });

    it("handles different asset types", () => {
      const timestamp = new Date("2025-01-13T14:30:00Z");

      setCachedOccupancy("room_123", 5, "room", timestamp);
      setCachedOccupancy("zone_456", 10, "zone", timestamp);
      setCachedOccupancy("floor_789", 50, "floor", timestamp);

      expect(getCachedOccupancy("room_123", timestamp)?.asset_type).toBe("room");
      expect(getCachedOccupancy("zone_456", timestamp)?.asset_type).toBe("zone");
      expect(getCachedOccupancy("floor_789", timestamp)?.asset_type).toBe("floor");
    });
  });
});
