/**
 * Time range validation for timeseries queries
 * Prevents excessive data queries that could timeout or overwhelm the API
 */

/**
 * Validate time range based on interval
 * @param interval Aggregation interval ('1m', '1h', '1d')
 * @param start Start time (ISO-8601 or relative like '-24h')
 * @param stop Stop time (ISO-8601 or relative like 'now')
 * @throws Error if time range exceeds limits for the given interval
 */
export function validateTimeRange(interval: string, start: string, stop: string): void {
  // Parse times - handle relative times by converting to absolute
  const startTime = parseTime(start);
  const stopTime = parseTime(stop);

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

/**
 * Parse time string (ISO-8601 or relative) to Date
 */
function parseTime(timeStr: string): Date {
  // Handle relative times like '-24h', '-1d', 'now'
  if (timeStr === "now") {
    return new Date();
  }

  // Relative time pattern: -<number><unit>
  const relativeMatch = timeStr.match(/^-(\d+)(m|h|d)$/);
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2];
    const now = new Date();

    switch (unit) {
      case "m":
        return new Date(now.getTime() - amount * 60 * 1000);
      case "h":
        return new Date(now.getTime() - amount * 60 * 60 * 1000);
      case "d":
        return new Date(now.getTime() - amount * 24 * 60 * 60 * 1000);
    }
  }

  // Try parsing as ISO-8601
  const parsed = new Date(timeStr);
  if (isNaN(parsed.getTime())) {
    throw new Error(
      `Invalid time format: ${timeStr}. Use ISO-8601 or relative format like '-24h'.`
    );
  }

  return parsed;
}
