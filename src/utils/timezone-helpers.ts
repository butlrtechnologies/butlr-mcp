/**
 * Timezone utilities for converting between UTC and site-specific timezones
 * All Butlr timestamps are UTC; timezones are stored at Site level
 */

import type { Site, Building, Floor } from "../clients/types.js";
import { debug } from "./debug.js";

/**
 * Get the site timezone for any asset (floor, room, zone)
 * Traverses hierarchy to find parent site
 */
export function getTimezoneForAsset(
  assetId: string,
  assetType: "floor" | "room" | "zone",
  floors: Floor[],
  buildings: Building[],
  sites: Site[]
): string | null {
  if (assetType === "floor") {
    const floor = floors.find((f) => f.id === assetId);
    if (!floor) return null;

    const building = buildings.find((b) => b.id === floor.building_id);
    if (!building) return null;

    const site = sites.find((s) => s.id === building.site_id);
    return site?.timezone || null;
  }

  if (assetType === "room") {
    // Find floor for this room
    const floor = floors.find((f) => f.rooms?.some((r) => r.id === assetId));
    if (!floor) return null;

    const building = buildings.find((b) => b.id === floor.building_id);
    if (!building) return null;

    const site = sites.find((s) => s.id === building.site_id);
    return site?.timezone || null;
  }

  if (assetType === "zone") {
    // Find floor for this zone
    const floor = floors.find((f) => f.zones?.some((z) => z.id === assetId));
    if (!floor) return null;

    const building = buildings.find((b) => b.id === floor.building_id);
    if (!building) return null;

    const site = sites.find((s) => s.id === building.site_id);
    return site?.timezone || null;
  }

  return null;
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
export function isDSTActive(timezone: string, date: Date = new Date()): boolean {
  try {
    const jan = new Date(date.getFullYear(), 0, 1);
    const jul = new Date(date.getFullYear(), 6, 1);

    const janOffset = getUTCOffset(timezone, jan);
    const julOffset = getUTCOffset(timezone, jul);
    const currentOffset = getUTCOffset(timezone, date);

    // If Jan and Jul offsets are the same, timezone has no DST
    if (janOffset === julOffset) return false;

    // Standard time has the smaller (more negative) UTC offset string.
    // This works for both hemispheres:
    // - Northern: Jan is standard (e.g., "-08:00"), Jul is DST ("-07:00")
    // - Southern: Jul is standard (e.g., "+10:00"), Jan is DST ("+11:00")
    const standardOffset = janOffset < julOffset ? janOffset : julOffset;
    return currentOffset !== standardOffset;
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
 * Example: getLocalMidnight(new Date("2025-10-15T10:00:00Z"), "Asia/Kolkata")
 * Returns: Date object for "2025-10-14T18:30:00Z" (which is Oct 15 midnight IST)
 */
export function getLocalMidnight(date: Date, timezone: string): Date {
  try {
    // Get the local date in the target timezone using Intl.DateTimeFormat
    const localDate = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
    // localDate is "YYYY-MM-DD" in the target timezone

    const [year, month, day] = localDate.split("-").map(Number);

    // Start with a rough estimate: UTC midnight on that date
    let estimate = new Date(Date.UTC(year, month - 1, day, 0, 0, 0));

    // Iteratively adjust to find the UTC time that corresponds to midnight local time
    for (let i = 0; i < 3; i++) {
      const localAtEstimate = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      }).formatToParts(estimate);

      const h = parseInt(localAtEstimate.find((p) => p.type === "hour")?.value || "0");
      const m = parseInt(localAtEstimate.find((p) => p.type === "minute")?.value || "0");
      const d = parseInt(localAtEstimate.find((p) => p.type === "day")?.value || "0");

      if (h === 0 && m === 0 && d === day) break; // Found it

      // Adjust: we want local to be 00:00 on `day`
      let diffMinutes = h * 60 + m;
      if (d !== day) {
        // Day is wrong, big adjustment needed
        if (d < day)
          diffMinutes -= 24 * 60; // We're a day behind
        else diffMinutes += 24 * 60; // We're a day ahead
      }
      estimate = new Date(estimate.getTime() - diffMinutes * 60 * 1000);
    }

    return estimate;
  } catch (error) {
    debug("timezone-helpers", `Failed to calculate local midnight for ${timezone}:`, error);
    // Fallback to UTC midnight
    const utcMidnight = new Date(date);
    utcMidnight.setUTCHours(0, 0, 0, 0);
    return utcMidnight;
  }
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
