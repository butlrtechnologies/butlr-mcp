/**
 * Send a query that selects the optional Room/Zone fields (archive-fields.ts)
 * with whichever of them the API's schema lacks stripped out.
 *
 * This MCP can ship before the API that adds `archivedAt`, `replacesID` and
 * `sensorsRemovedAt`, and a GraphQL server rejects the whole query when it
 * selects a field the schema lacks. A schema check
 * (`__type(name: "Room"/"Zone") { fields }`) decides which fields to keep;
 * a field is kept only when both Room and Zone have it.
 *
 * - The answer is re-checked hourly. A stale answer keeps serving while the
 *   re-check runs in the background, so only the first query of a process
 *   waits for a check.
 * - A failed check keeps the last good answer and retries in 5 minutes; only
 *   with no good answer yet does it strip every optional field. The check has
 *   its own timeout.
 * - If a query is still rejected as invalid (GRAPHQL_VALIDATION_FAILED), for
 *   example because a rolling deploy or rollback put an older API task behind
 *   the load balancer, the cached answer is dropped and the query is retried
 *   once with every optional field stripped.
 *
 * The result says which fields were left out (`omittedFields`).
 */

import { gql, type ApolloClient } from "@apollo/client";
import { CombinedGraphQLErrors, ServerError } from "@apollo/client/errors";
import { Kind, visit, type DocumentNode } from "graphql";
import { apolloClient } from "./graphql-client.js";
import { SPACE_ARCHIVE_FIELD_NAMES } from "./queries/archive-fields.js";
import {
  freshSpaceFieldSupport,
  lastConfirmedSpaceFieldSupport,
  recordSpaceFieldSupport,
  resetSpaceFieldSupport,
} from "./space-field-support.js";
import { debug } from "../utils/debug.js";

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

/** How long the schema check may take before it counts as failed. */
export const SPACE_FIELD_CHECK_TIMEOUT_MS = 10_000;

interface SchemaCheckData {
  room?: { fields?: Array<{ name: string }> | null } | null;
  zone?: { fields?: Array<{ name: string }> | null } | null;
}

let inFlight: Promise<ReadonlySet<string>> | null = null;

/**
 * Run the schema check (concurrent callers share one) and record its
 * outcome. Resolves to the field set now in use; never rejects.
 */
export function checkSpaceFieldSupport(): Promise<ReadonlySet<string>> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(new Error(`schema check timed out after ${SPACE_FIELD_CHECK_TIMEOUT_MS} ms`)),
          SPACE_FIELD_CHECK_TIMEOUT_MS
        );
        timer.unref?.();
      });
      const result = await Promise.race([
        apolloClient.query<SchemaCheckData>({
          query: SPACE_FIELD_SCHEMA_QUERY,
          fetchPolicy: "network-only",
        }),
        timeout,
      ]);
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
      return recordSpaceFieldSupport({ supported });
    } catch (error: unknown) {
      const kept = lastConfirmedSpaceFieldSupport();
      debug(
        "archive-fallback",
        `Schema check failed; ${kept ? "keeping the last good answer" : "stripping all optional space fields"} for a few minutes:`,
        error instanceof Error ? error.message : error
      );
      return recordSpaceFieldSupport({ failed: true });
    } finally {
      if (timer) clearTimeout(timer);
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

/**
 * Whether an error is the server rejecting the query document itself
 * (`extensions.code === "GRAPHQL_VALIDATION_FAILED"`), parsed by Apollo or
 * still in the raw body of a non-2xx response. Keyed on the code, not the
 * message wording.
 */
export function isValidationFailure(error: unknown): boolean {
  const VALIDATION = "GRAPHQL_VALIDATION_FAILED";
  if (CombinedGraphQLErrors.is(error)) {
    return error.errors.some((e) => e.extensions?.code === VALIDATION);
  }
  if (ServerError.is(error)) {
    try {
      const body = JSON.parse(error.bodyText) as {
        errors?: Array<{ extensions?: { code?: unknown } }>;
      };
      return Boolean(body.errors?.some((e) => e.extensions?.code === VALIDATION));
    } catch {
      return false;
    }
  }
  return false;
}

export type SpaceFieldQueryResult<TData> = ApolloClient.QueryResult<TData> & {
  /** Optional space fields that were stripped (the API lacks them, or might). */
  omittedFields: readonly string[];
};

/**
 * Run `query` with the optional space fields the API lacks stripped out.
 * Results carry no value for an omitted field, which every reader treats as
 * "active, replaces nothing, removal time unknown".
 *
 * When the schema check has an answer (the usual case) the
 * `apolloClient.query` call is made synchronously, so callers that start
 * several queries together keep their order.
 */
export function queryWithArchiveFallback<TData>(
  query: DocumentNode,
  variables?: Record<string, unknown>
): Promise<SpaceFieldQueryResult<TData>> {
  const send = (omittedFields: readonly string[]) =>
    apolloClient.query<TData>({
      query: stripFields(query, omittedFields),
      ...(variables ? { variables } : {}),
      fetchPolicy: "network-only",
    } as ApolloClient.QueryOptions<TData>) as Promise<ApolloClient.QueryResult<TData>>;

  const run = async (supported: ReadonlySet<string>): Promise<SpaceFieldQueryResult<TData>> => {
    const omittedFields = SPACE_ARCHIVE_FIELD_NAMES.filter((name) => !supported.has(name));
    const selectsOptional = omittedFields.length < SPACE_ARCHIVE_FIELD_NAMES.length;
    let rejected: unknown;
    try {
      const result = await send(omittedFields);
      if (!(selectsOptional && isValidationFailure(result.error))) {
        return Object.assign({}, result, { omittedFields });
      }
      rejected = result.error;
    } catch (error: unknown) {
      if (!(selectsOptional && isValidationFailure(error))) throw error;
      rejected = error;
    }
    // The API rejected fields the check said it had: drop the answer (the
    // next query re-checks) and retry once with every optional field gone.
    debug(
      "archive-fallback",
      "Query rejected as invalid; retrying without optional space fields:",
      rejected instanceof Error ? rejected.message : rejected
    );
    resetSpaceFieldSupport();
    const retry = await send(SPACE_ARCHIVE_FIELD_NAMES);
    return Object.assign({}, retry, { omittedFields: [...SPACE_ARCHIVE_FIELD_NAMES] });
  };

  const fresh = freshSpaceFieldSupport();
  if (fresh) return run(fresh);
  const stale = lastConfirmedSpaceFieldSupport();
  if (stale) {
    // Stale-while-revalidate: answer now, re-check in the background.
    void checkSpaceFieldSupport();
    return run(stale);
  }
  return checkSpaceFieldSupport().then(run);
}
