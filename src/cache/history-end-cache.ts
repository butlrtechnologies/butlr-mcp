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
 * TTL: 10 minutes (MCP_CACHE_HISTORY_END_TTL, seconds).
 */
const CACHE_TTL_MS = parseInt(process.env.MCP_CACHE_HISTORY_END_TTL || "600", 10) * 1000;
const MAX_CACHE_ENTRIES = 500;

interface HistoryEndCacheEntry {
  endDay: string | null;
}

const historyEndCache = new LRUCache<string, HistoryEndCacheEntry>({
  max: MAX_CACHE_ENTRIES,
  ttl: CACHE_TTL_MS,
  updateAgeOnGet: false, // the answer ages with the calendar, not with use
});

/** Key on the timezone too: the local day boundaries depend on it. */
function key(assetId: string, timezone: string): string {
  return `history-end:${assetId}:${timezone}`;
}

export function getCachedHistoryEnd(
  assetId: string,
  timezone: string
): HistoryEndCacheEntry | undefined {
  const hit = historyEndCache.get(key(assetId, timezone));
  debug("history-end-cache", `${hit ? "HIT" : "MISS"} ${assetId}`);
  return hit;
}

export function setCachedHistoryEnd(
  assetId: string,
  timezone: string,
  endDay: string | null
): void {
  historyEndCache.set(key(assetId, timezone), { endDay });
}

/** Clear all cached history ends (tests, or after a known data change). */
export function clearHistoryEndCache(): void {
  historyEndCache.clear();
}
