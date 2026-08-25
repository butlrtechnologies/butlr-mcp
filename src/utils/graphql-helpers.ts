/**
 * Shared GraphQL error handling and device filtering utilities
 *
 * Eliminates repeated catch-block boilerplate and test-device filtering
 * across tool implementations.
 */

import { CombinedGraphQLErrors } from "@apollo/client/errors";
import type { Sensor, Hive } from "../clients/types.js";
import { translateGraphQLError, formatMCPError } from "../errors/mcp-errors.js";

/**
 * Re-throw as a formatted MCP error if the error is a GraphQL/network error.
 * No-ops for non-GraphQL errors, allowing the caller to re-throw the original.
 *
 * Usage:
 *   catch (error: unknown) {
 *     rethrowIfGraphQLError(error);
 *     throw error;
 *   }
 */
export function rethrowIfGraphQLError(error: unknown): void {
  if (error && typeof error === "object" && ("graphQLErrors" in error || "networkError" in error)) {
    const mcpError = translateGraphQLError(error as Parameters<typeof translateGraphQLError>[0]);
    throw new Error(formatMCPError(mcpError));
  }
}

/**
 * Apollo's global `errorPolicy: "all"` resolves rather than rejects on GraphQL
 * errors, returning `{ data: <partial>, error: CombinedGraphQLErrors }`.
 * Without an explicit check, code paths like `result.data?.tags ?? []` silently
 * coerce a backend failure into "the org has zero rows" — a high-impact silent
 * failure for filter/discovery tools.
 *
 * Call this immediately after `apolloClient.query(...)` to translate any
 * GraphQL/network errors into the standard MCP error format.
 */
export function throwIfGraphQLErrors(result: { error?: unknown }): void {
  if (!result.error) return;

  if (CombinedGraphQLErrors.is(result.error)) {
    rethrowIfGraphQLError({
      graphQLErrors: result.error.errors.map((e) => ({
        message: e.message,
        extensions: e.extensions,
      })),
    });
  }

  // Surface other ErrorLike shapes (e.g. ServerError) for the outer catch.
  throw result.error;
}

/**
 * Check if a sensor is a production device (not a test/placeholder).
 * Filters out mirror/virtual sensors (mi-rr-or*) and fake test sensors (fa-ke*).
 *
 * A blank or missing `mac_address` deliberately does NOT disqualify a sensor.
 * Test devices in this org are identified by their MAC *prefix*, so an absent
 * MAC is unknown provenance, not evidence of a test device: a provisioned but
 * not yet MAC bound sensor, or a row whose resolver returned null, is a real
 * device with real reporting rows. Sensors are addressed by `id` everywhere in
 * this codebase, so a blank MAC never makes a row unqueryable either. This is
 * the asymmetry with `isProductionHive` below, where the serial number IS the
 * addressing key.
 *
 * Callers use this both to filter aggregate lists and to reject a single
 * explicitly requested sensor (butlr_traffic_flow), and rejecting a caller's
 * own request needs positive evidence, which only the prefixes provide.
 */
export function isProductionSensor(sensor: Sensor): boolean {
  const mac = sensor.mac_address?.trim() ?? "";
  return !mac.startsWith("mi-rr-or") && !mac.startsWith("fa-ke");
}

/**
 * Check if a hive is a production device (not a test/placeholder).
 * Filters out hives with fake serial numbers.
 */
export function isProductionHive(hive: Hive): boolean {
  return (
    !!hive.serialNumber &&
    hive.serialNumber.trim() !== "" &&
    !hive.serialNumber.toLowerCase().startsWith("fake")
  );
}
