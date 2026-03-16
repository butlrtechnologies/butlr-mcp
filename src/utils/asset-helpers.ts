/**
 * Asset helper utilities for type detection and ID parsing
 */

/**
 * Detect asset type from ID prefix
 */
export function detectAssetType(
  id: string
): "site" | "building" | "floor" | "room" | "zone" | "sensor" | "hive" | "unknown" {
  if (id.startsWith("site_")) return "site";
  if (id.startsWith("building_")) return "building";
  if (id.startsWith("space_") || id.startsWith("floor_")) return "floor";
  if (id.startsWith("room_")) return "room";
  if (id.startsWith("zone_")) return "zone";
  if (id.startsWith("sensor_")) return "sensor";
  if (id.startsWith("hive_")) return "hive";
  return "unknown";
}
