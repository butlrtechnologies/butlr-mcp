/**
 * Where a retired or sensorless room's or zone's recorded history ends.
 *
 * Mirrors the dashboard's `historyEndDay` / `useSensorlessHistory`
 * (butlr-dashboard src/hooks/data/useSensorlessHistory.ts) so the two
 * products give the same date for the same space. Precedence (contract
 * Addendum 2, D2):
 *
 *   (a) the day before the local date of `sensorsRemovedAt`, when set;
 *   (b) else the day before the local date of `archivedAt`, when archived
 *       (archiving requires 0 sensors, so recording had stopped by then, and
 *       this beats trusting the 0-valued rows a parked space keeps getting);
 *   (c) else derived from the data (see `historyEndDay`).
 *
 * The reporting probe still runs for (a)/(b): it answers whether the space
 * has any history at all in the lookback window, and its `stop` is cut off
 * at the end of the declared last day.
 */

import { queryReporting, type ReportingRequest } from "../clients/reporting-client.js";
import { formatLocalDate, getLocalMidnight } from "./timezone-helpers.js";

/**
 * How far back the probe looks. Reporting routes each request to ONE storage
 * tier by its start (hot <= 3 months, warm <= 6 months, cold = slow Trino);
 * see `historyProbeStart` for how the probe stays on the warm tier.
 */
export const HISTORY_LOOKBACK_MONTHS = 6;

/**
 * Extra days inside the 6-month cutoff. Tiered reporting widens a `1d`
 * window's start by 24h BEFORE picking a tier, and compares it with
 * `truncateToDay(now.AddDate(0, -6, 0))` in UTC (the start is sent with a
 * `Z`). Go's AddDate rolls month overflow over (Aug 31 - 6 months = Mar 3),
 * and a site's local date can be a day ahead of UTC. Three days covers all
 * of that (contract Addendum 2, D1; tested against a port of the router).
 */
export const HISTORY_PROBE_MARGIN_DAYS = 3;

/** Previous calendar date of a YYYY-MM-DD string. */
function dayBefore(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** Next calendar date of a YYYY-MM-DD string. */
function dayAfter(ymd: string): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** First instant of local day `ymd` in `timezone`. */
function localDayStart(ymd: string, timezone: string): Date {
  // Pick an instant inside the local day, then take its start. No single UTC
  // hour lands on the same local date across UTC-12..UTC+14, so start at
  // noon UTC and step half a day toward the target if needed.
  let probe = new Date(`${ymd}T12:00:00Z`);
  const got = formatLocalDate(probe, timezone);
  if (got > ymd) probe = new Date(probe.getTime() - 12 * 3600 * 1000);
  else if (got < ymd) probe = new Date(probe.getTime() + 12 * 3600 * 1000);
  return getLocalMidnight(probe, timezone);
}

/**
 * Declared end of history, (a) then (b) above: the day before the local
 * date of `sensorsRemovedAt`, else of `archivedAt`. Undefined when neither
 * is set (or parses).
 */
export function declaredHistoryEnd(
  space: { sensorsRemovedAt?: string | null; archivedAt?: string | null },
  timezone: string
): string | undefined {
  for (const at of [space.sensorsRemovedAt, space.archivedAt]) {
    if (!at) continue;
    const ms = Date.parse(at);
    if (Number.isNaN(ms)) continue;
    return dayBefore(formatLocalDate(ms, timezone));
  }
  return undefined;
}

/**
 * Data-derived end of history, (c) above: the last full local day
 * (YYYY-MM-DD in `timezone`) of a space's recorded history, or null when it
 * has none.
 *
 * Every day with a non-null value counts, zeros included: an empty day is
 * still history. Reporting returns only CLOSED daily buckets, so today's
 * partial day never appears:
 * - newest recorded day is yesterday (or later) -> still recording, end = yesterday;
 * - otherwise the newest day is the partial day the sensors moved, so the
 *   end is the recorded day before it, or the only day when there is one.
 *
 * Daily buckets are labelled with their END time (the row for Oct 20 carries
 * Oct 21 00:00 local), so each label is stepped back 1 ms before its day is
 * read.
 */
export function historyEndDay(
  points: ReadonlyArray<{ time?: string; value?: number | null }>,
  timezone: string,
  now: Date = new Date()
): string | null {
  const days = new Set<string>();
  for (const p of points) {
    if (p?.value == null || !p.time) continue;
    const ts = Date.parse(p.time);
    if (Number.isNaN(ts)) continue;
    days.add(formatLocalDate(ts - 1, timezone));
  }
  // YYYY-MM-DD sorts chronologically as a string.
  const sorted = Array.from(days).sort();
  if (sorted.length === 0) return null;
  const yesterday = dayBefore(formatLocalDate(now, timezone));
  const newest = sorted[sorted.length - 1];
  if (newest >= yesterday) return yesterday;
  return sorted.length > 1 ? sorted[sorted.length - 2] : sorted[0];
}

/**
 * Start of the probe window: local midnight of the calendar day
 * HISTORY_LOOKBACK_MONTHS before today plus HISTORY_PROBE_MARGIN_DAYS, with
 * ROLLOVER month arithmetic like Go's AddDate (Aug 31 - 6 months = Mar 3,
 * then + 3 days = Mar 6) - contract Addendum 2, D1.
 *
 * "Today" is taken both in the site timezone (D1) and in UTC, and the later
 * of the two days wins. The router's cutoff is computed from the UTC date,
 * and at a month end the two disagree by more than the day of offset: at
 * 00:30 Sep 1 in Tokyo (Aug 31 UTC), the local rule gives Mar 4 but the
 * cutoff is Mar 3 (from "Feb 31"), so a start widened by 24h lands on the
 * cold tier. Taking the later day keeps every timezone on the warm tier
 * (tested against a port of the router).
 */
export function historyProbeStart(now: Date, timezone: string): Date {
  const sixMonthsBackPlusMargin = (ymd: string) => {
    const [y, m, d] = ymd.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1 - HISTORY_LOOKBACK_MONTHS, d + HISTORY_PROBE_MARGIN_DAYS))
      .toISOString()
      .slice(0, 10);
  };
  const fromLocal = sixMonthsBackPlusMargin(formatLocalDate(now, timezone));
  const fromUtc = sixMonthsBackPlusMargin(now.toISOString().slice(0, 10));
  return localDayStart(fromLocal > fromUtc ? fromLocal : fromUtc, timezone);
}

/**
 * Build the one reporting query the probe sends: daily max of the space's
 * occupancy over the lookback window, zeros included, raw rows. `stop`
 * defaults to now; pass the end of a declared last day to cut it off there.
 */
export function buildHistoryProbeRequest(
  assetType: "room" | "zone",
  assetId: string,
  timezone: string,
  now: Date = new Date(),
  stop: Date = now
): ReportingRequest {
  return {
    group_by: { raw: true },
    window: { every: "1d", function: "max", timezone },
    filter: {
      measurements: [assetType === "zone" ? "zone_occupancy" : "room_occupancy"],
      start: historyProbeStart(now, timezone).toISOString(),
      // The ETL-backed API returns nothing when stop is omitted.
      stop: stop.toISOString(),
      ...(assetType === "zone" ? { zones: { eq: [assetId] } } : { rooms: { eq: [assetId] } }),
      value: { gte: 0 },
    },
    options: { format: "json", timestamp: "RFC3339" },
  };
}

/**
 * Last full day of a space's recorded history within the lookback window,
 * or null when the window holds none. `declaredEnd` is the (a)/(b) end from
 * `declaredHistoryEnd`; when given, it is the answer as long as the window
 * holds any history up to it, and the query stops at the end of that day.
 * Errors propagate; the caller decides which ones are fatal.
 */
export async function fetchHistoryEnd(
  assetType: "room" | "zone",
  assetId: string,
  timezone: string,
  declaredEnd?: string,
  now: Date = new Date()
): Promise<string | null> {
  const start = historyProbeStart(now, timezone);
  let stop = now;
  if (declaredEnd) {
    const endOfDeclared = localDayStart(dayAfter(declaredEnd), timezone);
    // The declared end is older than the window: nothing to find in it.
    if (endOfDeclared.getTime() <= start.getTime()) return null;
    if (endOfDeclared.getTime() < now.getTime()) stop = endOfDeclared;
  }
  const response = await queryReporting(
    buildHistoryProbeRequest(assetType, assetId, timezone, now, stop)
  );
  // An empty grouped response can come back as `{}` rather than `[]`.
  const data = Array.isArray(response?.data) ? response.data : [];
  if (declaredEnd) {
    return data.some((p) => p?.value != null) ? declaredEnd : null;
  }
  return historyEndDay(data, timezone, now);
}
