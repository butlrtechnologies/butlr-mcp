/**
 * Field validation for selective entity detail fetching
 * Validates that requested fields are valid for each entity type
 */

/** Known entity types supported by the Butlr GraphQL API */
export const ENTITY_TYPES = [
  "site",
  "building",
  "floor",
  "room",
  "zone",
  "sensor",
  "hive",
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];

/**
 * Field name aliases (snake_case → camelCase)
 * GraphQL schema uses a mix of snake_case and camelCase.
 * Some fields have aliases (e.g., floor_id → floorID).
 */
const FIELD_ALIASES: Record<string, string> = {
  floor_id: "floorID",
  room_id: "roomID",
  hive_id: "hiveID",
  sensor_id: "id", // sensor_id is deprecated, use id
};

/**
 * Normalize field name (convert snake_case to camelCase if alias exists)
 */
function normalizeFieldName(field: string): string {
  return FIELD_ALIASES[field] || field;
}

/**
 * Valid fields for each entity type
 * Based on GraphQL schema (mix of snake_case and camelCase)
 */
const VALID_FIELDS: Record<EntityType, readonly string[]> = {
  site: ["id", "name", "timezone", "siteNumber", "customID", "org_id", "buildings"],
  building: [
    "id",
    "name",
    "building_number",
    "site_id",
    "customID",
    "capacity",
    "address",
    "floors",
    "site",
  ],
  floor: [
    "id",
    "name",
    "floorNumber",
    "building_id",
    "timezone",
    "installation_date",
    "installation_status",
    "customID",
    "capacity",
    "area",
    "rooms",
    "zones",
    "sensors",
    "hives",
    "building",
    "tags",
  ],
  room: [
    "id",
    "name",
    "floorID",
    "roomType",
    "customID",
    "capacity",
    "area",
    "coordinates",
    "rotation",
    "note",
    "sensors",
    "floor",
    "tags",
  ],
  zone: [
    "id",
    "name",
    "floorID",
    "roomID",
    "customID",
    "capacity",
    "area",
    "coordinates",
    "rotation",
    "note",
    "sensors",
    "tags",
  ],
  sensor: [
    "id",
    "name",
    "mac_address",
    "mode",
    "model",
    "roomID",
    "hive_serial",
    "is_online",
    "is_streaming",
    "height",
    "center",
    "orientation",
    "field_of_view",
    "door_line",
    "in_direction",
    "is_entrance",
    "parallel_to_door",
    "sensitivity",
    "note",
    "last_heartbeat",
    "last_raw_message",
    "last_occupancy_message",
    "power_type",
    "sensor_serial",
    "installation_status",
  ],
  hive: [
    "id",
    "name",
    "serialNumber",
    "floorID",
    "roomID",
    "isOnline",
    "coordinates",
    "isStreaming",
    "hiveVersion",
    "hiveType",
    "note",
    "lastHeartbeat",
    "netPathStability",
    "installed",
  ],
};

/**
 * Default fields for each entity type (minimal set)
 */
export const DEFAULT_FIELDS: Record<EntityType, readonly string[]> = {
  site: ["id", "name"],
  building: ["id", "name"],
  floor: ["id", "name", "floorNumber"],
  room: ["id", "name"],
  zone: ["id", "name"],
  sensor: ["id", "mac_address"],
  hive: ["id", "serialNumber"],
};

/**
 * Validate that requested fields are valid for an entity type
 * Accepts both snake_case and camelCase field names
 * @param entityType Type of entity (site, building, floor, room, zone, sensor, hive)
 * @param requestedFields Array of field names
 * @throws Error if any field is invalid
 */
export function validateFields(entityType: EntityType, requestedFields: string[]): void {
  const validFields = VALID_FIELDS[entityType];

  if (!validFields) {
    throw new Error(
      `Unknown entity type: ${entityType}. Valid types: ${Object.keys(VALID_FIELDS).join(", ")}`
    );
  }

  // Normalize field names (snake_case → camelCase) before validation
  const normalizedFields = requestedFields.map(normalizeFieldName);

  const invalidFields = normalizedFields.filter((field) => !validFields.includes(field));

  if (invalidFields.length > 0) {
    const originalInvalid = requestedFields.filter(
      (_, i) => !validFields.includes(normalizedFields[i])
    );
    throw new Error(
      `Invalid fields for ${entityType}: ${originalInvalid.join(", ")}. ` +
        `Valid fields: ${validFields.join(", ")} (also accepts snake_case: floor_id, room_id, etc.)`
    );
  }
}

/**
 * Get default fields for an entity type
 */
export function getDefaultFields(entityType: EntityType): string[] {
  const defaults = DEFAULT_FIELDS[entityType];
  if (!defaults) {
    throw new Error(`Unknown entity type: ${entityType}`);
  }
  return [...defaults];
}

/**
 * Validate and return fields (use defaults if none provided)
 * Normalizes snake_case to camelCase for GraphQL queries
 */
export function getValidatedFields(entityType: EntityType, requestedFields?: string[]): string[] {
  if (!requestedFields || requestedFields.length === 0) {
    return getDefaultFields(entityType);
  }

  validateFields(entityType, requestedFields);

  // Normalize field names (snake_case → camelCase)
  const normalizedFields = requestedFields.map(normalizeFieldName);

  // Always include 'id' field (required by Apollo cache)
  if (!normalizedFields.includes("id")) {
    return ["id", ...normalizedFields];
  }

  return normalizedFields;
}
