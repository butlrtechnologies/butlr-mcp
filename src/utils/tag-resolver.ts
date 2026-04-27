import { asTagId, asTagName, type TagId, type TagName } from "../clients/queries/tags.js";

/**
 * Pure tag-name → tag-row resolution shared by `butlr_available_rooms` and
 * `butlr_list_topology`.
 *
 * The two callers fetch different tag shapes — the available-rooms path only
 * needs `{id, name}` to drive a server-side `roomsByTag` filter, while the
 * topology path needs the full usage rows to drive a client-side tree filter.
 * Keeping this helper a pure function over an already-fetched row list lets
 * each caller fetch the minimum shape it needs without forcing the helper
 * to know about Apollo or GraphQL queries.
 */

export interface ResolveTagNamesInput<Row extends { id: string; name: string }> {
  /** All tag rows fetched from the API (any shape that has at least id+name). */
  allTags: Row[];
  /** Names supplied by the caller (case-insensitive match against `allTags[].name`). */
  requestedNames: string[];
  /** Multi-tag semantics — only affects `unsatisfiable` for unknown tags. */
  match: "all" | "any";
}

export interface ResolveTagNamesResult<Row extends { id: string; name: string }> {
  /** Tag rows whose names matched — preserves the input row shape so callers retain typing. */
  resolvedRows: Row[];
  /** Resolved tag IDs in the same order as `resolvedRows`. */
  resolvedIds: TagId[];
  /** Names from `requestedNames` that did not match any tag, branded for type-safety. */
  unknownNames: TagName[];
  /**
   * True when `match='all'` and at least one requested name was unknown — the
   * intersection cannot be satisfied, so callers should short-circuit instead
   * of querying with the resolved subset (which would silently broaden).
   */
  unsatisfiable: boolean;
}

export function resolveTagNames<Row extends { id: string; name: string }>(
  input: ResolveTagNamesInput<Row>
): ResolveTagNamesResult<Row> {
  const { allTags, requestedNames, match } = input;

  const lookup = new Map<string, Row>(allTags.map((t) => [t.name.toLowerCase(), t]));

  const resolvedRows: Row[] = [];
  const resolvedIds: TagId[] = [];
  const unknownNames: TagName[] = [];

  for (const rawName of requestedNames) {
    const name = asTagName(rawName);
    const row = lookup.get(name.toLowerCase());
    if (row) {
      resolvedRows.push(row);
      resolvedIds.push(asTagId(row.id));
    } else {
      unknownNames.push(name);
    }
  }

  return {
    resolvedRows,
    resolvedIds,
    unknownNames,
    unsatisfiable: match === "all" && unknownNames.length > 0,
  };
}
