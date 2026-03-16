import { LRUCache } from "lru-cache";

/**
 * Topology cache configuration
 */
const CACHE_TTL_SECONDS = parseInt(process.env.MCP_CACHE_TOPO_TTL || "600", 10) * 1000; // Convert to milliseconds
const MAX_CACHE_ENTRIES = 100;

interface CacheEntry {
  data: any;
  timestamp: string;
}

/**
 * LRU cache for topology data with TTL
 * Reduces API calls for frequently accessed topology structures
 */
export const topologyCache = new LRUCache<string, CacheEntry>({
  max: MAX_CACHE_ENTRIES,
  ttl: CACHE_TTL_SECONDS,
  updateAgeOnGet: true, // Reset TTL on cache hit
  updateAgeOnHas: false,
});

/**
 * Generate cache key for topology queries
 */
export function generateTopologyCacheKey(
  orgId: string,
  includeDevices: boolean,
  includeZones: boolean,
  siteIds?: string[]
): string {
  const parts = ["topo", orgId];

  if (siteIds && siteIds.length > 0) {
    parts.push(`sites:${siteIds.sort().join(",")}`);
  }

  parts.push(`devices:${includeDevices}`);
  parts.push(`zones:${includeZones}`);

  return parts.join(":");
}

/**
 * Get cached topology data
 */
export function getCachedTopology(key: string): CacheEntry | undefined {
  const cached = topologyCache.get(key);

  if (cached && process.env.DEBUG) {
    console.error(`[topology-cache] Cache HIT for key: ${key}`);
  } else if (process.env.DEBUG) {
    console.error(`[topology-cache] Cache MISS for key: ${key}`);
  }

  return cached;
}

/**
 * Store topology data in cache
 */
export function setCachedTopology(key: string, data: any): void {
  const entry: CacheEntry = {
    data,
    timestamp: new Date().toISOString(),
  };

  topologyCache.set(key, entry);

  if (process.env.DEBUG) {
    console.error(
      `[topology-cache] Cached data for key: ${key} (TTL: ${CACHE_TTL_SECONDS / 1000}s)`
    );
  }
}

/**
 * Clear all cached topology data
 */
export function clearTopologyCache(): void {
  topologyCache.clear();

  if (process.env.DEBUG) {
    console.error("[topology-cache] Cache cleared");
  }
}

/**
 * Get cache statistics
 */
export function getCacheStats() {
  return {
    size: topologyCache.size,
    maxSize: MAX_CACHE_ENTRIES,
    ttl: CACHE_TTL_SECONDS / 1000, // Convert back to seconds for display
  };
}
