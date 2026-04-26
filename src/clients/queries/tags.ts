import { gql } from "@apollo/client";

/**
 * GraphQL queries for tag retrieval and lookups.
 *
 * Tags are org-scoped: a single tag (id, name, organization_id) can be
 * applied to any combination of rooms, zones, and floors via separate
 * association tables. There is no per-level tag namespace.
 */

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
