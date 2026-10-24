/**
 * Where a retired or sensorless room's or zone's recorded history ends.
 *
 * The rule is shared with the dashboard (`useSensorlessHistory`); both
 * suites run the conformance fixtures in
 * src/__fixtures__/history-end-conformance.json. In short (contract
 * Addendum 3, E2/E3):
 *
 * - Data-derived end: reporting returns today's partial daily bucket when
 *   a space has rows today, and the day its sensors left is partial too, so
 *   the newest returned day is always partial. The end is the recorded day
 *   before the newest, or the only day when there is one.
 * - Declared end: the day before the local date of `sensorsRemovedAt`, else
 *   of `archivedAt`.
 * - With a declared end, the answer is min(declared, data-derived end): the
 *   data can stop long before an archive, and a parked space can keep
 *   getting 0-valued rows after it. With no row on or before the declared
 *   day, there is no history. A declared end older than the lookup window is
 *   returned as is, flagged `outsideWindow`, without a query.
 */

import { queryReporting, type ReportingRequest } from "../clients/reporting-client.js";
import { formatLocalDate, localDayStart, shiftDay } from "./timezone-helpers.js";

/**
 * How far back the probe looks, in days (contract Addendum 3, E1).
 *
 * Reporting routes each request to ONE storage tier by its start, and the
 * cold tier is slow Trino. Tiered reporting widens a `1d` window's start by
 * 24h, then compares it with `truncateToDay(now.AddDate(0, -6, 0))` in UTC,
 * which is 181 to 184 days back. Starting at local midnight 177 days back
 * leaves at least 46h of slack (the minimum, in zones such as
 * Antarctica/Troll with any positive skew), so no timezone, month end or few
 * seconds of clock skew between this server and the API's reaches the cold tier
 * (tested against a port of the router with a separate server clock).
 */
export const HISTORY_LOOKBACK_DAYS = 177;

/** Start of the probe window: local midnight of today minus HISTORY_LOOKBACK_DAYS. */
export function historyProbeStart(now: Date, timezone: string): Date {
  return localDayStart(shiftDay(formatLocalDate(now, timezone), -HISTORY_LOOKBACK_DAYS), timezone);
}

/**
 * Declared end of history: the day before the local date of
 * `sensorsRemovedAt`, else of `archivedAt`. Undefined when neither is set
 * (or parses).
 */
export function declaredHistoryEnd(
  space: { sensorsRemovedAt?: string | null; archivedAt?: string | null },
  timezone: string
): string | undefined {
  for (const at of [space.sensorsRemovedAt, space.archivedAt]) {
    if (!at) continue;
    const ms = Date.parse(at);
    if (Number.isNaN(ms)) continue;
    return shiftDay(formatLocalDate(ms, timezone), -1);
  }
  return undefined;
}

type ReportingRow = { time?: string; value?: number | null };

/**
 * Local days (YYYY-MM-DD, ascending) that have a non-null value. Zero days
 * count: an empty day is still history. Daily buckets are labelled with
 * their END time (the row for Oct 20 carries Oct 21 00:00 local; today's
 * partial bucket carries the query's stop), so each label is stepped back
 * 1 ms before its day is read.
 */
function recordedDays(points: ReadonlyArray<ReportingRow>, timezone: string): string[] {
  const days = new Set<string>();
  for (const p of points) {
    if (p?.value == null || !p.time) continue;
    const ts = Date.parse(p.time);
    if (Number.isNaN(ts)) continue;
    days.add(formatLocalDate(ts - 1, timezone));
  }
  // YYYY-MM-DD sorts chronologically as a string.
  return Array.from(days).sort();
}

/**
 * Data-derived end of history: the recorded day before the newest (the
 * newest is always partial), or the only day; null when there is none.
 */
export function historyEndDay(
  points: ReadonlyArray<ReportingRow>,
  timezone: string
): string | null {
  const days = recordedDays(points, timezone);
  if (days.length === 0) return null;
  return days.length > 1 ? days[days.length - 2] : days[0];
}

export interface HistoryEnd {
  /** Last full local day of recorded history, or null when there is none. */
  endDay: string | null;
  /** First local day of the lookup window (YYYY-MM-DD). */
  windowStart: string;
  /** The declared end is older than the window, so it was not checked against data. */
  outsideWindow?: boolean;
}

/**
 * Combine the declared end (if any) with the rows of the lookup window.
 * Pure; `fetchHistoryEnd` supplies the rows. The conformance fixtures run
 * against this.
 */
export function resolveHistoryEnd(
  points: ReadonlyArray<ReportingRow>,
  declaredEnd: string | undefined,
  timezone: string,
  windowStart: string
): HistoryEnd {
  if (declaredEnd && declaredEnd < windowStart) {
    return { endDay: declaredEnd, windowStart, outsideWindow: true };
  }
  const dataEnd = historyEndDay(points, timezone);
  if (!declaredEnd || dataEnd === null) return { endDay: dataEnd, windowStart };
  const days = recordedDays(points, timezone);
  if (!days.some((day) => day <= declaredEnd)) return { endDay: null, windowStart };
  return { endDay: dataEnd < declaredEnd ? dataEnd : declaredEnd, windowStart };
}

/**
 * The one reporting query the probe sends: daily max of the space's
 * occupancy over [start, stop], zeros included, raw rows.
 */
export function buildHistoryProbeRequest(
  assetType: "room" | "zone",
  assetId: string,
  timezone: string,
  start: Date,
  stop: Date
): ReportingRequest {
  return {
    group_by: { raw: true },
    window: { every: "1d", function: "max", timezone },
    filter: {
      measurements: [assetType === "zone" ? "zone_occupancy" : "room_occupancy"],
      start: start.toISOString(),
      // Sent explicitly, like every reporting query here (see
      // ReportingRequestBuilder.timeRange).
      stop: stop.toISOString(),
      ...(assetType === "zone" ? { zones: { eq: [assetId] } } : { rooms: { eq: [assetId] } }),
      value: { gte: 0 },
    },
    options: { format: "json", timestamp: "RFC3339" },
  };
}

/**
 * Where a space's recorded history ends (see the module comment). Sends one
 * reporting query over the lookup window, unless the declared end is older
 * than the window. Errors propagate; the caller decides which are fatal.
 */
export async function fetchHistoryEnd(
  assetType: "room" | "zone",
  assetId: string,
  timezone: string,
  declaredEnd?: string,
  now: Date = new Date()
): Promise<HistoryEnd> {
  const start = historyProbeStart(now, timezone);
  const windowStart = formatLocalDate(start, timezone);
  if (declaredEnd && declaredEnd < windowStart) {
    return { endDay: declaredEnd, windowStart, outsideWindow: true };
  }
  const response = await queryReporting(
    buildHistoryProbeRequest(assetType, assetId, timezone, start, now)
  );
  // An empty grouped response can come back as `{}` rather than `[]`.
  const data = Array.isArray(response?.data) ? response.data : [];
  return resolveHistoryEnd(data, declaredEnd, timezone, windowStart);
}
