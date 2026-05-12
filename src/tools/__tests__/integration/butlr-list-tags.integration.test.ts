import { describe, it, expect, beforeEach, vi } from "vitest";
import { CombinedGraphQLErrors } from "@apollo/client/errors";
import { executeListTags } from "../../butlr-list-tags.js";
import { apolloClient } from "../../../clients/graphql-client.js";
import { clearTopologyCache } from "../../../cache/topology-cache.js";
import { loadGraphQLFixture } from "../../../__mocks__/apollo-client.js";

vi.mock("../../../clients/graphql-client.js", () => ({
  apolloClient: {
    query: vi.fn(),
  },
}));

describe("butlr_list_tags - Integration", () => {
  beforeEach(() => {
    // mockReset (not just clearAllMocks) is required to drain leftover
    // `mockResolvedValueOnce` entries between tests — clearAllMocks
    // resets call history but not the once-queue. Today this file uses
    // `mockResolvedValue` (not `Once`) so leakage is bounded, but a
    // future test that adds a once-queued chain would otherwise leak
    // into the next test under `clearAllMocks` alone.
    vi.mocked(apolloClient.query).mockReset();
    // Defensive symmetry with the topology-test setup. `executeListTags`
    // doesn't read the topology cache today, but if it ever did (e.g. a
    // future include_topology_context flag), a stale cache from another
    // worker's prior run would silently contaminate this suite.
    clearTopologyCache();
  });

  describe("Default (no args)", () => {
    it("returns all tags with footprint counts across rooms, zones, floors", async () => {
      const fixture = loadGraphQLFixture("tags-list");

      vi.mocked(apolloClient.query).mockResolvedValue({
        data: fixture,
        loading: false,
        networkStatus: 7,
      } as never);

      const result = await executeListTags({});

      expect(result.total).toBe(5);
      expect(result.tags).toHaveLength(5);

      const videoconf = result.tags.find((t) => t.name === "videoconf");
      expect(videoconf).toBeDefined();
      expect(videoconf?.id).toBe("tag_000001");
      expect(videoconf?.applied_to).toEqual({ rooms: 0, zones: 3, floors: 0 });

      const huddle = result.tags.find((t) => t.name === "huddle");
      expect(huddle?.applied_to).toEqual({ rooms: 2, zones: 1, floors: 1 });
    });

    it("includes a timestamp in ISO-8601 format", async () => {
      const fixture = loadGraphQLFixture("tags-list");
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: fixture,
        loading: false,
        networkStatus: 7,
      } as never);

      const result = await executeListTags({});

      expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it("sorts tags by total usage descending", async () => {
      const fixture = loadGraphQLFixture("tags-list");
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: fixture,
        loading: false,
        networkStatus: 7,
      } as never);

      const result = await executeListTags({});

      // Totals: huddle=4, videoconf=3, focus=2, videoconf-large=1, unused-tag=0
      expect(result.tags.map((t) => t.name)).toEqual([
        "huddle",
        "videoconf",
        "focus",
        "videoconf-large",
        "unused-tag",
      ]);
    });
  });

  describe("name_contains filter", () => {
    it("filters tags by case-insensitive substring", async () => {
      const fixture = loadGraphQLFixture("tags-list");
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: fixture,
        loading: false,
        networkStatus: 7,
      } as never);

      const result = await executeListTags({ name_contains: "VIDEOCONF" });

      // Matches videoconf and videoconf-large (case-insensitive)
      const names = result.tags.map((t) => t.name).sort();
      expect(names).toEqual(["videoconf", "videoconf-large"]);
      expect(result.total).toBe(2);
    });

    it("returns empty list when no tags match", async () => {
      const fixture = loadGraphQLFixture("tags-list");
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: fixture,
        loading: false,
        networkStatus: 7,
      } as never);

      const result = await executeListTags({ name_contains: "nonexistent-xyz" });

      expect(result.tags).toEqual([]);
      expect(result.total).toBe(0);
    });
  });

  describe("min_usage filter", () => {
    it("excludes tags whose total application count is below the threshold", async () => {
      const fixture = loadGraphQLFixture("tags-list");
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: fixture,
        loading: false,
        networkStatus: 7,
      } as never);

      const result = await executeListTags({ min_usage: 3 });

      // Only videoconf(3) and huddle(4) meet threshold; focus(2), videoconf-large(1), unused-tag(0) excluded
      expect(result.tags.map((t) => t.name).sort()).toEqual(["huddle", "videoconf"]);
      expect(result.total).toBe(2);
    });

    it("min_usage of 1 excludes only entirely unused tags", async () => {
      const fixture = loadGraphQLFixture("tags-list");
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: fixture,
        loading: false,
        networkStatus: 7,
      } as never);

      const result = await executeListTags({ min_usage: 1 });

      expect(result.tags.find((t) => t.name === "unused-tag")).toBeUndefined();
      expect(result.total).toBe(4);
    });
  });

  describe("include_entities flag", () => {
    it("omits applied_to_entities by default", async () => {
      const fixture = loadGraphQLFixture("tags-list");
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: fixture,
        loading: false,
        networkStatus: 7,
      } as never);

      const result = await executeListTags({});

      for (const tag of result.tags) {
        expect(tag.applied_to_entities).toBeUndefined();
      }
    });

    it("returns id and name for every tagged room, zone, and floor when true", async () => {
      const fixture = loadGraphQLFixture("tags-list");
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: fixture,
        loading: false,
        networkStatus: 7,
      } as never);

      const result = await executeListTags({ include_entities: true });

      const huddle = result.tags.find((t) => t.name === "huddle");
      expect(huddle?.applied_to_entities).toEqual({
        rooms: [
          { id: "room_000001", name: "Huddle Room A" },
          { id: "room_000002", name: "Huddle Room B" },
        ],
        zones: [{ id: "zone_000005", name: "Huddle Zone" }],
        floors: [{ id: "space_000001", name: "Huddle Floor" }],
      });
      // counts and entities stay consistent
      expect(huddle?.applied_to.rooms).toBe(huddle?.applied_to_entities?.rooms.length);
      expect(huddle?.applied_to.zones).toBe(huddle?.applied_to_entities?.zones.length);
      expect(huddle?.applied_to.floors).toBe(huddle?.applied_to_entities?.floors.length);
    });

    it("returns empty arrays for tags with no associations", async () => {
      const fixture = loadGraphQLFixture("tags-list");
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: fixture,
        loading: false,
        networkStatus: 7,
      } as never);

      const result = await executeListTags({ include_entities: true });

      const unused = result.tags.find((t) => t.name === "unused-tag");
      expect(unused?.applied_to_entities).toEqual({ rooms: [], zones: [], floors: [] });
    });

    // a dangling tag→entity association (deleted entity, partial
    // GraphQL response) should be elided from both `applied_to_entities` and
    // the `applied_to` count, not surfaced as { id: null } / inflated counts.
    it("drops dangling tagged-entity refs (null id) from entities and counts", async () => {
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: {
          tags: [
            {
              __typename: "Tag",
              id: "tag_dirty",
              name: "dirty",
              organization_id: "org_dirty",
              rooms: [
                { __typename: "Room", id: "room_real", name: "Real Room" },
                { __typename: "Room", id: null, name: null },
                { __typename: "Room", id: "" },
              ],
              zones: [{ __typename: "Zone", id: "zone_real" }],
              floors: [],
            },
          ],
        },
        loading: false,
        networkStatus: 7,
      } as never);

      const result = await executeListTags({ include_entities: true });

      const dirty = result.tags.find((t) => t.name === "dirty");
      expect(dirty?.applied_to_entities?.rooms).toEqual([{ id: "room_real", name: "Real Room" }]);
      expect(dirty?.applied_to_entities?.zones).toEqual([{ id: "zone_real" }]);
      // Counts must agree with the filtered entity arrays
      expect(dirty?.applied_to).toEqual({ rooms: 1, zones: 1, floors: 0 });
    });

    it("composes with name_contains filter", async () => {
      const fixture = loadGraphQLFixture("tags-list");
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: fixture,
        loading: false,
        networkStatus: 7,
      } as never);

      const result = await executeListTags({
        include_entities: true,
        name_contains: "huddle",
      });

      expect(result.tags).toHaveLength(1);
      expect(result.tags[0].applied_to_entities?.rooms).toHaveLength(2);
    });
  });

  describe("Empty org", () => {
    it("returns total=0 and empty tags array when org has no tags", async () => {
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: { tags: [] },
        loading: false,
        networkStatus: 7,
      } as never);

      const result = await executeListTags({});

      expect(result.tags).toEqual([]);
      expect(result.total).toBe(0);
    });

    // Contract: `null` is NOT a legitimate empty signal. The schema must
    // send `[]` when no tags exist. Treating `null` as empty would
    // silently launder a serialisation regression.
    it("throws INTERNAL_ERROR on a null tags response from the API", async () => {
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: { tags: null },
        loading: false,
        networkStatus: 7,
      } as never);

      await expect(executeListTags({})).rejects.toThrow(/\[INTERNAL_ERROR\].*expected array.*null/);
    });
  });

  describe("Error translation", () => {
    it("translates a GraphQL auth error into a user-facing message", async () => {
      vi.mocked(apolloClient.query).mockRejectedValue({
        networkError: { statusCode: 401, message: "Unauthorized" },
      });

      await expect(executeListTags({})).rejects.toThrow(/Authentication failed/i);
    });

    it("throws on a CombinedGraphQLErrors result.error rather than coercing data:null to []", async () => {
      // Apollo Client 4.x with errorPolicy:'all' resolves with `result.error`
      // populated. Without explicit handling, the tool would silently report
      // an empty org instead of surfacing the failure.
      const combined = new CombinedGraphQLErrors(
        { data: { tags: null }, errors: [{ message: "Forbidden" }] },
        [{ message: "Forbidden", extensions: { code: "UNAUTHENTICATED" } }]
      );

      vi.mocked(apolloClient.query).mockResolvedValueOnce({
        data: { tags: null },
        error: combined,
        loading: false,
        networkStatus: 8,
      } as never);

      await expect(executeListTags({})).rejects.toThrow(/\[AUTH_EXPIRED\]/);
    });
  });

  // T2 — filtered_by surface
  describe("filtered_by surface", () => {
    it("omits filtered_by entirely when no filters were supplied", async () => {
      const fixture = loadGraphQLFixture("tags-list");
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: fixture,
        loading: false,
        networkStatus: 7,
      } as never);

      const result = await executeListTags({});

      expect(result.filtered_by).toBeUndefined();
    });

    it("omits filtered_by when only include_entities:false (the schema default) was supplied", async () => {
      const fixture = loadGraphQLFixture("tags-list");
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: fixture,
        loading: false,
        networkStatus: 7,
      } as never);

      const result = await executeListTags({ include_entities: false });

      expect(result.filtered_by).toBeUndefined();
    });

    it("emits filtered_by when include_entities:true is the only explicit filter", async () => {
      const fixture = loadGraphQLFixture("tags-list");
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: fixture,
        loading: false,
        networkStatus: 7,
      } as never);

      const result = await executeListTags({ include_entities: true });

      expect(result.filtered_by).toEqual({ include_entities: true });
    });
  });

  // T4 — min_usage:0 boundary. A regression switching `>=` to `>` would
  // silently drop zero-usage tags.
  describe("min_usage:0 boundary", () => {
    it("includes zero-usage tags when min_usage is 0", async () => {
      const fixture = loadGraphQLFixture("tags-list");
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: fixture,
        loading: false,
        networkStatus: 7,
      } as never);

      const result = await executeListTags({ min_usage: 0 });

      // unused-tag has total usage 0; must NOT be filtered out.
      expect(result.tags.find((t) => t.name === "unused-tag")).toBeDefined();
    });
  });

  // T5 — filter composition. Sequential filter application can be
  // order-sensitive; existing tests cover pairs only.
  describe("Filter composition", () => {
    it("applies min_usage AND name_contains AND include_entities together", async () => {
      const fixture = loadGraphQLFixture("tags-list");
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: fixture,
        loading: false,
        networkStatus: 7,
      } as never);

      // huddle has usage 4 (2 rooms + 1 zone + 1 floor); only it survives
      // name_contains:"huddle" AND min_usage:3.
      const result = await executeListTags({
        name_contains: "huddle",
        min_usage: 3,
        include_entities: true,
      });

      expect(result.tags).toHaveLength(1);
      expect(result.tags[0].name).toBe("huddle");
      expect(result.tags[0].applied_to_entities).toBeDefined();
    });
  });

  // T3 — non-array tags payload throws INTERNAL_ERROR (boundary contract).
  describe("Non-array tags shape rejection", () => {
    it("throws INTERNAL_ERROR when data.tags is an object", async () => {
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: { tags: {} },
        loading: false,
        networkStatus: 7,
      } as never);

      await expect(executeListTags({})).rejects.toThrow(/\[INTERNAL_ERROR\].*expected array/);
    });

    it("surfaces a malformed_tag_rows warning when upstream returns rows with non-string name", async () => {
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: {
          tags: [
            { id: "tag_a", name: "huddle", rooms: [], zones: [], floors: [] },
            { id: "tag_b", name: null, rooms: [], zones: [], floors: [] },
          ],
        },
        loading: false,
        networkStatus: 7,
      } as never);

      const result = await executeListTags({ name_contains: "huddle" });

      // Doesn't crash on null.name; resolves with the valid row and a warning.
      expect(result.tags).toHaveLength(1);
      expect(result.warning).toMatch(/1 tag row\(s\) skipped/);
    });
  });
});
