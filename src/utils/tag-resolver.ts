import {
  asTagId,
  asTagName,
  type TagId,
  type TagName,
  type TaggedEntityRef,
} from "../clients/queries/tags.js";

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
  /** Multi-tag semantics — only affects the `unsatisfiable` discriminant for unknown tags. */
  match: "all" | "any";
}

/**
 * Discriminated union over the three terminal states.
 *
 * Callers branch on `kind` first; the type structurally prevents reading
 * `resolvedRows` on a non-`ok` branch, where the resolved subset must NOT
 * be used (it would silently broaden a `match='all'` query to `match='any'`
 * semantics, or hide an all-unknown input behind a misleading "partial
 * resolution" path).
 *
 * - `ok` — at least one requested name resolved; safe to continue with the
 *   subset. Under `match='all'` this implies every name resolved.
 * - `no_match` — every requested name was unknown. Distinct from
 *   `unsatisfiable` because the right diagnostic is "no matching tags
 *   found" rather than "cannot satisfy AND" (with one input there's no AND
 *   to satisfy).
 * - `unsatisfiable` — `match='all'` with at least one resolved AND at
 *   least one unknown. Asking for the AND is impossible; the resolved
 *   subset is intentionally hidden so a caller can't accidentally fall
 *   back to `match='any'` semantics.
 */
export type ResolveTagNamesResult<Row extends { id: string; name: string }> =
  | {
      kind: "ok";
      /** Tag rows whose names matched — preserves the input row shape. */
      resolvedRows: Row[];
      /** Resolved tag IDs in the same order as `resolvedRows`. */
      resolvedIds: TagId[];
      /** Names from the input that did not match any tag. */
      unknownNames: TagName[];
      /**
       * Number of malformed rows skipped by the defensive guard (missing or
       * empty `id` / `name`). Non-zero values indicate an upstream contract
       * violation that callers should surface as a `malformed_tag_rows`
       * diagnostic — silent filtering would otherwise hide the breakage.
       */
      droppedRowCount: number;
    }
  | {
      kind: "no_match";
      /** Every requested name, in input order. */
      unknownNames: TagName[];
      /** Same semantics as the `ok` variant — surface as a diagnostic if non-zero. */
      droppedRowCount: number;
    }
  | {
      kind: "unsatisfiable";
      /** The unknown subset that prevents satisfying `match='all'`. */
      unknownNames: TagName[];
      /** The resolved subset, hidden from callers so they can't broaden semantics. */
      partialResolvedCount: number;
      /** Same semantics as the `ok` variant — surface as a diagnostic if non-zero. */
      droppedRowCount: number;
    };

export function resolveTagNames<Row extends { id: string; name: string }>(
  input: ResolveTagNamesInput<Row>
): ResolveTagNamesResult<Row> {
  const { allTags, requestedNames, match } = input;

  // Defensively skip rows whose `name` or `id` is not a usable string. The
  // type contract says both are required, but a missing field on a partial
  // GraphQL response would otherwise throw on `.toLowerCase()` (name) or
  // surface a null branded TagId downstream (id), crashing every tag-using
  // tool. Empty strings are rejected too — they can never match a
  // Zod-validated request and would sit as dead weight in the lookup.
  // The dropped count is returned to the caller so the upstream contract
  // violation is visible (rather than silently masking it as "unknown tag").
  const lookup = new Map<string, Row>();
  let droppedRowCount = 0;
  for (const t of allTags) {
    if (typeof t.name !== "string" || t.name.length === 0) {
      droppedRowCount++;
      continue;
    }
    if (typeof t.id !== "string" || t.id.length === 0) {
      droppedRowCount++;
      continue;
    }
    lookup.set(t.name.toLowerCase(), t);
  }

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

  if (resolvedRows.length === 0 && unknownNames.length > 0) {
    // At least one name was requested and nothing matched — distinct from
    // `unsatisfiable` so callers can emit "no matching tags found" rather
    // than the misleading "cannot satisfy AND" (when only one input was
    // sent there's no AND to fail). Empty `requestedNames` falls through
    // to the `ok` branch as a trivially-empty resolution.
    return { kind: "no_match", unknownNames, droppedRowCount };
  }
  if (match === "all" && unknownNames.length > 0) {
    return {
      kind: "unsatisfiable",
      unknownNames,
      partialResolvedCount: resolvedRows.length,
      droppedRowCount,
    };
  }
  return { kind: "ok", resolvedRows, resolvedIds, unknownNames, droppedRowCount };
}

/**
 * Filter a tagged-entity ref list to only entries with a usable `id`, and
 * drop the optional `name` when upstream omits it. Used by both
 * `butlr_list_tags` (`applied_to_entities` projection) and
 * `butlr_list_topology` (`collectTaggedEntityIds` per-type filter) so the
 * "what counts as a non-dangling ref" predicate lives in one place — they
 * cannot drift apart, and the count + entity arrays produced from the same
 * filtered list are guaranteed to agree.
 */
export function projectValidRefs(
  refs: ReadonlyArray<TaggedEntityRef> | null | undefined
): TaggedEntityRef[] {
  if (!refs) return [];
  return refs.flatMap((ref) =>
    typeof ref.id === "string" && ref.id.length > 0
      ? [typeof ref.name === "string" ? { id: ref.id, name: ref.name } : { id: ref.id }]
      : []
  );
}
