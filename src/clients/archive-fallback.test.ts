import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { gql } from "@apollo/client";
import { print } from "graphql";
import { CombinedGraphQLErrors, ServerError } from "@apollo/client/errors";
import { apolloClient } from "./graphql-client.js";
import {
  ARCHIVE_FIELDS_RETRY_MS,
  isMissingArchiveFieldsError,
  queryWithArchiveFallback,
  resetArchiveFieldSupport,
  stripArchiveFields,
} from "./archive-fallback.js";

vi.mock("./graphql-client.js", () => ({
  apolloClient: {
    query: vi.fn(),
  },
}));

const EXTENDED = gql`
  query Extended {
    rooms {
      data {
        id
        archivedAt
        replacesID
      }
    }
  }
`;
const LEGACY = stripArchiveFields(EXTENDED);

// The message gqlparser (the API's validator) emits for an unknown field.
const VALIDATION_MESSAGE = 'Cannot query field "archivedAt" on type "Room".';

function validationErrors(message = VALIDATION_MESSAGE) {
  return new CombinedGraphQLErrors({ errors: [{ message }] });
}

const OK = { data: { rooms: { data: [{ id: "room_1" }] } } };

function queriesSent(): unknown[] {
  return vi.mocked(apolloClient.query).mock.calls.map((c) => c[0].query);
}

describe("isMissingArchiveFieldsError", () => {
  it("matches a GraphQL validation error on archivedAt or replacesID", () => {
    expect(isMissingArchiveFieldsError(validationErrors())).toBe(true);
    expect(
      isMissingArchiveFieldsError(
        validationErrors('Cannot query field "replacesID" on type "Zone".')
      )
    ).toBe(true);
  });

  it("matches the raw body of a plain-JSON 422 the client did not parse", () => {
    const body = JSON.stringify({ errors: [{ message: VALIDATION_MESSAGE }], data: null });
    const error = new ServerError("Response not successful: Received status code 422", {
      response: new Response(body, { status: 422 }),
      bodyText: body,
    });
    expect(isMissingArchiveFieldsError(error)).toBe(true);
  });

  it("matches the legacy { graphQLErrors } shape", () => {
    expect(isMissingArchiveFieldsError({ graphQLErrors: [{ message: VALIDATION_MESSAGE }] })).toBe(
      true
    );
  });

  it("does not match unrelated errors, including others that mention the field", () => {
    expect(isMissingArchiveFieldsError(undefined)).toBe(false);
    expect(isMissingArchiveFieldsError(new Error("Network timeout"))).toBe(false);
    expect(
      isMissingArchiveFieldsError(validationErrors('Cannot query field "foo" on type "Room".'))
    ).toBe(false);
    // A resolver failure on a field the schema DOES have is not a reason to
    // drop the fields.
    expect(isMissingArchiveFieldsError(validationErrors("failed to resolve archivedAt"))).toBe(
      false
    );
  });
});

describe("stripArchiveFields", () => {
  it("removes archivedAt/replacesID at every depth and keeps everything else", () => {
    const doc = gql`
      query Topo($id: ID!) {
        floor(id: $id) {
          id
          rooms {
            id
            name
            archivedAt
            replacesID
          }
          zones {
            id
            archivedAt
            replacesID
            sensors {
              id
            }
          }
        }
      }
    `;
    const printed = print(stripArchiveFields(doc));
    expect(printed).not.toMatch(/archivedAt|replacesID/);
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
    // The input document is not mutated.
    expect(print(doc)).toMatch(/archivedAt/);
  });

  it("returns the same stripped document on every call", () => {
    expect(stripArchiveFields(EXTENDED)).toBe(stripArchiveFields(EXTENDED));
    expect(stripArchiveFields(EXTENDED)).not.toBe(EXTENDED);
  });
});

describe("queryWithArchiveFallback", () => {
  beforeEach(() => {
    resetArchiveFieldSupport();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends only the extended query when the API supports the fields", async () => {
    vi.mocked(apolloClient.query).mockResolvedValue(OK as never);

    const result = await queryWithArchiveFallback(EXTENDED, { id: "x" });

    expect(result).toBe(OK);
    expect(queriesSent()).toEqual([EXTENDED]);
    expect(vi.mocked(apolloClient.query).mock.calls[0][0]).toMatchObject({
      variables: { id: "x" },
      fetchPolicy: "network-only",
    });
  });

  it("falls back once on a validation error in the result, then skips the extended query", async () => {
    vi.mocked(apolloClient.query).mockImplementation((async (opts: { query: unknown }) =>
      opts.query === EXTENDED ? { data: undefined, error: validationErrors() } : OK) as never);

    const first = await queryWithArchiveFallback(EXTENDED);
    expect(first).toBe(OK);
    expect(queriesSent()).toEqual([EXTENDED, LEGACY]);

    const second = await queryWithArchiveFallback(EXTENDED);
    expect(second).toBe(OK);
    // Remembered: the second call does not pay for a failed round trip.
    expect(queriesSent()).toEqual([EXTENDED, LEGACY, LEGACY]);
  });

  it("falls back when the extended query rejects with the validation error", async () => {
    vi.mocked(apolloClient.query).mockImplementation((async (opts: { query: unknown }) => {
      if (opts.query === EXTENDED) throw validationErrors();
      return OK;
    }) as never);

    await expect(queryWithArchiveFallback(EXTENDED)).resolves.toBe(OK);
    expect(queriesSent()).toEqual([EXTENDED, LEGACY]);
  });

  it("probes the extended query again after the retry window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T12:00:00Z"));
    vi.mocked(apolloClient.query).mockImplementation((async (opts: { query: unknown }) =>
      opts.query === EXTENDED ? { data: undefined, error: validationErrors() } : OK) as never);

    await queryWithArchiveFallback(EXTENDED);
    vi.setSystemTime(new Date(Date.now() + ARCHIVE_FIELDS_RETRY_MS + 1));
    // The API has deployed in the meantime.
    vi.mocked(apolloClient.query).mockResolvedValue(OK as never);
    await queryWithArchiveFallback(EXTENDED);

    expect(queriesSent()).toEqual([EXTENDED, LEGACY, EXTENDED]);
  });

  it("returns unrelated errors unchanged without falling back", async () => {
    const partial = { data: undefined, error: validationErrors("Internal server error") };
    vi.mocked(apolloClient.query).mockResolvedValue(partial as never);

    await expect(queryWithArchiveFallback(EXTENDED)).resolves.toBe(partial);
    expect(queriesSent()).toEqual([EXTENDED]);
  });

  it("rethrows unrelated rejections without falling back", async () => {
    vi.mocked(apolloClient.query).mockRejectedValue(new Error("Network timeout"));

    await expect(queryWithArchiveFallback(EXTENDED)).rejects.toThrow("Network timeout");
    expect(queriesSent()).toEqual([EXTENDED]);
  });
});
