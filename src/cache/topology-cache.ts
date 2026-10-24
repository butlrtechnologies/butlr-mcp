import { LRUCache } from "lru-cache";
import { debug } from "../utils/debug.js";
import { parseTtlSeconds } from "./ttl.js";

/**
 * Topology cache configuration
 */
const TTL_SECONDS = parseTtlSeconds("MCP_CACHE_TOPO_TTL", process.env.MCP_CACHE_TOPO_TTL, 600);
/** TTL in milliseconds; 0 disables this cache (nothing is stored). */
const CACHE_TTL_SECONDS = TTL_SECONDS * 1000; // (milliseconds, despite the name)
const CACHE_ENABLED = CACHE_TTL_SECONDS > 0;
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
  // Never handed 0 (lru-cache reads that as "never expires"); unused when disabled.
  ttl: CACHE_ENABLED ? CACHE_TTL_SECONDS : 600000,
  updateAgeOnGet: true, // Reset TTL on cache hit
  updateAgeOnHas: false,
});

/**
 * Generate cache key for topology queries.
 *
 * `devicesMerged` distinguishes entries whose floors carry merged
 * `sensors`/`hives` arrays (post-mergeSensorsAndHivesIntoTopology) from raw
 * `sites` trees. `butlr_list_topology` and `butlr_search_assets` both write
 * the merged shape under `devicesMerged: true`, so either can prime the
 * cache for the other; a device-aware reader must never take an unmerged
 * entry, which is why the flag stays in the key.
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
 * Store topology data in cache.
 *
 * INVARIANT: callers MUST only cache COMPLETE topology. A partial fetch
 * (Apollo `result.error` set, GraphQL returned errors alongside data) will
 * silently launder its partiality through the cache otherwise — every
 * subsequent cache-hit reader would treat the truncated tree as
 * authoritative without seeing `partial_topology`. `butlr-list-topology`
 * gates its `setCachedTopology` call on `!partialData`; any new caller
 * must do the same.
 */
export function setCachedTopology(key: string, data: Record<string, unknown>): void {
  if (!CACHE_ENABLED) return;
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
