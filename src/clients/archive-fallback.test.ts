import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { gql } from "@apollo/client";
import { print } from "graphql";
import { CombinedGraphQLErrors, ServerError } from "@apollo/client/errors";
import { apolloClient } from "./graphql-client.js";
import {
  SPACE_FIELD_SCHEMA_QUERY,
  checkSpaceFieldSupport,
  isValidationFailure,
  queryWithArchiveFallback,
  stripFields,
} from "./archive-fallback.js";
import {
  freshSpaceFieldSupport,
  primeSpaceFieldSupport,
  resetSpaceFieldSupport,
} from "./space-field-support.js";
import { SPACE_ARCHIVE_FIELD_NAMES } from "./queries/archive-fields.js";

vi.mock("./graphql-client.js", () => ({
  apolloClient: {
    query: vi.fn(),
  },
}));

const HOUR_MS = 60 * 60 * 1000;
const FIVE_MIN_MS = 5 * 60 * 1000;
const ALL = ["archivedAt", "replacesID", "sensorsRemovedAt"];

const QUERY = gql`
  query Rooms {
    rooms {
      data {
        id
        archivedAt
        replacesID
        sensorsRemovedAt
      }
    }
  }
`;

const OK = { data: { rooms: { data: [{ id: "room_1" }] } } };

/** A schema-check answer whose Room and Zone have these optional fields. */
function schema(roomFields: string[], zoneFields: string[] = roomFields) {
  const fields = (names: string[]) => [{ name: "id" }, ...names.map((name) => ({ name }))];
  return { data: { room: { fields: fields(roomFields) }, zone: { fields: fields(zoneFields) } } };
}

/** What the API answers a document that selects a field its schema lacks. */
function validationError() {
  return new CombinedGraphQLErrors({
    errors: [
      {
        message: 'Cannot query field "archivedAt" on type "Room".',
        extensions: { code: "GRAPHQL_VALIDATION_FAILED" },
      },
    ],
  });
}

/**
 * apolloClient.query answers the schema check with `check`, a query that
 * still selects optional fields with `full`, and anything else with OK.
 */
function mockApi(check: unknown, full: unknown = OK) {
  vi.mocked(apolloClient.query).mockImplementation((async (opts: { query: unknown }) => {
    if (opts.query === SPACE_FIELD_SCHEMA_QUERY) {
      if (check instanceof Error) throw check;
      return check;
    }
    const body = print(opts.query as never);
    if (/archivedAt|replacesID|sensorsRemovedAt/.test(body)) {
      if (full instanceof Error) throw full;
      return full;
    }
    return OK;
  }) as never);
}

function sentQueries(): string[] {
  return vi
    .mocked(apolloClient.query)
    .mock.calls.map((c) => c[0].query)
    .filter((q) => q !== SPACE_FIELD_SCHEMA_QUERY)
    .map((q) => print(q as never));
}

function schemaChecks(): number {
  return vi
    .mocked(apolloClient.query)
    .mock.calls.filter((c) => c[0].query === SPACE_FIELD_SCHEMA_QUERY).length;
}

/** Let background (stale-while-revalidate) checks settle. */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe("stripFields", () => {
  it("removes the named fields at every depth and keeps everything else", () => {
    const doc = gql`
      query Topo($id: ID!) {
        floor(id: $id) {
          id
          rooms {
            id
            name
            archivedAt
            replacesID
            sensorsRemovedAt
          }
          zones {
            id
            archivedAt
            sensors {
              id
            }
          }
        }
      }
    `;
    const printed = print(stripFields(doc, SPACE_ARCHIVE_FIELD_NAMES));
    expect(printed).toBe(
      print(gql`
        query Topo($id: ID!) {
          floor(id: $id) {
            id
            rooms {
              id
              name
            }
            zones {
              id
              sensors {
                id
              }
            }
          }
        }
      `)
    );
    const onlyRemoval = print(stripFields(doc, ["sensorsRemovedAt"]));
    expect(onlyRemoval).toMatch(/archivedAt/);
    expect(onlyRemoval).not.toMatch(/sensorsRemovedAt/);
    // The input document is not mutated.
    expect(print(doc)).toMatch(/sensorsRemovedAt/);
  });

  it("is memoized per document and field set, and a no-op for no fields", () => {
    expect(stripFields(QUERY, ALL)).toBe(stripFields(QUERY, ALL));
    expect(stripFields(QUERY, ["replacesID", "archivedAt"])).toBe(
      stripFields(QUERY, ["archivedAt", "replacesID"])
    );
    expect(stripFields(QUERY, [])).toBe(QUERY);
  });
});

describe("isValidationFailure", () => {
  it("keys on GRAPHQL_VALIDATION_FAILED, parsed or in a raw body", () => {
    expect(isValidationFailure(validationError())).toBe(true);
    const body = JSON.stringify({
      errors: [{ message: "x", extensions: { code: "GRAPHQL_VALIDATION_FAILED" } }],
    });
    expect(
      isValidationFailure(
        new ServerError("Response not successful: Received status code 422", {
          response: new Response(body, { status: 422 }),
          bodyText: body,
        })
      )
    ).toBe(true);
    expect(
      isValidationFailure(new CombinedGraphQLErrors({ errors: [{ message: "Internal error" }] }))
    ).toBe(false);
    expect(isValidationFailure(new Error("Network timeout"))).toBe(false);
  });
});

describe("schema check", () => {
  beforeEach(() => {
    resetSpaceFieldSupport();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a field only when both Room and Zone have it", async () => {
    mockApi(schema(ALL, ["archivedAt", "replacesID"]));

    const result = await queryWithArchiveFallback(QUERY);

    expect(result.omittedFields).toEqual(["sensorsRemovedAt"]);
    expect(result.data).toEqual(OK.data);
    const [sent] = sentQueries();
    expect(sent).toMatch(/archivedAt/);
    expect(sent).not.toMatch(/sensorsRemovedAt/);
  });

  it("sends the query as written when the API has every field", async () => {
    mockApi(schema(ALL));

    const result = await queryWithArchiveFallback(QUERY, { id: "x" });

    expect(result.omittedFields).toEqual([]);
    const call = vi.mocked(apolloClient.query).mock.calls.find((c) => c[0].query === QUERY);
    expect(call?.[0]).toMatchObject({ variables: { id: "x" }, fetchPolicy: "network-only" });
  });

  it("strips every optional field on an API that predates them", async () => {
    mockApi(schema([]));

    const result = await queryWithArchiveFallback(QUERY);

    expect(result.omittedFields).toEqual(ALL);
    expect(sentQueries()[0]).not.toMatch(/archivedAt|replacesID|sensorsRemovedAt/);
  });

  it("checks once, shares an in-flight check, and re-checks after an hour in the background", async () => {
    mockApi(schema([]));

    await Promise.all([queryWithArchiveFallback(QUERY), queryWithArchiveFallback(QUERY)]);
    await queryWithArchiveFallback(QUERY);
    expect(schemaChecks()).toBe(1);

    // 59 minutes later the answer is still fresh.
    vi.setSystemTime(new Date(Date.now() + HOUR_MS - 60_000));
    await queryWithArchiveFallback(QUERY);
    expect(schemaChecks()).toBe(1);

    // The API deploys. Past the hour, the stale answer still serves this
    // call while the re-check runs; the next call sees the new fields.
    mockApi(schema(ALL));
    vi.setSystemTime(new Date(Date.now() + 2 * 60_000));
    const during = await queryWithArchiveFallback(QUERY);
    expect(during.omittedFields).toEqual(ALL);
    await flush();
    expect(schemaChecks()).toBe(2);
    const after = await queryWithArchiveFallback(QUERY);
    expect(after.omittedFields).toEqual([]);
  });

  it("with no good answer yet, a failed check strips everything and retries in 5 minutes", async () => {
    mockApi(new Error("introspection unavailable"));

    const first = await queryWithArchiveFallback(QUERY);
    expect(first.omittedFields).toEqual(ALL);

    mockApi(schema(ALL));
    vi.setSystemTime(new Date(Date.now() + FIVE_MIN_MS + 1));
    // No confirmed answer to serve stale, so this call waits for the check.
    const second = await queryWithArchiveFallback(QUERY);
    expect(second.omittedFields).toEqual([]);
  });

  it("a failed re-check keeps the last good answer instead of switching archive handling off", async () => {
    mockApi(schema(ALL));
    await queryWithArchiveFallback(QUERY);

    mockApi(new Error("503 Service Unavailable"));
    vi.setSystemTime(new Date(Date.now() + HOUR_MS + 1));
    await checkSpaceFieldSupport();

    expect(freshSpaceFieldSupport()).toEqual(new Set(ALL));
    const result = await queryWithArchiveFallback(QUERY);
    expect(result.omittedFields).toEqual([]);
  });

  it("gives the check its own timeout", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.mocked(apolloClient.query).mockImplementation((() => new Promise(() => undefined)) as never);

    const check = checkSpaceFieldSupport();
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(check).resolves.toEqual(new Set());
  });

  it("treats a check answered with GraphQL errors as a failure", async () => {
    mockApi({
      data: undefined,
      error: new CombinedGraphQLErrors({ errors: [{ message: "nope" }] }),
    });

    await expect(checkSpaceFieldSupport()).resolves.toEqual(new Set());
  });
});

describe("validation-failure retry", () => {
  it("drops a cached 'supported' answer and retries once stripped when the API rejects the fields", async () => {
    // The check said yes (a new task), but this query lands on an old task.
    primeSpaceFieldSupport();
    mockApi(schema(ALL), { data: undefined, error: validationError() });

    const result = await queryWithArchiveFallback(QUERY);

    expect(result.error).toBeUndefined();
    expect(result.data).toEqual(OK.data);
    expect(result.omittedFields).toEqual(ALL);
    const sent = sentQueries();
    expect(sent).toHaveLength(2);
    expect(sent[1]).not.toMatch(/archivedAt|replacesID|sensorsRemovedAt/);
    // The answer was dropped, so the next query re-checks the schema.
    expect(freshSpaceFieldSupport()).toBeUndefined();
  });

  it("also retries when the rejection is thrown", async () => {
    primeSpaceFieldSupport();
    mockApi(schema(ALL), validationError());

    const result = await queryWithArchiveFallback(QUERY);
    expect(result.omittedFields).toEqual(ALL);
  });

  it("does not retry when nothing optional was selected, or for other errors", async () => {
    primeSpaceFieldSupport([]);
    vi.mocked(apolloClient.query).mockResolvedValue({
      data: undefined,
      error: validationError(),
    } as never);
    const stripped = await queryWithArchiveFallback(QUERY);
    expect(stripped.error).toBeDefined();
    expect(sentQueries()).toHaveLength(1);

    vi.mocked(apolloClient.query).mockClear();
    primeSpaceFieldSupport();
    const partial = {
      data: undefined,
      error: new CombinedGraphQLErrors({ errors: [{ message: "boom" }] }),
    };
    vi.mocked(apolloClient.query).mockResolvedValue(partial as never);
    const result = await queryWithArchiveFallback(QUERY);
    expect(result.error).toBe(partial.error);
    expect(sentQueries()).toHaveLength(1);

    vi.mocked(apolloClient.query).mockRejectedValue(new Error("Network timeout"));
    await expect(queryWithArchiveFallback(QUERY)).rejects.toThrow("Network timeout");
    expect(schemaChecks()).toBe(0);
  });
});
