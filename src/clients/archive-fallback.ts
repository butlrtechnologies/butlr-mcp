/**
 * Send a query that selects the archive fields (archive-fields.ts), falling
 * back to the same query with those fields stripped when the API does not
 * have them yet.
 *
 * This MCP can ship before the API that adds `archivedAt`/`replacesID` on
 * Room and Zone, and a GraphQL server rejects the whole query when it
 * selects a field the schema lacks. So the query is tried as written first;
 * if the API rejects it for one of these fields, the same query with those
 * selections stripped (`stripArchiveFields`) is sent once and the miss is
 * remembered, so later calls go straight to the stripped query instead of
 * paying a failed round trip each time. The memory expires
 * after an hour, so a long-running server picks the fields up once the API
 * deploys without a restart.
 *
 * Any other error is returned (or thrown) unchanged, exactly as the caller
 * would have seen it from `apolloClient.query`.
 */

import type { ApolloClient } from "@apollo/client";
import { Kind, visit, type DocumentNode } from "graphql";
import { CombinedGraphQLErrors, ServerError } from "@apollo/client/errors";
import { apolloClient } from "./graphql-client.js";
import { SPACE_ARCHIVE_FIELD_NAMES } from "./queries/archive-fields.js";
import { debug } from "../utils/debug.js";

/** How long to skip the extended query after the API rejected it. */
export const ARCHIVE_FIELDS_RETRY_MS = 60 * 60 * 1000;

let skipExtendedUntil = 0;

/** True unless the API recently rejected the archive fields. */
export function archiveFieldsMaybeSupported(now: number = Date.now()): boolean {
  return now >= skipExtendedUntil;
}

/** Forget a remembered rejection. For tests. */
export function resetArchiveFieldSupport(): void {
  skipExtendedUntil = 0;
}

const MISSING_FIELD_PATTERN = new RegExp(
  `Cannot query field \\\\?"(${SPACE_ARCHIVE_FIELD_NAMES.join("|")})\\\\?"`
);

/**
 * Whether an error is the API's schema validation rejecting one of the
 * archive fields (`Cannot query field "archivedAt" on type "Room".`).
 *
 * The message can arrive three ways: as a GraphQL error (the API answers
 * `application/graphql-response+json`, which Apollo parses even on a 4xx),
 * inside a ServerError's raw body (a plain `application/json` 422, which
 * Apollo does not parse), or flattened into an Error message.
 */
export function isMissingArchiveFieldsError(error: unknown): boolean {
  if (!error) return false;

  const texts: string[] = [];
  if (CombinedGraphQLErrors.is(error)) {
    texts.push(...error.errors.map((e) => e.message));
  }
  if (ServerError.is(error)) {
    texts.push(error.bodyText);
  }
  if (error instanceof Error) {
    texts.push(error.message);
  }
  const raw = (error as { graphQLErrors?: Array<{ message?: string }> }).graphQLErrors;
  if (Array.isArray(raw)) {
    texts.push(...raw.map((e) => e.message ?? ""));
  }

  return texts.some((t) => MISSING_FIELD_PATTERN.test(t));
}

const ARCHIVE_FIELD_SET = new Set<string>(SPACE_ARCHIVE_FIELD_NAMES);
const strippedCache = new WeakMap<DocumentNode, DocumentNode>();

/**
 * The same document with every `archivedAt`/`replacesID` field selection
 * removed, for an API that predates them. Memoized per document, so the
 * stripped query is the same object on every call.
 */
export function stripArchiveFields(document: DocumentNode): DocumentNode {
  const cached = strippedCache.get(document);
  if (cached) return cached;
  const stripped = visit(document, {
    [Kind.FIELD](node) {
      // Returning null deletes the node from its selection set.
      return ARCHIVE_FIELD_SET.has(node.name.value) ? null : undefined;
    },
  });
  strippedCache.set(document, stripped);
  return stripped;
}

/**
 * Run `query`, or the same query with the archive fields stripped when the
 * API lacks them. Results from the stripped query carry no
 * `archivedAt`/`replacesID`, which every reader treats as "active, replaces
 * nothing".
 *
 * The first `apolloClient.query` call is made synchronously, before any
 * await, so callers that start several queries together keep their order.
 */
export async function queryWithArchiveFallback<TData>(
  query: DocumentNode,
  variables?: Record<string, unknown>
): Promise<ApolloClient.QueryResult<TData>> {
  const queries = { extended: query, legacy: stripArchiveFields(query) };
  const run = (query: DocumentNode) =>
    apolloClient.query<TData>({
      query,
      ...(variables ? { variables } : {}),
      fetchPolicy: "network-only",
    } as ApolloClient.QueryOptions<TData>) as Promise<ApolloClient.QueryResult<TData>>;

  if (archiveFieldsMaybeSupported()) {
    let result: ApolloClient.QueryResult<TData>;
    try {
      result = await run(queries.extended);
    } catch (error: unknown) {
      if (!isMissingArchiveFieldsError(error)) throw error;
      rememberMissingFields(error);
      return run(queries.legacy);
    }
    if (!isMissingArchiveFieldsError(result.error)) return result;
    rememberMissingFields(result.error);
  }

  return run(queries.legacy);
}

function rememberMissingFields(error: unknown): void {
  skipExtendedUntil = Date.now() + ARCHIVE_FIELDS_RETRY_MS;
  debug(
    "archive-fallback",
    "API does not support archivedAt/replacesID yet; stripping them from queries for the next hour:",
    error instanceof Error ? error.message : error
  );
}
