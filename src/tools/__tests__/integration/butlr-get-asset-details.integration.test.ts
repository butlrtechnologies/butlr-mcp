import { describe, it, expect, beforeEach, vi } from "vitest";
import { parse, type FieldNode, type OperationDefinitionNode } from "graphql";
import { executeGetAssetDetails } from "../../butlr-get-asset-details.js";
import { apolloClient } from "../../../clients/graphql-client.js";

vi.mock("../../../clients/graphql-client.js", () => ({
  apolloClient: {
    query: vi.fn(),
  },
}));

/**
 * Return the direct field-selection names under the top-level GraphQL field
 * named `rootField` in `querySource`. Used to assert the wire contract of a
 * query without depending on whitespace, field order, or punctuation. A
 * `null` return means the root field itself was not selected.
 */
function directSelectionsOf(querySource: string, rootField: string): string[] | null {
  const ast = parse(querySource);
  for (const def of ast.definitions) {
    if (def.kind !== "OperationDefinition") continue;
    const op = def as OperationDefinitionNode;
    const root = op.selectionSet.selections.find(
      (s): s is FieldNode => s.kind === "Field" && s.name.value === rootField
    );
    if (!root) return null;
    if (!root.selectionSet) return [];
    return root.selectionSet.selections
      .filter((s): s is FieldNode => s.kind === "Field")
      .map((s) => s.name.value);
  }
  return null;
}

describe("butlr_get_asset_details - Integration", () => {
  beforeEach(() => {
    vi.mocked(apolloClient.query).mockReset();
  });

  describe("Basic asset lookup", () => {
    it("returns a room with its scalar metadata", async () => {
      vi.mocked(apolloClient.query).mockResolvedValueOnce({
        data: {
          room: {
            id: "room_100",
            name: "Conference Room A",
            roomType: "meeting",
            customID: "CR-A",
            capacity: { max: 10, mid: 6 },
            area: { value: 200, unit: "sqft" },
            coordinates: [
              [0, 0],
              [1, 1],
            ],
            rotation: 0,
            note: null,
            tags: [],
          },
        },
        loading: false,
        networkStatus: 7,
      } as never);

      const result = await executeGetAssetDetails({
        ids: ["room_100"],
        include_children: true,
        include_devices: false,
        include_parent_context: true,
      });

      expect(result.requested_count).toBe(1);
      expect(result.total_count).toBe(1);
      expect(result.assets).toHaveLength(1);
      const asset = result.assets[0];
      expect(asset.id).toBe("room_100");
      expect(asset.name).toBe("Conference Room A");
      expect(asset._type).toBe("room");
      expect(asset.capacity).toEqual({ max: 10, mid: 6 });
    });
  });

  describe("Tags on rooms, zones, and floors", () => {
    it("returns tags as [{id, name}] for a room with tags", async () => {
      vi.mocked(apolloClient.query).mockResolvedValueOnce({
        data: {
          room: {
            id: "room_lab_01",
            name: "Research Lab A",
            capacity: { max: 12 },
            tags: [
              { id: "tag_research", name: "research" },
              { id: "tag_high_priority", name: "high priority" },
            ],
          },
        },
        loading: false,
        networkStatus: 7,
      } as never);

      const result = await executeGetAssetDetails({
        ids: ["room_lab_01"],
        include_children: true,
        include_devices: false,
        include_parent_context: true,
      });

      const asset = result.assets[0];
      expect(asset.tags).toEqual([
        { id: "tag_research", name: "research" },
        { id: "tag_high_priority", name: "high priority" },
      ]);
    });

    it("returns tags: [] when a room has no tags", async () => {
      vi.mocked(apolloClient.query).mockResolvedValueOnce({
        data: {
          room: {
            id: "room_untagged",
            name: "Untagged Room",
            capacity: { max: 4 },
            tags: [],
          },
        },
        loading: false,
        networkStatus: 7,
      } as never);

      const result = await executeGetAssetDetails({
        ids: ["room_untagged"],
        include_children: true,
        include_devices: false,
        include_parent_context: true,
      });

      const asset = result.assets[0];
      expect(asset.tags).toEqual([]);
    });

    it("returns tags for a zone", async () => {
      vi.mocked(apolloClient.query).mockResolvedValueOnce({
        data: {
          zone: {
            id: "zone_peloton_01",
            name: "Peloton 1",
            roomID: "room_gym",
            capacity: { max: 1 },
            tags: [{ id: "tag_equipment", name: "fitness equipment" }],
          },
        },
        loading: false,
        networkStatus: 7,
      } as never);

      const result = await executeGetAssetDetails({
        ids: ["zone_peloton_01"],
        include_children: true,
        include_devices: false,
        include_parent_context: true,
      });

      const asset = result.assets[0];
      expect(asset.tags).toEqual([{ id: "tag_equipment", name: "fitness equipment" }]);
    });

    it("returns tags for a floor", async () => {
      vi.mocked(apolloClient.query).mockResolvedValueOnce({
        data: {
          floor: {
            id: "space_001",
            name: "Floor 1",
            capacity: { max: 200 },
            tags: [{ id: "tag_amenity", name: "amenity floor" }],
          },
        },
        loading: false,
        networkStatus: 7,
      } as never);

      const result = await executeGetAssetDetails({
        ids: ["space_001"],
        include_children: true,
        include_devices: false,
        include_parent_context: true,
      });

      const asset = result.assets[0];
      expect(asset.tags).toEqual([{ id: "tag_amenity", name: "amenity floor" }]);
    });

    // Buildings and sites do not have a `tags` field in the GraphQL schema
    // (introspected against the live API). Our query for these types does NOT
    // select `tags`, so the response should NOT contain a `tags` key.
    // This pins that contract so a future refactor doesn't accidentally
    // surface a phantom empty `tags: []` on buildings/sites.
    it("does not include tags on building responses (data model: no tags on buildings)", async () => {
      vi.mocked(apolloClient.query).mockResolvedValueOnce({
        data: {
          building: {
            id: "building_001",
            name: "Building",
            capacity: { max: 1000 },
          },
        },
        loading: false,
        networkStatus: 7,
      } as never);

      const result = await executeGetAssetDetails({
        ids: ["building_001"],
        include_children: true,
        include_devices: false,
        include_parent_context: true,
      });

      const asset = result.assets[0];
      expect(asset.tags).toBeUndefined();
      expect("tags" in asset).toBe(false);
    });

    it("does not include tags on site responses (data model: no tags on sites)", async () => {
      vi.mocked(apolloClient.query).mockResolvedValueOnce({
        data: {
          site: {
            id: "site_001",
            name: "HQ",
            timezone: "America/Los_Angeles",
          },
        },
        loading: false,
        networkStatus: 7,
      } as never);

      const result = await executeGetAssetDetails({
        ids: ["site_001"],
        include_children: true,
        include_devices: false,
        include_parent_context: true,
      });

      const asset = result.assets[0];
      expect(asset.tags).toBeUndefined();
      expect("tags" in asset).toBe(false);
    });
  });

  describe("Query shape", () => {
    // GraphQL Document AST inspection: confirm the room/zone/floor queries
    // request `tags { id name }` as a direct child of the top-level field,
    // and confirm the building query does NOT. AST walking is order- and
    // whitespace-agnostic and also catches "tags moved under a nested
    // selection" regressions — a literal-string search would not.
    function captureQueryFor(rootField: "room" | "zone" | "floor" | "building") {
      let captured = "";
      vi.mocked(apolloClient.query).mockImplementation((options: never) => {
        captured =
          (options as { query?: { loc?: { source?: { body?: string } } } })?.query?.loc?.source
            ?.body ?? "";
        return Promise.resolve({
          data: { [rootField]: { id: `${rootField}_x`, name: "x" } },
          loading: false,
          networkStatus: 7,
        } as never);
      });
      return () => captured;
    }

    it("room query selects tags as a direct child of room", async () => {
      const getCaptured = captureQueryFor("room");
      await executeGetAssetDetails({
        ids: ["room_x"],
        include_children: true,
        include_devices: false,
        include_parent_context: true,
      });
      expect(directSelectionsOf(getCaptured(), "room")).toContain("tags");
    });

    it("zone query selects tags as a direct child of zone", async () => {
      const getCaptured = captureQueryFor("zone");
      await executeGetAssetDetails({
        ids: ["zone_x"],
        include_children: true,
        include_devices: false,
        include_parent_context: true,
      });
      expect(directSelectionsOf(getCaptured(), "zone")).toContain("tags");
    });

    it("floor query selects tags as a direct child of floor (not nested under rooms/zones)", async () => {
      const getCaptured = captureQueryFor("floor");
      await executeGetAssetDetails({
        ids: ["space_x"],
        include_children: true,
        include_devices: false,
        include_parent_context: true,
      });
      // Direct child of floor, not buried inside floor.rooms[*]. A future
      // refactor that pushed `tags { id name }` into the nested rooms block
      // but dropped it from the floor would be caught here; a substring
      // regex would not.
      expect(directSelectionsOf(getCaptured(), "floor")).toContain("tags");
    });

    it("building query does NOT select tags (Building schema has no tags field)", async () => {
      const getCaptured = captureQueryFor("building");
      await executeGetAssetDetails({
        ids: ["building_x"],
        include_children: true,
        include_devices: false,
        include_parent_context: true,
      });
      expect(directSelectionsOf(getCaptured(), "building")).not.toContain("tags");
    });
  });

  // Boundary normalization: the MCP tool description guarantees `tags`
  // is always present as an array on room/zone/floor responses. Apollo's
  // `errorPolicy: 'all'` + nullable GraphQL list resolvers can yield
  // `tags: null` or omit the field on partial-error paths. Both shapes
  // must coerce to `[]` so consumers can safely write `asset.tags.length`.
  describe("Tags normalization", () => {
    it("coerces tags: null to []", async () => {
      vi.mocked(apolloClient.query).mockResolvedValueOnce({
        data: { room: { id: "room_n", name: "x", tags: null } },
        loading: false,
        networkStatus: 7,
      } as never);
      const result = await executeGetAssetDetails({
        ids: ["room_n"],
        include_children: true,
        include_devices: false,
        include_parent_context: true,
      });
      expect(result.assets[0].tags).toEqual([]);
    });

    it("coerces missing tags key to [] on a zone response", async () => {
      vi.mocked(apolloClient.query).mockResolvedValueOnce({
        data: { zone: { id: "zone_n", name: "x" } },
        loading: false,
        networkStatus: 7,
      } as never);
      const result = await executeGetAssetDetails({
        ids: ["zone_n"],
        include_children: true,
        include_devices: false,
        include_parent_context: true,
      });
      expect(result.assets[0].tags).toEqual([]);
    });

    it("coerces missing tags key to [] on a floor response", async () => {
      vi.mocked(apolloClient.query).mockResolvedValueOnce({
        data: { floor: { id: "space_n", name: "x" } },
        loading: false,
        networkStatus: 7,
      } as never);
      const result = await executeGetAssetDetails({
        ids: ["space_n"],
        include_children: true,
        include_devices: false,
        include_parent_context: true,
      });
      expect(result.assets[0].tags).toEqual([]);
    });

    it("does NOT inject tags on building responses (no tags in Building schema)", async () => {
      vi.mocked(apolloClient.query).mockResolvedValueOnce({
        data: { building: { id: "building_n", name: "x" } },
        loading: false,
        networkStatus: 7,
      } as never);
      const result = await executeGetAssetDetails({
        ids: ["building_n"],
        include_children: true,
        include_devices: false,
        include_parent_context: true,
      });
      expect("tags" in result.assets[0]).toBe(false);
    });
  });
});
