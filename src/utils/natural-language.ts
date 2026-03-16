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
  const sensorsPercent =
    params.sensorsTotal > 0 ? Math.round((params.sensorsOnline / params.sensorsTotal) * 100) : 0;
  const hivesPercent =
    params.hivesTotal > 0 ? Math.round((params.hivesOnline / params.hivesTotal) * 100) : 0;

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
