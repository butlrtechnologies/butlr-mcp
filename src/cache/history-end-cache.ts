import { LRUCache } from "lru-cache";
import { debug } from "../utils/debug.js";

/**
 * Cache for the history-end probe (src/utils/history-end.ts).
 *
 * The probe reads six months of daily buckets for one sensorless space, and
 * its answer only moves when a new day lands, so repeat lookups within a few
 * minutes (an agent re-asking about the same retired room, or a batch that
 * names it twice) reuse it. Only successful answers are cached, "no history"
 * included; failures are retried on the next call.
 *
 * TTL: 10 minutes by default. MCP_CACHE_HISTORY_END_TTL (seconds) overrides
 * it; 0 turns the cache off. A value that is not a non-negative number falls
 * back to the default with a warning (lru-cache treats a TTL of 0 or NaN as
 * "never expires", so it must not reach the cache unchecked).
 */
const DEFAULT_TTL_SECONDS = 600;
const MAX_CACHE_ENTRIES = 500;

/** Parse MCP_CACHE_HISTORY_END_TTL; exported for tests. */
export function parseHistoryEndTtlSeconds(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_TTL_SECONDS;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    console.error(
      `[history-end-cache] Ignoring invalid MCP_CACHE_HISTORY_END_TTL=${JSON.stringify(raw)}; using ${DEFAULT_TTL_SECONDS}s.`
    );
    return DEFAULT_TTL_SECONDS;
  }
  return seconds;
}

const TTL_MS = parseHistoryEndTtlSeconds(process.env.MCP_CACHE_HISTORY_END_TTL) * 1000;
const CACHE_ENABLED = TTL_MS > 0;

interface HistoryEndCacheEntry {
  endDay: string | null;
}

const historyEndCache = new LRUCache<string, HistoryEndCacheEntry>({
  max: MAX_CACHE_ENTRIES,
  // lru-cache needs a positive TTL; when caching is off nothing is stored.
  ttl: CACHE_ENABLED ? TTL_MS : DEFAULT_TTL_SECONDS * 1000,
  updateAgeOnGet: false, // the answer ages with the calendar, not with use
});

/**
 * `variant` carries whatever else the answer depends on: the timezone (local
 * day boundaries) and the declared end from sensorsRemovedAt/archivedAt.
 */
function key(assetId: string, variant: string): string {
  return `history-end:${assetId}:${variant}`;
}

export function getCachedHistoryEnd(
  assetId: string,
  variant: string
): HistoryEndCacheEntry | undefined {
  if (!CACHE_ENABLED) return undefined;
  const hit = historyEndCache.get(key(assetId, variant));
  debug("history-end-cache", `${hit ? "HIT" : "MISS"} ${assetId}`);
  return hit;
}

export function setCachedHistoryEnd(assetId: string, variant: string, endDay: string | null): void {
  if (!CACHE_ENABLED) return;
  historyEndCache.set(key(assetId, variant), { endDay });
}

/** Clear all cached history ends (tests, or after a known data change). */
export function clearHistoryEndCache(): void {
  historyEndCache.clear();
}
