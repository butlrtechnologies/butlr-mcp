/**
 * Field selection utilities for extracting specific fields from objects
 */

/**
 * Select specific fields from an object
 * Supports "*" wildcard to return all fields
 */
export function selectFields<T extends Record<string, any>>(obj: T, fields: string[]): Partial<T> {
  // "*" means return all fields
  if (fields.includes("*")) {
    return obj;
  }

  const result: any = {};

  for (const field of fields) {
    if (obj[field] !== undefined) {
      result[field] = obj[field];
    }
  }

  return result;
}

/**
 * Select fields from an array of objects
 */
export function selectFieldsFromArray<T extends Record<string, any>>(
  objects: T[],
  fields: string[]
): Partial<T>[] {
  return objects.map((obj) => selectFields(obj, fields));
}

/**
 * Extract nested field using dot notation
 * Example: extractNestedField(room, "floor.building.name") → "HQ"
 */
export function extractNestedField(obj: any, path: string): any {
  const parts = path.split(".");
  let current = obj;

  for (const part of parts) {
    if (current === null || current === undefined) {
      return undefined;
    }
    current = current[part];
  }

  return current;
}

/**
 * Common field sets for different verbosity levels
 */
export const FIELD_PRESETS = {
  minimal: ["id", "name"],
  summary: ["id", "name", "type"],
  standard: ["id", "name", "type", "capacity", "area"],
  full: ["*"],
};

/**
 * Resolve field preset or custom field list
 */
export function resolveFields(fields?: string[] | string): string[] {
  if (!fields) {
    return FIELD_PRESETS.summary;
  }

  if (typeof fields === "string") {
    return FIELD_PRESETS[fields as keyof typeof FIELD_PRESETS] || [fields];
  }

  return fields;
}
