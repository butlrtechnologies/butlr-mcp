import { LRUCache } from "lru-cache";

/**
 * Occupancy cache configuration
 * TTL: 60 seconds (fast-changing data)
 */
const CACHE_TTL_SECONDS = parseInt(process.env.MCP_CACHE_OCCUPANCY_TTL || "60", 10) * 1000; // Convert to milliseconds
const MAX_CACHE_ENTRIES = 500; // More entries than topology (many rooms)

interface OccupancyCacheEntry {
  occupancy: number;
  timestamp: string;
  asset_id: string;
  asset_type: string;
}

/**
 * LRU cache for current occupancy data with short TTL
 * Reduces API calls for frequently accessed current occupancy queries
 *
 * Cache key format: occupancy:{asset_id}:{minute_bucket}
 * Example: occupancy:room_123:202501131400 (truncated to minute)
 */
export const occupancyCache = new LRUCache<string, OccupancyCacheEntry>({
  max: MAX_CACHE_ENTRIES,
  ttl: CACHE_TTL_SECONDS,
  updateAgeOnGet: true, // Reset TTL on cache hit
  updateAgeOnHas: false,
});

/**
 * Generate cache key for occupancy queries
 * Includes minute bucket to group queries within same minute
 */
export function generateOccupancyCacheKey(assetId: string, timestamp?: Date): string {
  const now = timestamp || new Date();

  // Truncate to minute (ignore seconds)
  const minuteBucket = new Date(now);
  minuteBucket.setSeconds(0, 0);

  const bucketStr = minuteBucket
    .toISOString()
    .replace(/[-:T]/g, "") // Remove dashes, colons, and T
    .substring(0, 12); // YYYYMMDDHHmm

  return `occupancy:${assetId}:${bucketStr}`;
}

/**
 * Get cached occupancy data
 */
export function getCachedOccupancy(
  assetId: string,
  timestamp?: Date
): OccupancyCacheEntry | undefined {
  const key = generateOccupancyCacheKey(assetId, timestamp);
  const cached = occupancyCache.get(key);

  // Track cache hit/miss metrics
  if (cached) {
    recordCacheHit();
    if (process.env.DEBUG) {
      console.error(`[occupancy-cache] Cache HIT for ${assetId}`);
    }
  } else {
    recordCacheMiss();
    if (process.env.DEBUG) {
      console.error(`[occupancy-cache] Cache MISS for ${assetId}`);
    }
  }

  return cached;
}

/**
 * Get cached occupancy for multiple assets
 * Returns { hits: {}, misses: [] }
 */
export function getBulkCachedOccupancy(
  assetIds: string[],
  timestamp?: Date
): {
  hits: Record<string, OccupancyCacheEntry>;
  misses: string[];
} {
  const hits: Record<string, OccupancyCacheEntry> = {};
  const misses: string[] = [];

  for (const assetId of assetIds) {
    const cached = getCachedOccupancy(assetId, timestamp);
    if (cached) {
      hits[assetId] = cached;
    } else {
      misses.push(assetId);
    }
  }

  if (process.env.DEBUG) {
    console.error(
      `[occupancy-cache] Bulk query: ${Object.keys(hits).length} hits, ${misses.length} misses`
    );
  }

  return { hits, misses };
}

/**
 * Store occupancy data in cache
 */
export function setCachedOccupancy(
  assetId: string,
  occupancy: number,
  assetType: string,
  timestamp?: Date
): void {
  const now = timestamp || new Date();
  const key = generateOccupancyCacheKey(assetId, now);

  const entry: OccupancyCacheEntry = {
    occupancy,
    timestamp: now.toISOString(),
    asset_id: assetId,
    asset_type: assetType,
  };

  occupancyCache.set(key, entry);

  if (process.env.DEBUG) {
    console.error(
      `[occupancy-cache] Cached occupancy for ${assetId}: ${occupancy} (TTL: ${CACHE_TTL_SECONDS / 1000}s)`
    );
  }
}

/**
 * Store multiple occupancy values
 */
export function setBulkCachedOccupancy(
  entries: Array<{
    assetId: string;
    occupancy: number;
    assetType: string;
    timestamp?: Date;
  }>
): void {
  for (const entry of entries) {
    setCachedOccupancy(entry.assetId, entry.occupancy, entry.assetType, entry.timestamp);
  }

  if (process.env.DEBUG) {
    console.error(`[occupancy-cache] Bulk cached ${entries.length} occupancy values`);
  }
}

/**
 * Clear all cached occupancy data
 */
export function clearOccupancyCache(): void {
  occupancyCache.clear();

  if (process.env.DEBUG) {
    console.error("[occupancy-cache] Cache cleared");
  }
}

/**
 * Invalidate cache for specific asset
 */
export function invalidateAssetOccupancy(assetId: string): void {
  // Delete all keys for this asset (all time buckets)
  let deleted = 0;
  for (const key of occupancyCache.keys()) {
    if (key.startsWith(`occupancy:${assetId}:`)) {
      occupancyCache.delete(key);
      deleted++;
    }
  }

  if (process.env.DEBUG && deleted > 0) {
    console.error(`[occupancy-cache] Invalidated ${deleted} cache entries for ${assetId}`);
  }
}

/**
 * Get cache statistics
 */
export function getOccupancyCacheStats() {
  return {
    size: occupancyCache.size,
    maxSize: MAX_CACHE_ENTRIES,
    ttl: CACHE_TTL_SECONDS / 1000, // Convert back to seconds for display
    utilizationPercent: (occupancyCache.size / MAX_CACHE_ENTRIES) * 100,
  };
}

/**
 * Calculate cache hit rate over time
 * (For monitoring/debugging)
 */
let cacheHits = 0;
let cacheMisses = 0;

export function recordCacheHit(): void {
  cacheHits++;
}

export function recordCacheMiss(): void {
  cacheMisses++;
}

export function getCacheHitRate(): {
  hits: number;
  misses: number;
  hitRate: number;
} {
  const total = cacheHits + cacheMisses;
  return {
    hits: cacheHits,
    misses: cacheMisses,
    hitRate: total > 0 ? (cacheHits / total) * 100 : 0,
  };
}

export function resetCacheMetrics(): void {
  cacheHits = 0;
  cacheMisses = 0;
}
