/**
 * Which optional Room/Zone fields (archive-fields.ts) the API's schema has,
 * as last seen by the schema check in archive-fallback.ts.
 *
 * Kept free of client imports so the test setup can prime it without
 * loading the real GraphQL client.
 */

import { SPACE_ARCHIVE_FIELD_NAMES } from "./queries/archive-fields.js";

/** How long a successful schema check is trusted before it is re-run. */
export const SPACE_FIELD_RECHECK_MS = 60 * 60 * 1000;

/** How long a FAILED schema check (fields assumed absent) is trusted. */
export const SPACE_FIELD_FAILURE_RECHECK_MS = 5 * 60 * 1000;

let state: { supported: ReadonlySet<string>; expiresAt: number } | null = null;

/** The cached set of supported optional fields, or undefined when unknown/expired. */
export function cachedSpaceFieldSupport(now: number = Date.now()): ReadonlySet<string> | undefined {
  return state && now < state.expiresAt ? state.supported : undefined;
}

/** Record a schema check result for `ttlMs`. */
export function recordSpaceFieldSupport(
  supported: Iterable<string>,
  ttlMs: number,
  now: number = Date.now()
): ReadonlySet<string> {
  const set = new Set(supported);
  state = { supported: set, expiresAt: now + ttlMs };
  return set;
}

/** Forget the cached result, so the next query runs the schema check. */
export function resetSpaceFieldSupport(): void {
  state = null;
}

/**
 * Tests: pretend the schema check already ran and found `supported` (all
 * optional fields by default), so no introspection request is mocked.
 */
export function primeSpaceFieldSupport(
  supported: Iterable<string> = SPACE_ARCHIVE_FIELD_NAMES
): void {
  recordSpaceFieldSupport(supported, Number.POSITIVE_INFINITY);
}
