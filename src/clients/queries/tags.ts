import { gql } from "@apollo/client";

/**
 * GraphQL queries for tag retrieval and lookups.
 *
 * Tags are org-scoped: a single tag (id, name, organization_id) can be
 * applied to any combination of rooms, zones, and floors via separate
 * association tables. There is no per-level tag namespace.
 */

/**
 * Branded string types for tag identifiers.
 *
 * The Butlr API filter `roomsByTag` accepts tag *IDs*, not tag *names*.
 * Both are `string` at runtime, which previously led to silent filter
 * failures when names were sent in the IDs slot. Branding them keeps the
 * distinction visible at the type level so the wrong one cannot be passed
 * by accident.
 */
export type TagId = string & { readonly __brand: "TagId" };
export type TagName = string & { readonly __brand: "TagName" };

/** Multi-tag composition mode shared across every tag-aware tool surface. */
export type TagMatch = "all" | "any";

/**
 * Brand a string as a tag id. Throws on empty/whitespace-only input — the
 * brand exists to catch "wrong slot" mistakes at compile time, but a blank
 * value would brand cleanly and slip through. Constructors that accept
 * arbitrary strings need a runtime check too.
 */
export const asTagId = (value: string): TagId => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid TagId: expected a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value as TagId;
};

/** Brand a string as a tag name. Same empty-input guard as `asTagId`. */
export const asTagName = (value: string): TagName => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid TagName: expected a non-empty string, got ${JSON.stringify(value)}`);
  }
  return value as TagName;
};

/**
 * Shape of each tagged-entity reference returned by `GET_TAGS_WITH_USAGE`.
 * `name` is best-effort: older API responses or partial entity records may
 * omit it, so consumers must treat it as optional.
 *
 * Both `id` and `name` are runtime-guarded against partial GraphQL
 * responses by `projectValidRefs` (src/utils/tag-resolver.ts) — refs with
 * a missing/null/empty `id` are dropped, and a missing `name` is elided
 * from the projection. Consumers should route through `projectValidRefs`
 * rather than reading the fields directly, even though the type declares
 * `id` as required.
 */
export interface TaggedEntityRef {
  id: string;
  name?: string;
}

/**
 * Raw `tags` row returned by `GET_TAGS_WITH_USAGE`. Used by `butlr_list_tags`
 * and the shared tag resolver — kept here so the GraphQL shape lives next
 * to the query that produces it.
 */
export interface RawTagWithUsage {
  id: string;
  name: string;
  organization_id?: string;
  rooms?: TaggedEntityRef[] | null;
  zones?: TaggedEntityRef[] | null;
  floors?: TaggedEntityRef[] | null;
}

/**
 * Inline tag projection returned when a Room/Zone/Floor query selects
 * `tags { id name }` directly (e.g. `butlr_get_asset_details`).
 *
 * Lightweight `{id, name}` projection — both fields are required by
 * the GraphQL schema and surfaced unchanged. Structurally similar to
 * but intentionally distinct from `TaggedEntityRef`: `TaggedEntityRef`
 * is best-effort (name optional) and represents the reverse direction
 * (entities under a tag); `TagRef` represents tags applied to an
 * entity. The bare name `Tag` is reserved for the full GraphQL Tag
 * entity (with organization_id, associations, etc.); callers needing
 * that shape go through `GET_TAGS_WITH_USAGE` instead.
 */
export interface TagRef {
  id: string;
  name: string;
}

/**
 * List every tag in the org along with its application footprint.
 *
 * Each tag's `rooms`, `zones`, and `floors` arrays carry both `id` and
 * `name` so callers (e.g. `butlr_list_tags { include_entities: true }`,
 * `butlr_list_topology { tag_names: [...] }`) can render the tagged
 * entities without an extra resolution step.
 */
export const GET_TAGS_WITH_USAGE = gql`
  query GetTagsWithUsage {
    tags {
      id
      name
      organization_id
      rooms {
        id
        name
      }
      zones {
        id
        name
      }
      floors {
        id
        name
      }
    }
  }
`;

/**
 * Minimal tag listing — id and name only.
 *
 * Used to resolve user-supplied tag names to tag IDs before invoking
 * tag-filtered queries (e.g. `roomsByTag(tagIDs:..)`).
 */
export const GET_TAGS_MINIMAL = gql`
  query GetTagsMinimal {
    tags {
      id
      name
    }
  }
`;
