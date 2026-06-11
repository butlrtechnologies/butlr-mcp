import { describe, it, expect, beforeEach, vi } from "vitest";
import { parse, type FieldNode, type OperationDefinitionNode } from "graphql";
import { executeFetchEntityDetails } from "../../butlr-fetch-entity-details.js";
import { apolloClient } from "../../../clients/graphql-client.js";

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

// Mock the GraphQL client
vi.mock("../../../clients/graphql-client.js", () => ({
  apolloClient: {
    query: vi.fn(),
  },
}));

describe("butlr_fetch_entity_details - Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Single room with default fields", () => {
    it("fetches room with default fields (id, name)", async () => {
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: {
          room: {
            id: "room_100",
            name: "Conference Room A",
          },
        },
        loading: false,
        networkStatus: 7,
      } as any);

      const result = await executeFetchEntityDetails({
        ids: ["room_100"],
      });

      expect(result.entities).toHaveLength(1);
      expect(result.entities[0]).toEqual({
        id: "room_100",
        name: "Conference Room A",
        _type: "room",
      });
      expect(result.requested_count).toBe(1);
      expect(result.fetched_count).toBe(1);
      expect(result.warning).toBeUndefined();
      expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it("fetches room with custom fields", async () => {
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: {
          room: {
            id: "room_100",
            name: "Conference Room A",
            roomType: "meeting",
            capacity: { max: 10, mid: 6 },
          },
        },
        loading: false,
        networkStatus: 7,
      } as any);

      const result = await executeFetchEntityDetails({
        ids: ["room_100"],
        room_fields: ["name", "roomType", "capacity"],
      });

      expect(result.entities[0].roomType).toBe("meeting");
      expect(result.entities[0].capacity).toEqual({ max: 10, mid: 6 });
    });
  });

  describe("Mixed entity types", () => {
    it("fetches room and sensor in one call", async () => {
      // Room query (first call - individual)
      vi.mocked(apolloClient.query)
        .mockResolvedValueOnce({
          data: {
            room: {
              id: "room_100",
              name: "Conference Room A",
            },
          },
          loading: false,
          networkStatus: 7,
        } as any)
        // Sensor query (second call - batch)
        .mockResolvedValueOnce({
          data: {
            sensors: {
              data: [
                {
                  id: "sensor_200",
                  mac_address: "aa:bb:cc:dd:ee:ff",
                },
              ],
            },
          },
          loading: false,
          networkStatus: 7,
        } as any);

      const result = await executeFetchEntityDetails({
        ids: ["room_100", "sensor_200"],
      });

      expect(result.entities).toHaveLength(2);
      expect(result.requested_count).toBe(2);
      expect(result.fetched_count).toBe(2);

      const room = result.entities.find((e) => e._type === "room");
      const sensor = result.entities.find((e) => e._type === "sensor");
      expect(room?.id).toBe("room_100");
      expect(room?.name).toBe("Conference Room A");
      expect(sensor?.id).toBe("sensor_200");
      expect(sensor?.mac_address).toBe("aa:bb:cc:dd:ee:ff");
    });
  });

  describe("Unknown asset type rejection", () => {
    it("throws validation error for unrecognized ID prefix", async () => {
      await expect(executeFetchEntityDetails({ ids: ["foobar_123"] })).rejects.toThrow(
        /Unknown asset type/
      );
    });

    it("throws validation error for IDs without proper prefix", async () => {
      await expect(executeFetchEntityDetails({ ids: ["just-a-string"] })).rejects.toThrow(
        /Unknown asset type/
      );
    });
  });

  describe("Field validation and injection prevention", () => {
    it("rejects invalid field names that look like injections", async () => {
      // The field-validator enforces allowlisted fields for each entity type.
      // A field name like "__proto__" or "foo { bar }" is not in the allowlist.
      await expect(
        executeFetchEntityDetails({
          ids: ["room_100"],
          room_fields: ["__proto__"],
        })
      ).rejects.toThrow(/Invalid field/);
    });

    it("rejects fields not in the entity allowlist", async () => {
      await expect(
        executeFetchEntityDetails({
          ids: ["room_100"],
          room_fields: ["nonexistent_field"],
        })
      ).rejects.toThrow(/Invalid fields for room/);
    });

    it("accepts snake_case aliases (e.g., floor_id normalizes to floorID)", async () => {
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: {
          room: {
            id: "room_100",
            floorID: "space_001",
          },
        },
        loading: false,
        networkStatus: 7,
      } as any);

      const result = await executeFetchEntityDetails({
        ids: ["room_100"],
        room_fields: ["floor_id"],
      });

      // Should succeed (floor_id aliased to floorID)
      expect(result.entities[0].id).toBe("room_100");
    });
  });

  describe("Partial failure", () => {
    it("reports found and not-found entities separately", async () => {
      // First room exists, second does not
      vi.mocked(apolloClient.query)
        .mockResolvedValueOnce({
          data: {
            room: {
              id: "room_100",
              name: "Room A",
            },
          },
          loading: false,
          networkStatus: 7,
        } as any)
        .mockResolvedValueOnce({
          data: {
            room: null, // Not found
          },
          loading: false,
          networkStatus: 7,
        } as any);

      const result = await executeFetchEntityDetails({
        ids: ["room_100", "room_999"],
      });

      expect(result.entities).toHaveLength(2);
      expect(result.fetched_count).toBe(1);
      expect(result.requested_count).toBe(2);

      const found = result.entities.find((e) => e.id === "room_100");
      const missing = result.entities.find((e) => e.id === "room_999");

      expect(found?.name).toBe("Room A");
      expect(found?.error).toBeUndefined();

      expect(missing?.error).toBe("Asset not found");
      expect(missing?._type).toBe("room");
    });

    it("adds warning when some entities fail", async () => {
      vi.mocked(apolloClient.query)
        .mockResolvedValueOnce({
          data: { room: { id: "room_100", name: "Room A" } },
          loading: false,
          networkStatus: 7,
        } as any)
        .mockResolvedValueOnce({
          data: { room: null },
          loading: false,
          networkStatus: 7,
        } as any);

      const result = await executeFetchEntityDetails({
        ids: ["room_100", "room_999"],
      });

      expect(result.warning).toContain("1 of 2 entities failed");
    });
  });

  describe("Batch queries for sensors and hives", () => {
    it("queries multiple sensors in a single batch call", async () => {
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: {
          sensors: {
            data: [
              { id: "sensor_001", mac_address: "aa:00:00:00:00:01" },
              { id: "sensor_002", mac_address: "aa:00:00:00:00:02" },
            ],
          },
        },
        loading: false,
        networkStatus: 7,
      } as any);

      const result = await executeFetchEntityDetails({
        ids: ["sensor_001", "sensor_002"],
      });

      // Should only make 1 API call (batch query)
      expect(apolloClient.query).toHaveBeenCalledTimes(1);
      expect(result.entities).toHaveLength(2);
      expect(result.fetched_count).toBe(2);
    });

    it("reports missing sensors from batch query", async () => {
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: {
          sensors: {
            data: [
              { id: "sensor_001", mac_address: "aa:00:00:00:00:01" },
              // sensor_002 not returned by API
            ],
          },
        },
        loading: false,
        networkStatus: 7,
      } as any);

      const result = await executeFetchEntityDetails({
        ids: ["sensor_001", "sensor_002"],
      });

      expect(result.entities).toHaveLength(2);
      expect(result.fetched_count).toBe(1);
      const missing = result.entities.find((e) => e.id === "sensor_002");
      expect(missing?.error).toBe("Asset not found");
      expect(result.warning).toContain("1 of 2 entities failed");
    });
  });

  // Sibling-tool symmetry: butlr_get_asset_details already surfaces tags on
  // room/zone/floor responses. butlr_fetch_entity_details (this tool) must
  // accept `tags` in its per-type allowlist and emit the correct
  // subselection (`tags { id name }`) — naked `tags` would be invalid
  // GraphQL because the field is an object type.
  describe("Tags field on room/zone/floor", () => {
    function captureQueryFor(rootField: "room" | "zone" | "floor", responseData: unknown) {
      let captured = "";
      vi.mocked(apolloClient.query).mockImplementation((options: never) => {
        captured =
          (options as { query?: { loc?: { source?: { body?: string } } } })?.query?.loc?.source
            ?.body ?? "";
        return Promise.resolve({
          data: { [rootField]: responseData },
          loading: false,
          networkStatus: 7,
        } as never);
      });
      return () => captured;
    }

    it("emits `tags { id name }` subselection on room queries", async () => {
      const getCaptured = captureQueryFor("room", {
        id: "room_100",
        tags: [{ id: "t1", name: "lab" }],
      });

      const result = await executeFetchEntityDetails({
        ids: ["room_100"],
        room_fields: ["tags"],
      });

      const roomSelections = directSelectionsOf(getCaptured(), "room");
      expect(roomSelections).toContain("tags");
      expect(roomSelections).toContain("id"); // id is always injected
      expect(result.entities[0].tags).toEqual([{ id: "t1", name: "lab" }]);
    });

    it("emits `tags { id name }` subselection on zone queries", async () => {
      const getCaptured = captureQueryFor("zone", {
        id: "zone_1",
        tags: [{ id: "t1", name: "quiet" }],
      });

      const result = await executeFetchEntityDetails({
        ids: ["zone_1"],
        zone_fields: ["tags"],
      });

      expect(directSelectionsOf(getCaptured(), "zone")).toContain("tags");
      expect(result.entities[0].tags).toEqual([{ id: "t1", name: "quiet" }]);
    });

    it("emits `tags { id name }` subselection on floor queries", async () => {
      const getCaptured = captureQueryFor("floor", {
        id: "space_1",
        tags: [],
      });

      const result = await executeFetchEntityDetails({
        ids: ["space_1"],
        floor_fields: ["tags"],
      });

      expect(directSelectionsOf(getCaptured(), "floor")).toContain("tags");
      expect(result.entities[0].tags).toEqual([]);
    });

    it("rejects `tags` as a field for building (Building schema has no tags)", async () => {
      await expect(
        executeFetchEntityDetails({
          ids: ["building_1"],
          building_fields: ["tags"],
        })
      ).rejects.toThrow(/Invalid fields for building/);
    });
  });

  // Regression: object-typed fields on the allowlist (capacity, area,
  // collection fields, cross-entity refs) must emit a GraphQL
  // subselection. A naked `capacity` previously produced
  // `[INTERNAL_ERROR] Field "capacity" of type "Capacity!" must have a
  // selection of subfields.` Surfaced via the e2e harness against v0.4.0.
  describe("Object-typed field subselections", () => {
    function captureQueryFor(rootField: "room" | "floor" | "building", responseData: unknown) {
      let captured = "";
      vi.mocked(apolloClient.query).mockImplementation((options: never) => {
        captured =
          (options as { query?: { loc?: { source?: { body?: string } } } })?.query?.loc?.source
            ?.body ?? "";
        return Promise.resolve({
          data: { [rootField]: responseData },
          loading: false,
          networkStatus: 7,
        } as never);
      });
      return () => captured;
    }

    function subselectionsOf(querySource: string, rootField: string, child: string): string[] {
      const ast = parse(querySource);
      for (const def of ast.definitions) {
        if (def.kind !== "OperationDefinition") continue;
        const op = def as OperationDefinitionNode;
        const root = op.selectionSet.selections.find(
          (s): s is FieldNode => s.kind === "Field" && s.name.value === rootField
        );
        const childNode = root?.selectionSet?.selections.find(
          (s): s is FieldNode => s.kind === "Field" && s.name.value === child
        );
        if (!childNode?.selectionSet) return [];
        return childNode.selectionSet.selections
          .filter((s): s is FieldNode => s.kind === "Field")
          .map((s) => s.name.value);
      }
      return [];
    }

    it("emits `capacity { max mid }` subselection (embedded value object)", async () => {
      const getCaptured = captureQueryFor("room", {
        id: "room_100",
        name: "Conference Room A",
        capacity: { max: 10, mid: 6 },
      });

      const result = await executeFetchEntityDetails({
        ids: ["room_100"],
        room_fields: ["name", "capacity"],
      });

      expect(subselectionsOf(getCaptured(), "room", "capacity")).toEqual(["max", "mid"]);
      expect(result.entities[0].capacity).toEqual({ max: 10, mid: 6 });
    });

    it("emits `sensors { id name }` subselection (collection field)", async () => {
      const getCaptured = captureQueryFor("floor", {
        id: "space_001",
        sensors: [{ id: "sensor_1", name: "Door A" }],
      });

      const result = await executeFetchEntityDetails({
        ids: ["space_001"],
        floor_fields: ["sensors"],
      });

      expect(subselectionsOf(getCaptured(), "floor", "sensors")).toEqual(["id", "name"]);
      expect(result.entities[0].sensors).toEqual([{ id: "sensor_1", name: "Door A" }]);
    });

    it("emits `floor { id name }` subselection (cross-entity reference)", async () => {
      const getCaptured = captureQueryFor("room", {
        id: "room_100",
        floor: { id: "space_001", name: "Floor 1" },
      });

      const result = await executeFetchEntityDetails({
        ids: ["room_100"],
        room_fields: ["floor"],
      });

      expect(subselectionsOf(getCaptured(), "room", "floor")).toEqual(["id", "name"]);
      expect(result.entities[0].floor).toEqual({ id: "space_001", name: "Floor 1" });
    });
  });

  describe("Response structure", () => {
    it("includes all required top-level fields", async () => {
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: {
          room: { id: "room_100", name: "Test Room" },
        },
        loading: false,
        networkStatus: 7,
      } as any);

      const result = await executeFetchEntityDetails({
        ids: ["room_100"],
      });

      expect(result.entities).toBeDefined();
      expect(result.requested_count).toBeDefined();
      expect(result.fetched_count).toBeDefined();
      expect(result.timestamp).toBeDefined();
    });
  });
});
