/**
 * Send a query that selects the optional Room/Zone fields (archive-fields.ts)
 * with whichever of them the API's schema lacks stripped out.
 *
 * This MCP can ship before the API that adds `archivedAt`, `replacesID` and
 * `sensorsRemovedAt`, and a GraphQL server rejects the whole query when it
 * selects a field the schema lacks. Instead of sending the query and reading
 * the error text, a schema check (`__type(name: "Room"/"Zone") { fields }`)
 * decides up front which fields to keep. Its answer is cached and re-checked
 * hourly, so a long-running server picks new fields up after the API deploys
 * without a restart. A field is kept only when both Room and Zone have it.
 *
 * If the schema check itself fails, every optional field is stripped (the
 * query then works against any API version) and the check is retried after
 * a few minutes.
 *
 * The result says which fields were left out (`omittedFields`), so callers
 * that cache it can skip caching an incomplete answer.
 */

import { gql, type ApolloClient } from "@apollo/client";
import { Kind, visit, type DocumentNode } from "graphql";
import { apolloClient } from "./graphql-client.js";
import { SPACE_ARCHIVE_FIELD_NAMES } from "./queries/archive-fields.js";
import {
  SPACE_FIELD_FAILURE_RECHECK_MS,
  SPACE_FIELD_RECHECK_MS,
  cachedSpaceFieldSupport,
  recordSpaceFieldSupport,
} from "./space-field-support.js";
import { debug } from "../utils/debug.js";

export {
  primeSpaceFieldSupport,
  resetSpaceFieldSupport,
  SPACE_FIELD_RECHECK_MS,
} from "./space-field-support.js";

/** Schema check: the field names of Room and Zone. */
export const SPACE_FIELD_SCHEMA_QUERY = gql`
  query SpaceFieldSupport {
    room: __type(name: "Room") {
      fields {
        name
      }
    }
    zone: __type(name: "Zone") {
      fields {
        name
      }
    }
  }
`;

interface SchemaCheckData {
  room?: { fields?: Array<{ name: string }> | null } | null;
  zone?: { fields?: Array<{ name: string }> | null } | null;
}

let inFlight: Promise<ReadonlySet<string>> | null = null;

/**
 * The optional fields the API supports, from cache or a fresh schema check.
 * Concurrent callers share one in-flight check.
 */
export function checkSpaceFieldSupport(): Promise<ReadonlySet<string>> {
  const cached = cachedSpaceFieldSupport();
  if (cached) return Promise.resolve(cached);
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const result = await apolloClient.query<SchemaCheckData>({
        query: SPACE_FIELD_SCHEMA_QUERY,
        fetchPolicy: "network-only",
      });
      const room = result.data?.room?.fields;
      const zone = result.data?.zone?.fields;
      if (result.error || !Array.isArray(room) || !Array.isArray(zone)) {
        throw result.error ?? new Error("schema check returned no Room/Zone fields");
      }
      const roomNames = new Set(room.map((f) => f.name));
      const zoneNames = new Set(zone.map((f) => f.name));
      const supported = SPACE_ARCHIVE_FIELD_NAMES.filter(
        (name) => roomNames.has(name) && zoneNames.has(name)
      );
      debug("archive-fallback", `API supports optional space fields: [${supported.join(", ")}]`);
      return recordSpaceFieldSupport(supported, SPACE_FIELD_RECHECK_MS);
    } catch (error: unknown) {
      debug(
        "archive-fallback",
        "Schema check failed; stripping all optional space fields for a few minutes:",
        error instanceof Error ? error.message : error
      );
      return recordSpaceFieldSupport([], SPACE_FIELD_FAILURE_RECHECK_MS);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

const strippedCache = new WeakMap<DocumentNode, Map<string, DocumentNode>>();

/**
 * The same document with every selection of the named fields removed.
 * Memoized per document and field set, so the result is the same object on
 * every call.
 */
export function stripFields(document: DocumentNode, names: readonly string[]): DocumentNode {
  if (names.length === 0) return document;
  const key = [...names].sort().join(",");
  let byKey = strippedCache.get(document);
  if (!byKey) {
    byKey = new Map();
    strippedCache.set(document, byKey);
  }
  const cached = byKey.get(key);
  if (cached) return cached;
  const drop = new Set(names);
  const stripped = visit(document, {
    [Kind.FIELD](node) {
      // Returning null deletes the node from its selection set.
      return drop.has(node.name.value) ? null : undefined;
    },
  });
  byKey.set(key, stripped);
  return stripped;
}

/** The document with every optional space field removed. */
export function stripArchiveFields(document: DocumentNode): DocumentNode {
  return stripFields(document, SPACE_ARCHIVE_FIELD_NAMES);
}

export type SpaceFieldQueryResult<TData> = ApolloClient.QueryResult<TData> & {
  /** Optional space fields that were stripped because the API lacks them. */
  omittedFields: readonly string[];
};

/**
 * Run `query` with the optional space fields the API lacks stripped out.
 * Results carry no value for an omitted field, which every reader treats as
 * "active, replaces nothing, removal time unknown".
 *
 * When the schema check is cached (the usual case) the `apolloClient.query`
 * call is made synchronously, so callers that start several queries
 * together keep their order.
 */
export function queryWithArchiveFallback<TData>(
  query: DocumentNode,
  variables?: Record<string, unknown>
): Promise<SpaceFieldQueryResult<TData>> {
  const run = async (supported: ReadonlySet<string>): Promise<SpaceFieldQueryResult<TData>> => {
    const omittedFields = SPACE_ARCHIVE_FIELD_NAMES.filter((name) => !supported.has(name));
    const result = (await apolloClient.query<TData>({
      query: stripFields(query, omittedFields),
      ...(variables ? { variables } : {}),
      fetchPolicy: "network-only",
    } as ApolloClient.QueryOptions<TData>)) as ApolloClient.QueryResult<TData>;
    return Object.assign({}, result, { omittedFields });
  };
  const cached = cachedSpaceFieldSupport();
  return cached ? run(cached) : checkSpaceFieldSupport().then(run);
}
