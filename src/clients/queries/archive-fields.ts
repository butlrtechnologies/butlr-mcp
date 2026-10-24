/**
 * Optional fields on Room and Zone, newer than some deployed APIs.
 *
 * - `archivedAt` (Time, null = active): the space was retired but kept for
 *   its history, e.g. a room whose sensors moved to a re-drawn copy.
 * - `replacesID`: a new space points at the one it superseded (one level).
 * - `sensorsRemovedAt` (Time): start of the space's CURRENT sensorless period;
 *   null while it has sensors, or when unknown (API #3038).
 *
 * A GraphQL server rejects a whole query that selects a field its schema
 * does not have, so every query that interpolates this selection must be
 * sent through `queryWithArchiveFallback` (src/clients/archive-fallback.ts),
 * which checks the schema and strips whichever of these fields the API
 * lacks before sending.
 */

/** Field names of the optional Room/Zone fields. */
export const SPACE_ARCHIVE_FIELD_NAMES = ["archivedAt", "replacesID", "sensorsRemovedAt"] as const;

/** The same fields as a selection to interpolate into a query. */
export const SPACE_ARCHIVE_FIELDS = SPACE_ARCHIVE_FIELD_NAMES.join("\n");
