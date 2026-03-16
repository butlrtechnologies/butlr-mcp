/**
 * Timezone utilities for converting between UTC and site-specific timezones
 * All Butlr timestamps are UTC; timezones are stored at Site level
 */

import type { Site, Building, Floor } from "../clients/types.js";

/**
 * Build a map of site IDs to their timezones for quick lookups
 */
export function buildSiteTimezoneMap(sites: Site[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const site of sites) {
    if (site.timezone) {
      map.set(site.id, site.timezone);
    }
  }
  return map;
}

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
    if (process.env.DEBUG) {
      console.error(`[timezone-helpers] Failed to get abbreviation for ${timezone}:`, error);
    }
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
    if (process.env.DEBUG) {
      console.error(`[timezone-helpers] Failed to get offset for ${timezone}:`, error);
    }
    return "UTC";
  }
}

/**
 * Check if daylight saving time is currently active for a timezone
 */
export function isDSTActive(timezone: string, date: Date = new Date()): boolean {
  try {
    // Compare offset in summer vs winter to detect DST
    const jan = new Date(date.getFullYear(), 0, 1);
    const jul = new Date(date.getFullYear(), 6, 1);

    const janOffset = getUTCOffset(timezone, jan);
    const julOffset = getUTCOffset(timezone, jul);
    const currentOffset = getUTCOffset(timezone, date);

    // DST is active if current offset differs from standard (winter) offset
    return currentOffset !== janOffset && currentOffset === julOffset;
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
    if (process.env.DEBUG) {
      console.error(`[timezone-helpers] Failed to format time for ${timezone}:`, error);
    }
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
    // Simple approach: Get offset, calculate midnight
    // Start from current time, round down to start of UTC day, then adjust by offset

    // Get current offset in milliseconds
    const utcMidnight = new Date(date);
    utcMidnight.setUTCHours(0, 0, 0, 0);

    // Format midnight UTC in the target timezone to see what time it is there
    const midnightLocal = utcMidnight.toLocaleString("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });

    // Parse "HH:mm" format
    const [hourStr, minStr] = midnightLocal.split(":");
    const localHourAtUTCMidnight = parseInt(hourStr);
    const localMinAtUTCMidnight = parseInt(minStr);

    // Calculate how many milliseconds to subtract to get to local midnight
    // If it's 05:30 at UTC midnight, we need to go back 5.5 hours
    const offsetMs = localHourAtUTCMidnight * 60 * 60 * 1000 + localMinAtUTCMidnight * 60 * 1000;

    const localMidnight = new Date(utcMidnight.getTime() - offsetMs);

    return localMidnight;
  } catch (error) {
    if (process.env.DEBUG) {
      console.error(`[timezone-helpers] Failed to get local midnight for ${timezone}:`, error);
    }
    const utcMidnight = new Date(date);
    utcMidnight.setUTCHours(0, 0, 0, 0);
    return utcMidnight;
  }
}

/**
 * Format UTC timestamp as local hour
 * Returns: "09:30 AM IST" for display in hourly breakdowns
 */
export function formatHourInTimezone(utcTimestamp: string | Date, timezone: string): string {
  try {
    const date = typeof utcTimestamp === "string" ? new Date(utcTimestamp) : utcTimestamp;

    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });

    const tzAbbr = getTimezoneAbbreviation(timezone, date);
    return `${formatter.format(date)} ${tzAbbr}`;
  } catch (error) {
    if (process.env.DEBUG) {
      console.error(`[timezone-helpers] Failed to format hour for ${timezone}:`, error);
    }
    return typeof utcTimestamp === "string" ? utcTimestamp : utcTimestamp.toISOString();
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
