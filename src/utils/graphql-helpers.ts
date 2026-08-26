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
 * Check if a sensor is a KNOWN test device: a mirror/virtual sensor
 * (mi-rr-or*) or a fake test sensor (fa-ke*).
 *
 * Use this when refusing a caller's explicit request for one named sensor.
 * Refusing costs the caller their query, so it needs positive evidence, and
 * the MAC prefixes are the only positive evidence available. A blank or
 * missing `mac_address` is unknown provenance, not proof: a provisioned but
 * not yet MAC bound sensor is a real device with real reporting rows, and
 * sensors are addressed by `id` everywhere, so a blank MAC never makes a row
 * unqueryable.
 *
 * `isProductionSensor` below is the stricter counterpart for FILTERING
 * aggregate lists, where the trade runs the other way.
 */
export function isKnownTestSensor(sensor: Sensor): boolean {
  const mac = sensor.mac_address?.trim() ?? "";
  return mac.startsWith("mi-rr-or") || mac.startsWith("fa-ke");
}

/**
 * Check if a sensor is a production device (not a test/placeholder).
 * Filters out mirror/virtual sensors (mi-rr-or*), fake test sensors (fa-ke*),
 * and MAC-less placeholder rows.
 *
 * Stricter than `isKnownTestSensor` on purpose. This is the filter for
 * aggregate views (topology listings, hardware health, occupancy sensor
 * counts), where a MAC-less placeholder row inflates every headline number it
 * lands in, and `butlr_hardware_snapshot` reports those rows under
 * `test_devices_excluded.sensors.placeholder`. Excluding an unknown row from a
 * total is cheap; refusing a caller's explicit query for it is not, which is
 * why the single-sensor path uses `isKnownTestSensor` instead.
 */
export function isProductionSensor(sensor: Sensor): boolean {
  return !!sensor.mac_address && sensor.mac_address.trim() !== "" && !isKnownTestSensor(sensor);
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
