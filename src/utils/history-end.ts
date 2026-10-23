/**
 * Where a sensorless room's or zone's recorded history ends.
 *
 * Mirrors the dashboard's `historyEndDay` / `useSensorlessHistory`
 * (butlr-dashboard src/hooks/data/useSensorlessHistory.ts) so the two
 * products give the same date for the same space.
 *
 * Reporting keeps room/zone occupancy under the space's own ID, whatever
 * sensors are assigned today. Recording stops when the sensors are moved
 * away, and that final recorded day is partial (the re-layout day), so the
 * history ends on the last full day before it. An archive can happen days
 * after the sensors moved, so the archive date is NOT the end of history.
 */

import { queryReporting, type ReportingRequest } from "../clients/reporting-client.js";
import { formatLocalDate, getLocalMidnight } from "./timezone-helpers.js";

/**
 * How far back the probe looks. Reporting routes a request to one storage
 * tier by its start date (hot <= 3 months, warm <= 6 months, cold beyond);
 * starting a day inside 6 months keeps the probe on the warm tier and off
 * the slow cold (Trino) tier.
 */
export const HISTORY_LOOKBACK_MONTHS = 6;

/**
 * The last full local day (YYYY-MM-DD in `timezone`) of a space's recorded
 * history, or null when it has none.
 *
 * Every day with a non-null value counts, zeros included: an empty day is
 * still history. The newest recorded day is the partial re-layout day, so
 * the answer is the second-newest day, or the only day when there is one.
 *
 * Daily buckets are labelled with their END time (the row for Oct 20 carries
 * Oct 21 00:00 local), so each label is stepped back 1 ms before its day is
 * read.
 */
export function historyEndDay(
  points: ReadonlyArray<{ time?: string; value?: number | null }>,
  timezone: string
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
  return sorted.length > 1 ? sorted[sorted.length - 2] : sorted[0];
}

/**
 * Start of the probe window: HISTORY_LOOKBACK_MONTHS before today, plus one
 * day, at local midnight in `timezone` (dayjs semantics: a month step clamps
 * to the last day of a shorter month).
 */
export function historyProbeStart(now: Date, timezone: string): Date {
  const [y, m, d] = formatLocalDate(now.getTime(), timezone).split("-").map(Number);
  const monthIndex = m - 1 - HISTORY_LOOKBACK_MONTHS;
  const lastDay = new Date(Date.UTC(y, monthIndex + 1, 0)).getUTCDate();
  const target = new Date(Date.UTC(y, monthIndex, Math.min(d, lastDay) + 1));
  const want = target.toISOString().slice(0, 10);

  // Pick an instant whose local date is `want`, then take its local midnight.
  // No single UTC hour lands on the same local date across UTC-12..UTC+14,
  // so start at noon UTC and step half a day toward the target if needed.
  let probe = new Date(`${want}T12:00:00Z`);
  const got = formatLocalDate(probe.getTime(), timezone);
  if (got > want) probe = new Date(probe.getTime() - 12 * 3600 * 1000);
  else if (got < want) probe = new Date(probe.getTime() + 12 * 3600 * 1000);
  return getLocalMidnight(probe, timezone);
}

/**
 * Build the one reporting query the probe sends: daily max of the space's
 * occupancy over the lookback window, zeros included, raw rows.
 */
export function buildHistoryProbeRequest(
  assetType: "room" | "zone",
  assetId: string,
  timezone: string,
  now: Date = new Date()
): ReportingRequest {
  return {
    group_by: { raw: true },
    window: { every: "1d", function: "max", timezone },
    filter: {
      measurements: [assetType === "zone" ? "zone_occupancy" : "room_occupancy"],
      start: historyProbeStart(now, timezone).toISOString(),
      // The ETL-backed API returns nothing when stop is omitted.
      stop: now.toISOString(),
      ...(assetType === "zone" ? { zones: { eq: [assetId] } } : { rooms: { eq: [assetId] } }),
      value: { gte: 0 },
    },
    options: { format: "json", timestamp: "RFC3339" },
  };
}

/**
 * Query reporting for a sensorless room or zone and return the last full day
 * of its recorded history (see historyEndDay), or null when it has none.
 * Errors propagate; the caller decides which ones are fatal.
 */
export async function fetchHistoryEndDay(
  assetType: "room" | "zone",
  assetId: string,
  timezone: string,
  now: Date = new Date()
): Promise<string | null> {
  const response = await queryReporting(
    buildHistoryProbeRequest(assetType, assetId, timezone, now)
  );
  // An empty grouped response can come back as `{}` rather than `[]`.
  const data = Array.isArray(response?.data) ? response.data : [];
  return historyEndDay(data, timezone);
}
