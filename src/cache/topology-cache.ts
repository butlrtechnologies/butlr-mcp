import { LRUCache } from "lru-cache";
import { debug } from "../utils/debug.js";

/**
 * Topology cache configuration
 */
const CACHE_TTL_SECONDS = parseInt(process.env.MCP_CACHE_TOPO_TTL || "600", 10) * 1000; // Convert to milliseconds
const MAX_CACHE_ENTRIES = 100;

interface CacheEntry {
  data: Record<string, unknown>;
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
 * Generate cache key for topology queries.
 *
 * `devicesMerged` is part of the key because two consumers prime this cache
 * with different shapes: `butlr_list_topology` runs sensors/hives through
 * `mergeSensorsAndHivesIntoTopology` (so every floor carries `sensors` and
 * `hives` arrays); `butlr_search_assets` writes the raw `sites` tree
 * unmodified. A device-aware reader cannot trust an unmerged entry, so the
 * two shapes must live under separate keys.
 */
export function generateTopologyCacheKey(
  orgId: string,
  includeDevices: boolean,
  includeZones: boolean,
  devicesMerged: boolean,
  siteIds?: string[]
): string {
  const parts = ["topo", orgId];

  if (siteIds && siteIds.length > 0) {
    parts.push(`sites:${siteIds.sort().join(",")}`);
  }

  parts.push(`devices:${includeDevices}`);
  parts.push(`zones:${includeZones}`);
  parts.push(`merged:${devicesMerged}`);

  return parts.join(":");
}

/**
 * Get cached topology data
 */
export function getCachedTopology(key: string): CacheEntry | undefined {
  const cached = topologyCache.get(key);

  if (cached) {
    debug("topology-cache", `Cache HIT for key: ${key}`);
  } else {
    debug("topology-cache", `Cache MISS for key: ${key}`);
  }

  return cached;
}

/**
 * Store topology data in cache
 */
export function setCachedTopology(key: string, data: Record<string, unknown>): void {
  const entry: CacheEntry = {
    data,
    timestamp: new Date().toISOString(),
  };

  topologyCache.set(key, entry);

  debug("topology-cache", `Cached data for key: ${key} (TTL: ${CACHE_TTL_SECONDS / 1000}s)`);
}

/**
 * Clear all cached topology data
 */
export function clearTopologyCache(): void {
  topologyCache.clear();

  debug("topology-cache", "Cache cleared");
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
