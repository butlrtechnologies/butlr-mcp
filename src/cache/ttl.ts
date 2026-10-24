/**
 * Parse a cache TTL environment variable given in whole seconds.
 *
 * lru-cache needs a positive integer TTL in milliseconds: it throws at
 * import for a fraction or a negative value, and treats 0 or NaN as "never
 * expires". So anything that is not a whole number of seconds >= 0 falls
 * back to the default with a warning on stderr, and 0 means "do not cache"
 * (callers then skip storing entries).
 */
export function parseTtlSeconds(
  name: string,
  raw: string | undefined,
  defaultSeconds: number
): number {
  if (raw === undefined || raw.trim() === "") return defaultSeconds;
  const seconds = Number(raw);
  if (!Number.isSafeInteger(seconds) || seconds < 0) {
    console.error(
      `[cache] Ignoring invalid ${name}=${JSON.stringify(raw)} (expected whole seconds >= 0); using ${defaultSeconds}s.`
    );
    return defaultSeconds;
  }
  return seconds;
}
