import { describe, it, expect, beforeEach, vi } from "vitest";
import { CombinedGraphQLErrors } from "@apollo/client/errors";
import { executeListTags } from "../../butlr-list-tags.js";
import { apolloClient } from "../../../clients/graphql-client.js";
import { loadGraphQLFixture } from "../../../__mocks__/apollo-client.js";

vi.mock("../../../clients/graphql-client.js", () => ({
  apolloClient: {
    query: vi.fn(),
  },
}));

describe("butlr_list_tags - Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

    it("handles a null tags response from the API", async () => {
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: { tags: null },
        loading: false,
        networkStatus: 7,
      } as never);

      const result = await executeListTags({});

      expect(result.tags).toEqual([]);
      expect(result.total).toBe(0);
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
});
