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
 * These two are both `string` at runtime, which previously led to silent
 * filter failures when names were sent in the IDs slot. Branding them keeps
 * the distinction visible at the type level so the wrong one cannot be
 * passed by accident.
 */
export type TagId = string & { readonly __brand: "TagId" };
export type TagName = string & { readonly __brand: "TagName" };

export const asTagId = (value: string): TagId => value as TagId;
export const asTagName = (value: string): TagName => value as TagName;

/**
 * List every tag in the org along with its application footprint.
 *
 * Each tag's `rooms`, `zones`, and `floors` arrays are returned with
 * id-only payloads so the response stays bounded by tag count.
 */
export const GET_TAGS_WITH_USAGE = gql`
  query GetTagsWithUsage {
    tags {
      id
      name
      organization_id
      rooms {
        id
      }
      zones {
        id
      }
      floors {
        id
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
