/**
 * Archive fields on Room and Zone.
 *
 * `archivedAt` (Time, null = active) marks a space that was retired but kept
 * for its history, e.g. a room whose sensors were moved to a re-drawn copy.
 * `replacesID` points a new space at the one it superseded, one level deep.
 *
 * These fields are newer than some deployed APIs. A GraphQL server rejects a
 * whole query that selects a field its schema does not have, so every query
 * that interpolates this selection must be sent through
 * `queryWithArchiveFallback` (src/clients/archive-fallback.ts), which
 * retries once with these fields stripped from the document.
 */
export const SPACE_ARCHIVE_FIELDS = `
  archivedAt
  replacesID
`;

/** Field names in SPACE_ARCHIVE_FIELDS, used to recognise the API rejecting them. */
export const SPACE_ARCHIVE_FIELD_NAMES = ["archivedAt", "replacesID"] as const;
