/**
 * Shared GraphQL error handling and device filtering utilities
 *
 * Eliminates repeated catch-block boilerplate and test-device filtering
 * across tool implementations.
 */

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
 * Check if a sensor is a production device (not a test/placeholder).
 * Filters out mirror/virtual sensors (mi-rr-or*) and fake test sensors (fa-ke*).
 */
export function isProductionSensor(sensor: Sensor): boolean {
  return (
    !!sensor.mac_address &&
    sensor.mac_address.trim() !== "" &&
    !sensor.mac_address.startsWith("mi-rr-or") &&
    !sensor.mac_address.startsWith("fa-ke")
  );
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
