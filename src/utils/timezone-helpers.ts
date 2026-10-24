/**
 * Timezone utilities for converting between UTC and site-specific timezones
 * All Butlr timestamps are UTC; timezones are stored at Site level
 */

import type { Site, Building, Floor } from "../clients/types.js";
import { debug } from "./debug.js";

export interface ResolvedTimezone {
  timezone: string;
  isFallback: boolean;
}

const UTC_FALLBACK = "UTC";

export function resolveTimezone(siteTimezone: string | null | undefined): ResolvedTimezone {
  if (siteTimezone) {
    return { timezone: siteTimezone, isFallback: false };
  }
  const fallback = process.env.BUTLR_TIMEZONE || UTC_FALLBACK;
  debug("timezone-helpers", `Site timezone is null/missing, falling back to ${fallback}`);
  return { timezone: fallback, isFallback: true };
}

/**
 * Get the site timezone for any asset (floor, room, zone).
 * Always uses the parent site's timezone — never the floor's.
 * Falls back to BUTLR_TIMEZONE env var or UTC if the site timezone is null.
 */
export function getTimezoneForAsset(
  assetId: string,
  assetType: "floor" | "room" | "zone",
  floors: Floor[],
  buildings: Building[],
  sites: Site[]
): ResolvedTimezone {
  if (assetType === "floor") {
    const floor = floors.find((f) => f.id === assetId);
    if (!floor) return resolveTimezone(null);

    const building = buildings.find((b) => b.id === floor.building_id);
    if (!building) return resolveTimezone(null);

    const site = sites.find((s) => s.id === building.site_id);
    return resolveTimezone(site?.timezone);
  }

  if (assetType === "room") {
    const floor = floors.find((f) => f.rooms?.some((r) => r.id === assetId));
    if (!floor) return resolveTimezone(null);

    const building = buildings.find((b) => b.id === floor.building_id);
    if (!building) return resolveTimezone(null);

    const site = sites.find((s) => s.id === building.site_id);
    return resolveTimezone(site?.timezone);
  }

  if (assetType === "zone") {
    const floor = floors.find((f) => f.zones?.some((z) => z.id === assetId));
    if (!floor) return resolveTimezone(null);

    const building = buildings.find((b) => b.id === floor.building_id);
    if (!building) return resolveTimezone(null);

    const site = sites.find((s) => s.id === building.site_id);
    return resolveTimezone(site?.timezone);
  }

  return resolveTimezone(null);
}

/** Whether `timezone` is an IANA zone this runtime's Intl recognizes. */
export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Local calendar date (YYYY-MM-DD) of an instant in `timezone`. Throws a
 * RangeError for an unrecognized timezone.
 */
export function formatLocalDate(date: Date | number, timezone: string): string {
  return localDateFormatter(timezone).format(date);
}

const localDateFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * A cached "YYYY-MM-DD" formatter per timezone: building an
 * Intl.DateTimeFormat is far slower than using one, and the local-midnight
 * search formats a few dozen instants per call. Throws a RangeError for an
 * unrecognized timezone (and caches nothing then).
 */
function localDateFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = localDateFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    localDateFormatters.set(timezone, formatter);
  }
  return formatter;
}

/**
 * Get timezone abbreviation (PST, PDT, CST, EST, etc.)
 * Uses Intl.DateTimeFormat to get the correct abbreviation for the given date
 */
export function getTimezoneAbbreviation(timezone: string, date: Date = new Date()): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "short",
    });

    const parts = formatter.formatToParts(date);
    const tzPart = parts.find((p) => p.type === "timeZoneName");
    return tzPart?.value || "UTC";
  } catch (error) {
    debug("timezone-helpers", `Failed to get abbreviation for ${timezone}:`, error);
    return "UTC";
  }
}

/**
 * Get UTC offset for a timezone at a specific date
 * Returns format like "UTC-5" or "UTC+9"
 */
export function getUTCOffset(timezone: string, date: Date = new Date()): string {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "longOffset",
    });

    const parts = formatter.formatToParts(date);
    const offsetPart = parts.find((p) => p.type === "timeZoneName");

    if (offsetPart?.value) {
      // Convert "GMT-5" to "UTC-5"
      return offsetPart.value.replace("GMT", "UTC");
    }

    return "UTC";
  } catch (error) {
    debug("timezone-helpers", `Failed to get offset for ${timezone}:`, error);
    return "UTC";
  }
}

/**
 * Check if daylight saving time is currently active for a timezone
 */
/** Minutes east of UTC for an offset string from getUTCOffset ("UTC", "UTC-05:00", "UTC+5:30"). */
function offsetMinutes(offset: string): number {
  const match = offset.match(/([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!match) return 0;
  const minutes = parseInt(match[2], 10) * 60 + (match[3] ? parseInt(match[3], 10) : 0);
  return match[1] === "-" ? -minutes : minutes;
}

export function isDSTActive(timezone: string, date: Date = new Date()): boolean {
  try {
    const jan = new Date(date.getFullYear(), 0, 1);
    const jul = new Date(date.getFullYear(), 6, 1);

    const janOffset = getUTCOffset(timezone, jan);
    const julOffset = getUTCOffset(timezone, jul);
    const currentOffset = getUTCOffset(timezone, date);

    // If Jan and Jul offsets are the same, timezone has no DST
    if (janOffset === julOffset) return false;

    // Standard time has the smaller UTC offset, compared as NUMBERS: the
    // offset strings ("UTC-08:00" vs "UTC-07:00") sort the wrong way for
    // zones west of UTC, which inverted the answer there.
    // - Northern: Jan is standard (e.g., -8h), Jul is DST (-7h)
    // - Southern: Jul is standard (e.g., +10h), Jan is DST (+11h)
    const standardMinutes = Math.min(offsetMinutes(janOffset), offsetMinutes(julOffset));
    return offsetMinutes(currentOffset) !== standardMinutes;
  } catch (error) {
    return false;
  }
}

/**
 * Format current local time for display
 * Returns: "2:35 PM PST on Oct 15, 2025"
 */
export function getCurrentLocalTime(timezone: string): string {
  try {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });

    const tzAbbr = getTimezoneAbbreviation(timezone, now);
    const dateStr = formatter.format(now);

    return `${dateStr} ${tzAbbr}`;
  } catch (error) {
    debug("timezone-helpers", `Failed to format time for ${timezone}:`, error);
    return new Date().toISOString();
  }
}

/**
 * Get midnight (start of day) in a specific timezone
 * Returns UTC Date object representing midnight in the given timezone
 *
 * More precisely, the FIRST INSTANT of the local calendar day that `date`
 * falls on. That is local 00:00 everywhere except where a DST change skips
 * midnight (Africa/Cairo on 2026-04-24, Asia/Beirut on 2026-03-29), where
 * 00:00 does not exist and the day starts at 01:00.
 *
 * Example: getLocalMidnight(new Date("2025-10-15T10:00:00Z"), "Asia/Kolkata")
 * Returns: Date object for "2025-10-14T18:30:00Z" (which is Oct 15 midnight IST)
 */
export function getLocalMidnight(date: Date, timezone: string): Date {
  try {
    return localDayStart(formatLocalDate(date, timezone), timezone);
  } catch (error) {
    debug("timezone-helpers", `Failed to calculate local midnight for ${timezone}:`, error);
    // Fallback to UTC midnight
    const utcMidnight = new Date(date);
    utcMidnight.setUTCHours(0, 0, 0, 0);
    return utcMidnight;
  }
}

/**
 * First instant of local calendar day `ymd` (YYYY-MM-DD) in `timezone`; see
 * getLocalMidnight. Throws a RangeError for an unrecognized timezone.
 */
export function localDayStart(ymd: string, timezone: string): Date {
  const formatter = localDateFormatter(timezone);
  const [year, month, day] = ymd.split("-").map(Number);

  // The local day starts somewhere between UTC midnight - 15h (UTC+14 is the
  // furthest ahead) and UTC midnight + 13h (UTC-12 is the furthest behind).
  // The local date never goes backwards as time moves forward, so binary
  // search for the first second whose local date ("YYYY-MM-DD", which
  // compares chronologically as a string) has reached `ymd`. Searching whole
  // dates (not hour/minute arithmetic) is what makes this correct across
  // month and year ends and when DST skips midnight.
  const utcMidnight = Date.UTC(year, month - 1, day);
  let lo = (utcMidnight - 15 * 3600 * 1000) / 1000; // local date < ymd
  let hi = (utcMidnight + 13 * 3600 * 1000) / 1000; // local date >= ymd
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (formatter.format(new Date(mid * 1000)) >= ymd) hi = mid;
    else lo = mid;
  }
  return new Date(hi * 1000);
}

/** The calendar date `days` after (or before, if negative) YYYY-MM-DD `ymd`. */
export function shiftDay(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * Build rich timezone metadata for an asset
 */
export interface TimezoneMetadata {
  site_timezone: string;
  timezone_offset: string;
  timezone_abbr: string;
  current_local_time: string;
  dst_active: boolean;
}

export function buildTimezoneMetadata(timezone: string): TimezoneMetadata {
  const now = new Date();
  return {
    site_timezone: timezone,
    timezone_offset: getUTCOffset(timezone, now),
    timezone_abbr: getTimezoneAbbreviation(timezone, now),
    current_local_time: getCurrentLocalTime(timezone),
    dst_active: isDSTActive(timezone, now),
  };
}
