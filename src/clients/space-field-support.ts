/**
 * Which optional Room/Zone fields (archive-fields.ts) the API's schema has,
 * as last seen by the schema check in archive-fallback.ts.
 *
 * Kept free of client imports so the test setup can prime it without
 * loading the real GraphQL client.
 */

import { SPACE_ARCHIVE_FIELD_NAMES } from "./queries/archive-fields.js";

/** How long a successful schema check is trusted before it is re-run (1 hour). */
export const SPACE_FIELD_RECHECK_MS = 60 * 60 * 1000;

/** How long to wait before re-running a schema check that failed (5 minutes). */
export const SPACE_FIELD_FAILURE_RECHECK_MS = 5 * 60 * 1000;

interface SupportState {
  /** The answer in use. */
  supported: ReadonlySet<string>;
  /** When to re-check; until then the answer is fresh. */
  expiresAt: number;
  /** Whether a schema check has ever succeeded (vs. the "none" fallback). */
  confirmed: boolean;
}

let state: SupportState | null = null;

/** The supported field set while it is fresh, else undefined. */
export function freshSpaceFieldSupport(now: number = Date.now()): ReadonlySet<string> | undefined {
  return state && now < state.expiresAt ? state.supported : undefined;
}

/**
 * The last answer from a SUCCESSFUL schema check, fresh or stale, or
 * undefined if no check has succeeded since start (or the last reset).
 */
export function lastConfirmedSpaceFieldSupport(): ReadonlySet<string> | undefined {
  return state?.confirmed ? state.supported : undefined;
}

/**
 * Record a schema check outcome. A successful check is trusted for an hour.
 * A failed one keeps the last confirmed answer (so one 503 on the hourly
 * re-check does not switch archive handling off) and retries in 5 minutes;
 * only with nothing confirmed yet does it fall back to "no optional fields".
 */
export function recordSpaceFieldSupport(
  outcome: { supported: Iterable<string> } | { failed: true },
  now: number = Date.now()
): ReadonlySet<string> {
  if ("failed" in outcome) {
    const kept = lastConfirmedSpaceFieldSupport();
    state = {
      supported: kept ?? new Set<string>(),
      expiresAt: now + SPACE_FIELD_FAILURE_RECHECK_MS,
      confirmed: Boolean(kept),
    };
  } else {
    state = {
      supported: new Set(outcome.supported),
      expiresAt: now + SPACE_FIELD_RECHECK_MS,
      confirmed: true,
    };
  }
  return state.supported;
}

/** Forget every answer, so the next query runs (and waits for) the schema check. */
export function resetSpaceFieldSupport(): void {
  state = null;
}

/**
 * Tests: pretend a schema check succeeded and found `supported` (all
 * optional fields by default) and never expires, so no introspection request
 * needs mocking.
 */
export function primeSpaceFieldSupport(
  supported: Iterable<string> = SPACE_ARCHIVE_FIELD_NAMES
): void {
  state = { supported: new Set(supported), expiresAt: Number.POSITIVE_INFINITY, confirmed: true };
}
