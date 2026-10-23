import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { gql } from "@apollo/client";
import { print } from "graphql";
import { CombinedGraphQLErrors } from "@apollo/client/errors";
import { apolloClient } from "./graphql-client.js";
import {
  SPACE_FIELD_RECHECK_MS,
  SPACE_FIELD_SCHEMA_QUERY,
  checkSpaceFieldSupport,
  primeSpaceFieldSupport,
  queryWithArchiveFallback,
  resetSpaceFieldSupport,
  stripArchiveFields,
  stripFields,
} from "./archive-fallback.js";
import { SPACE_FIELD_FAILURE_RECHECK_MS } from "./space-field-support.js";

vi.mock("./graphql-client.js", () => ({
  apolloClient: {
    query: vi.fn(),
  },
}));

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

/** apolloClient.query answers the schema check with `check`, everything else with OK. */
function mockApi(check: unknown) {
  vi.mocked(apolloClient.query).mockImplementation((async (opts: { query: unknown }) => {
    if (opts.query === SPACE_FIELD_SCHEMA_QUERY) {
      if (check instanceof Error) throw check;
      return check;
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

describe("stripFields / stripArchiveFields", () => {
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
    const printed = print(stripArchiveFields(doc));
    expect(printed).not.toMatch(/archivedAt|replacesID|sensorsRemovedAt/);
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
    // Only the named field goes.
    const onlyRemoval = print(stripFields(doc, ["sensorsRemovedAt"]));
    expect(onlyRemoval).toMatch(/archivedAt/);
    expect(onlyRemoval).not.toMatch(/sensorsRemovedAt/);
    // The input document is not mutated.
    expect(print(doc)).toMatch(/sensorsRemovedAt/);
  });

  it("is memoized per document and field set, and a no-op for no fields", () => {
    expect(stripArchiveFields(QUERY)).toBe(stripArchiveFields(QUERY));
    expect(stripFields(QUERY, ["replacesID", "archivedAt"])).toBe(
      stripFields(QUERY, ["archivedAt", "replacesID"])
    );
    expect(stripFields(QUERY, [])).toBe(QUERY);
  });
});

describe("schema check", () => {
  beforeEach(() => {
    resetSpaceFieldSupport();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a field only when both Room and Zone have it", async () => {
    mockApi(schema(["archivedAt", "replacesID", "sensorsRemovedAt"], ["archivedAt", "replacesID"]));

    const result = await queryWithArchiveFallback(QUERY);

    expect(result.omittedFields).toEqual(["sensorsRemovedAt"]);
    expect(result.data).toEqual(OK.data);
    const [sent] = sentQueries();
    expect(sent).toMatch(/archivedAt/);
    expect(sent).not.toMatch(/sensorsRemovedAt/);
  });

  it("sends the query as written when the API has every field", async () => {
    mockApi(schema(["archivedAt", "replacesID", "sensorsRemovedAt"]));

    const result = await queryWithArchiveFallback(QUERY, { id: "x" });

    expect(result.omittedFields).toEqual([]);
    const call = vi.mocked(apolloClient.query).mock.calls.find((c) => c[0].query === QUERY);
    expect(call?.[0]).toMatchObject({ variables: { id: "x" }, fetchPolicy: "network-only" });
  });

  it("strips every optional field on an API that predates them", async () => {
    mockApi(schema([]));

    const result = await queryWithArchiveFallback(QUERY);

    expect(result.omittedFields).toEqual(["archivedAt", "replacesID", "sensorsRemovedAt"]);
    expect(sentQueries()[0]).not.toMatch(/archivedAt|replacesID|sensorsRemovedAt/);
  });

  it("checks the schema once, shares an in-flight check, and re-checks hourly", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
    mockApi(schema([]));

    await Promise.all([queryWithArchiveFallback(QUERY), queryWithArchiveFallback(QUERY)]);
    await queryWithArchiveFallback(QUERY);
    expect(schemaChecks()).toBe(1);

    // The API deploys; an hour later the check runs again and sees it.
    mockApi(schema(["archivedAt", "replacesID", "sensorsRemovedAt"]));
    vi.setSystemTime(new Date(Date.now() + SPACE_FIELD_RECHECK_MS + 1));
    const later = await queryWithArchiveFallback(QUERY);

    expect(schemaChecks()).toBe(2);
    expect(later.omittedFields).toEqual([]);
  });

  it("strips everything when the check fails, and retries the check after a few minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
    mockApi(new Error("introspection disabled"));

    const first = await queryWithArchiveFallback(QUERY);
    expect(first.omittedFields).toHaveLength(3);

    mockApi(schema(["archivedAt", "replacesID", "sensorsRemovedAt"]));
    vi.setSystemTime(new Date(Date.now() + SPACE_FIELD_FAILURE_RECHECK_MS + 1));
    const second = await queryWithArchiveFallback(QUERY);
    expect(second.omittedFields).toEqual([]);
  });

  it("treats a check answered with GraphQL errors as a failure", async () => {
    mockApi({
      data: undefined,
      error: new CombinedGraphQLErrors({ errors: [{ message: "nope" }] }),
    });

    await expect(checkSpaceFieldSupport()).resolves.toEqual(new Set());
  });

  it("returns errors from the main query unchanged", async () => {
    primeSpaceFieldSupport();
    const partial = {
      data: undefined,
      error: new CombinedGraphQLErrors({ errors: [{ message: "boom" }] }),
    };
    vi.mocked(apolloClient.query).mockResolvedValue(partial as never);

    const result = await queryWithArchiveFallback(QUERY);
    expect(result.error).toBe(partial.error);
    expect(result.omittedFields).toEqual([]);

    vi.mocked(apolloClient.query).mockRejectedValue(new Error("Network timeout"));
    await expect(queryWithArchiveFallback(QUERY)).rejects.toThrow("Network timeout");
    expect(schemaChecks()).toBe(0);
  });
});
