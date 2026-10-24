import { LRUCache } from "lru-cache";
import { debug } from "../utils/debug.js";
import type { HistoryEnd } from "../utils/history-end.js";
import { parseTtlSeconds } from "./ttl.js";

/**
 * Cache for the history-end probe (src/utils/history-end.ts).
 *
 * The probe reads 177 days of daily buckets for one space, and its
 * answer only moves when a new day lands, so a repeat lookup within a few
 * minutes (an agent re-asking about the same retired room) reuses it. Only
 * successful answers are cached, "no history" included; failures are
 * retried on the next call.
 *
 * TTL: 10 minutes by default. MCP_CACHE_HISTORY_END_TTL (whole seconds)
 * overrides it; 0 turns the cache off. Anything else (a fraction, a negative
 * or non-numeric value) falls back to the default with a warning: lru-cache
 * requires a positive integer TTL in milliseconds and throws at import
 * otherwise, and treats 0 as "never expires".
 */
const DEFAULT_TTL_SECONDS = 600;
const MAX_CACHE_ENTRIES = 500;

const TTL_MS =
  parseTtlSeconds(
    "MCP_CACHE_HISTORY_END_TTL",
    process.env.MCP_CACHE_HISTORY_END_TTL,
    DEFAULT_TTL_SECONDS
  ) * 1000;
const CACHE_ENABLED = TTL_MS > 0;

const historyEndCache = new LRUCache<string, HistoryEnd>({
  max: MAX_CACHE_ENTRIES,
  // Never handed a 0 TTL (lru-cache reads that as "never expires"); when
  // caching is off nothing is stored, so this value is unused then.
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

export function getCachedHistoryEnd(assetId: string, variant: string): HistoryEnd | undefined {
  if (!CACHE_ENABLED) return undefined;
  const hit = historyEndCache.get(key(assetId, variant));
  debug("history-end-cache", `${hit ? "HIT" : "MISS"} ${assetId}`);
  return hit;
}

export function setCachedHistoryEnd(assetId: string, variant: string, end: HistoryEnd): void {
  if (!CACHE_ENABLED) return;
  historyEndCache.set(key(assetId, variant), end);
}

/** Clear all cached history ends (tests, or after a known data change). */
export function clearHistoryEndCache(): void {
  historyEndCache.clear();
}
