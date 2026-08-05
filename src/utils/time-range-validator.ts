/**
 * Time range validation for timeseries queries
 * Prevents excessive data queries that could timeout or overwhelm the API
 */

import { parseTimeString } from "./time-resolver.js";

/**
 * Validate time range based on interval
 * @param interval Aggregation interval ('1m', '1h', '1d')
 * @param start Start time (ISO-8601 or relative like '-24h')
 * @param stop Stop time (ISO-8601 or relative like 'now')
 * @throws Error if time range exceeds limits for the given interval
 */
export function validateTimeRange(interval: string, start: string, stop: string): void {
  // Parse times - handle relative times by converting to absolute
  const startTime = parseTimeString(start);
  const stopTime = parseTimeString(stop);

  // Calculate duration in hours
  const durationMs = stopTime.getTime() - startTime.getTime();
  const durationHours = durationMs / (1000 * 60 * 60);
  const durationDays = durationHours / 24;

  // Validate based on interval
  if (interval === "1m" && durationHours > 1) {
    throw new Error(
      `Time range too large for 1m interval. Maximum: 1 hour. Requested: ${durationHours.toFixed(1)} hours.`
    );
  }

  if (interval === "1h" && durationHours > 48) {
    throw new Error(
      `Time range too large for 1h interval. Maximum: 48 hours. Requested: ${durationHours.toFixed(1)} hours.`
    );
  }

  if (interval === "1d" && durationDays > 60) {
    throw new Error(
      `Time range too large for 1d interval. Maximum: 60 days. Requested: ${durationDays.toFixed(1)} days.`
    );
  }

  // Validate start is before stop
  if (startTime >= stopTime) {
    throw new Error(`Start time must be before stop time. Start: ${start}, Stop: ${stop}`);
  }
}
