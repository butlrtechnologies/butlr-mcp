/**
 * Natural Language Utilities for Conversational Tools
 *
 * Generates qualitative labels, trend descriptions, and formatted summaries
 * to make API responses more conversational and actionable.
 */

/**
 * Occupancy labels based on utilization percentage
 * Thresholds can be configured via environment variables
 */
const DEFAULT_QUIET_THRESHOLD = 30; // < 30% = quiet
const DEFAULT_BUSY_THRESHOLD = 70; // > 70% = busy

const QUIET_THRESHOLD = parseInt(
  process.env.BUTLR_QUIET_THRESHOLD || String(DEFAULT_QUIET_THRESHOLD),
  10
);
const BUSY_THRESHOLD = parseInt(
  process.env.BUTLR_BUSY_THRESHOLD || String(DEFAULT_BUSY_THRESHOLD),
  10
);

/**
 * Get qualitative occupancy label
 * @param utilizationPercent - Occupancy as % of capacity (0-100+)
 * @returns "quiet" | "moderate" | "busy"
 */
export function getOccupancyLabel(utilizationPercent: number): "quiet" | "moderate" | "busy" {
  if (utilizationPercent < QUIET_THRESHOLD) {
    return "quiet";
  }
  if (utilizationPercent < BUSY_THRESHOLD) {
    return "moderate";
  }
  return "busy";
}

/**
 * Get trend label compared to typical
 * @param deltaPercent - Difference from typical (positive = busier, negative = quieter)
 * @returns "lighter" | "typical" | "busier"
 */
export function getTrendLabel(deltaPercent: number): "lighter" | "typical" | "busier" {
  const TREND_THRESHOLD = 15; // >15% change = notable

  if (deltaPercent < -TREND_THRESHOLD) {
    return "lighter";
  }
  if (deltaPercent > TREND_THRESHOLD) {
    return "busier";
  }
  return "typical";
}

/**
 * Get significance of change
 * @param deltaPercent - Absolute change percentage
 * @returns "notable" | "slight" | "minimal"
 */
export function getSignificance(deltaPercent: number): "notable" | "slight" | "minimal" {
  const abs = Math.abs(deltaPercent);

  if (abs > 15) {
    return "notable";
  }
  if (abs > 5) {
    return "slight";
  }
  return "minimal";
}

/**
 * Get trend direction
 * @param delta - Numeric change (positive or negative)
 * @returns "increasing" | "decreasing" | "stable"
 */
export function getTrendDirection(delta: number): "increasing" | "decreasing" | "stable" {
  const STABILITY_THRESHOLD = 0.05; // Within 5% = stable

  if (Math.abs(delta) < STABILITY_THRESHOLD) {
    return "stable";
  }
  return delta > 0 ? "increasing" : "decreasing";
}

/**
 * Build a busyness summary string
 * @example "Café: Moderate (12 people, 45% capacity, typical for Thursday 2pm)"
 */
export function buildBusynessSummary(params: {
  spaceName: string;
  occupancy: number;
  capacity: number;
  utilizationPercent: number;
  trendLabel?: "lighter" | "typical" | "busier";
  dayTime?: string; // e.g., "Thursday 2pm"
}): string {
  const label = getOccupancyLabel(params.utilizationPercent);
  const labelCapitalized = label.charAt(0).toUpperCase() + label.slice(1);

  const parts = [
    `${params.spaceName}: ${labelCapitalized}`,
    `(${params.occupancy} people, ${Math.round(params.utilizationPercent)}% capacity`,
  ];

  if (params.trendLabel && params.trendLabel !== "typical") {
    parts.push(`${params.trendLabel} than typical`);
  } else if (params.trendLabel === "typical" && params.dayTime) {
    parts.push(`typical for ${params.dayTime}`);
  }

  parts[parts.length - 1] += ")"; // Close parenthesis

  return parts.join(" ");
}

/**
 * Build an available rooms summary
 * @example "5 conference rooms available (capacity 4-12 people)"
 */
export function buildAvailableRoomsSummary(params: {
  count: number;
  roomType?: string; // e.g., "conference"
  minCapacity?: number;
  maxCapacity?: number;
}): string {
  const roomTypeStr = params.roomType ? `${params.roomType} ` : "";

  if (params.count === 0) {
    return `No ${roomTypeStr}rooms currently available`;
  }

  const parts = [];

  if (params.count === 1) {
    parts.push(`1 ${roomTypeStr}room available`);
  } else {
    parts.push(`${params.count} ${roomTypeStr}rooms available`);
  }

  if (params.minCapacity && params.maxCapacity) {
    parts.push(`(capacity ${params.minCapacity}-${params.maxCapacity} people)`);
  } else if (params.minCapacity) {
    parts.push(`(capacity ${params.minCapacity}+ people)`);
  }

  return parts.join(" ");
}

/**
 * Build a traffic flow summary
 * @example "Lobby: 47 entries today, 23% higher than typical Monday"
 */
export function buildTrafficSummary(params: {
  spaceName: string;
  entries: number;
  period: string; // e.g., "today", "last hour"
  vsTypicalPercent?: number;
  dayOfWeek?: string;
}): string {
  const parts = [`${params.spaceName}: ${params.entries} entries ${params.period}`];

  if (params.vsTypicalPercent !== undefined) {
    const abs = Math.abs(params.vsTypicalPercent);
    const direction = params.vsTypicalPercent > 0 ? "higher" : "lower";
    const day = params.dayOfWeek ? ` ${params.dayOfWeek}` : "";

    parts.push(`, ${Math.round(abs)}% ${direction} than typical${day}`);
  }

  return parts.join("");
}

/**
 * Build a hardware health summary
 * @example "45 of 52 sensors online (87%), 8 of 8 hives online (100%). 3 batteries critical, 7 due within 30 days."
 */
export function buildHardwareSummary(params: {
  sensorsOnline: number;
  sensorsTotal: number;
  hivesOnline: number;
  hivesTotal: number;
  batteriesCritical: number;
  batteriesDueSoon: number;
}): string {
  const sensorsPercent = Math.round((params.sensorsOnline / params.sensorsTotal) * 100);
  const hivesPercent = Math.round((params.hivesOnline / params.hivesTotal) * 100);

  const parts = [
    `${params.sensorsOnline} of ${params.sensorsTotal} sensors online (${sensorsPercent}%)`,
    `${params.hivesOnline} of ${params.hivesTotal} hives online (${hivesPercent}%)`,
  ];

  // Add battery health if applicable
  if (params.batteriesCritical > 0 || params.batteriesDueSoon > 0) {
    const batteryParts = [];
    if (params.batteriesCritical > 0) {
      batteryParts.push(`${params.batteriesCritical} batteries critical`);
    }
    if (params.batteriesDueSoon > 0) {
      batteryParts.push(`${params.batteriesDueSoon} due within 30 days`);
    }
    parts.push(batteryParts.join(", "));
  }

  return parts.join(", ") + ".";
}

/**
 * Build a building summary
 * @example "Building HQ: 60% occupied. Floor 3 busiest (85%). 23 rooms available."
 */
export function buildBuildingSummary(params: {
  buildingName: string;
  utilizationPercent: number;
  busiestFloor?: { name: string; utilization: number };
  availableRooms?: number;
}): string {
  const parts = [`${params.buildingName}: ${Math.round(params.utilizationPercent)}% occupied`];

  if (params.busiestFloor) {
    parts.push(
      `Floor ${params.busiestFloor.name} busiest (${Math.round(params.busiestFloor.utilization)}%)`
    );
  }

  if (params.availableRooms !== undefined) {
    parts.push(`${params.availableRooms} rooms available`);
  }

  return parts.join(". ") + ".";
}

/**
 * Build a usage trend summary
 * @example "Room 5A: 23% more utilized this week (67% vs 54%)"
 */
export function buildUsageTrendSummary(params: {
  spaceName: string;
  currentUtilization: number;
  previousUtilization: number;
  period1Label: string; // "this week"
  period2Label?: string; // "last week"
}): string {
  const delta = params.currentUtilization - params.previousUtilization;
  const deltaPercent = Math.abs(delta);
  const direction = delta > 0 ? "more" : "less";

  const significance = getSignificance(deltaPercent);

  if (significance === "minimal") {
    return `${params.spaceName}: Similar utilization ${params.period1Label} (${Math.round(params.currentUtilization)}% vs ${Math.round(params.previousUtilization)}%)`;
  }

  return `${params.spaceName}: ${Math.round(deltaPercent)}% ${direction} utilized ${params.period1Label} (${Math.round(params.currentUtilization)}% vs ${Math.round(params.previousUtilization)}%)`;
}

/**
 * Get recommendation based on busyness
 */
export function getBusinessRecommendation(label: "quiet" | "moderate" | "busy"): string {
  switch (label) {
    case "quiet":
      return "Great time to visit - not crowded";
    case "moderate":
      return "Good time to visit - moderately busy";
    case "busy":
      return "Consider waiting or visiting later - very busy";
  }
}

/**
 * Format day and time for context
 * @example "Thursday 2pm"
 */
export function formatDayAndTime(date: Date = new Date()): string {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dayName = days[date.getDay()];

  let hours = date.getHours();
  const ampm = hours >= 12 ? "pm" : "am";
  hours = hours % 12 || 12; // Convert to 12-hour format

  return `${dayName} ${hours}${ampm}`;
}

/**
 * Format period description
 * @example "today", "this week", "last 7 days"
 */
export function formatPeriodDescription(start: Date, stop: Date): string {
  const now = new Date();
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);

  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay()); // Sunday
  startOfWeek.setHours(0, 0, 0, 0);

  // Check if it's today
  if (start >= startOfToday && stop <= now) {
    return "today";
  }

  // Check if it's yesterday
  if (start >= startOfYesterday && stop < startOfToday) {
    return "yesterday";
  }

  // Check if it's this week
  if (start >= startOfWeek && stop <= now) {
    return "this week";
  }

  // Calculate days difference
  const diffMs = stop.getTime() - start.getTime();
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 1) {
    return "last 24 hours";
  }

  if (diffDays === 7) {
    return "last 7 days";
  }

  if (diffDays === 30) {
    return "last 30 days";
  }

  return `${diffDays} days`;
}

/**
 * Calculate days between dates
 */
export function daysBetween(date1: Date, date2: Date): number {
  const diffMs = date2.getTime() - date1.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

/**
 * Calculate hours between dates
 */
export function hoursBetween(date1: Date, date2: Date): number {
  const diffMs = date2.getTime() - date1.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60));
}
