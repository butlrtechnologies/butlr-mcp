/**
 * Time string parsing shared by request builders and validators.
 *
 * The v3 reporting API (ETL backend since the Aug 2026 cutover) accepts only
 * RFC3339 timestamps: relative forms like "-20m" are rejected with a 400, and
 * omitting filter.stop returns an empty result set. All times must be
 * resolved to absolute timestamps client-side before sending.
 */

/**
 * Parse a time string ("now", relative like "-24h", or ISO-8601) to a Date.
 * @throws Error if the string is not a recognized time format
 */
export function parseTimeString(timeStr: string): Date {
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

  const parsed = new Date(timeStr);
  if (isNaN(parsed.getTime())) {
    throw new Error(
      `Invalid time format: ${timeStr}. Use ISO-8601 or relative format like '-24h'.`
    );
  }

  return parsed;
}

/**
 * Resolve a time string to an absolute ISO-8601 timestamp string.
 */
export function resolveTimeToIso(timeStr: string): string {
  return parseTimeString(timeStr).toISOString();
}
