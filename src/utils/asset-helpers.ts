/**
 * Asset helper utilities for type detection and ID parsing
 */

/**
 * Detect asset type from ID prefix
 */
export function detectAssetType(id: string): string {
  if (id.startsWith("site_")) return "site";
  if (id.startsWith("building_")) return "building";
  if (id.startsWith("space_") || id.startsWith("floor_")) return "floor";
  if (id.startsWith("room_")) return "room";
  if (id.startsWith("zone_")) return "zone";
  if (id.startsWith("sensor_")) return "sensor";
  if (id.startsWith("hive_")) return "hive";
  return "unknown";
}

/**
 * Get filter field name for v3 Reporting API
 * Maps asset types to v3 API filter field names
 */
export function getFilterFieldForAssetType(assetType: string): string {
  const fieldMap: Record<string, string> = {
    site: "clients",
    building: "buildings",
    floor: "spaces",
    room: "rooms",
    zone: "zones",
    sensor: "sensors",
    hive: "hives",
  };

  const field = fieldMap[assetType];
  if (!field) {
    throw new Error(
      `Unknown asset type: ${assetType}. Valid types: ${Object.keys(fieldMap).join(", ")}`
    );
  }

  return field;
}

/**
 * Get measurement name for asset type
 * Used for presence-based measurements
 */
export function getMeasurementForAssetType(assetType: string): string {
  const measurementMap: Record<string, string> = {
    room: "room_occupancy",
    zone: "zone_occupancy",
    floor: "floor_occupancy",
  };

  const measurement = measurementMap[assetType];
  if (!measurement) {
    throw new Error(
      `No measurement mapping for asset type: ${assetType}. Valid types: ${Object.keys(measurementMap).join(", ")}`
    );
  }

  return measurement;
}

/**
 * Get traffic measurement name for asset type
 */
export function getTrafficMeasurementForAssetType(assetType: string): string {
  const measurementMap: Record<string, string> = {
    room: "traffic_room_occupancy",
    floor: "traffic_floor_occupancy",
  };

  const measurement = measurementMap[assetType];
  if (!measurement) {
    throw new Error(
      `No traffic measurement for asset type: ${assetType}. Valid types: ${Object.keys(measurementMap).join(", ")}`
    );
  }

  return measurement;
}

/**
 * Validate that an asset type supports traffic measurements
 */
export function supportsTrafficMeasurement(assetType: string): boolean {
  return assetType === "room" || assetType === "floor";
}

/**
 * Validate that an asset type supports presence measurements
 */
export function supportsPresenceMeasurement(assetType: string): boolean {
  return assetType === "room" || assetType === "zone" || assetType === "floor";
}
