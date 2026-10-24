import { describe, it, expect, beforeEach, vi } from "vitest";
import { CombinedGraphQLErrors } from "@apollo/client/errors";
import { print } from "graphql";
import { executeAvailableRooms, GET_ROOMS_BY_TAG } from "../../butlr-available-rooms.js";
import { apolloClient } from "../../../clients/graphql-client.js";
import * as reportingClient from "../../../clients/reporting-client.js";
import { loadGraphQLFixture } from "../../../__mocks__/apollo-client.js";
import { primeSpaceFieldSupport } from "../../../clients/space-field-support.js";

// Mock the clients
vi.mock("../../../clients/graphql-client.js", () => ({
  apolloClient: {
    query: vi.fn(),
  },
}));

vi.mock("../../../clients/reporting-client.js", async () => {
  const actual = await vi.importActual<typeof import("../../../clients/reporting-client.js")>(
    "../../../clients/reporting-client.js"
  );
  return {
    ...actual,
    getCurrentOccupancy: vi.fn(),
  };
});

describe("butlr_available_rooms - Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Org-wide query (no filters)", () => {
    it("returns available rooms from org topology", async () => {
      // Load full topology fixture
      const fixture = loadGraphQLFixture("full-topology-org");

      vi.mocked(apolloClient.query).mockResolvedValue({
        data: fixture,
        loading: false,
        networkStatus: 7,
      } as any);

      // Mock occupancy data - some rooms occupied, some empty
      vi.mocked(reportingClient.getCurrentOccupancy).mockResolvedValue([
        {
          start: "2025-10-13T00:00:00Z",
          measurement: "room_occupancy",
          value: 0,
          asset_id: "room_2mtO0lzPDNifN2n3COW36N6mzWv",
          asset_name: "min-3fps-opencv",
        },
        {
          start: "2025-10-13T00:00:00Z",
          measurement: "room_occupancy",
          value: 5,
          asset_id: "room_2mtO6SwWNAnrAv2Hop1CNZlmx6A",
          asset_name: "mid-3fps-legacy",
        },
        {
          start: "2025-10-13T00:00:00Z",
          measurement: "room_occupancy",
          value: 0,
          asset_id: "room_2mtOD60elgn5xpEnbJ9GHfxKBQa",
          asset_name: "max-6fps-opencv",
        },
      ]);

      const result = await executeAvailableRooms({});

      // Should have called the APIs
      expect(apolloClient.query).toHaveBeenCalled();
      expect(reportingClient.getCurrentOccupancy).toHaveBeenCalled();

      // Response structure is valid
      expect(result.total_available).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(result.available_rooms)).toBe(true);
      expect(result.summary).toBeDefined();
      expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it("sorts rooms by capacity (largest first)", async () => {
      const fixture = loadGraphQLFixture("full-topology-org");

      vi.mocked(apolloClient.query).mockResolvedValue({
        data: fixture,
        loading: false,
        networkStatus: 7,
      } as any);

      // Mock all rooms as available with different capacities
      const roomsData = fixture.sites.data.flatMap((site: any) =>
        site.buildings.flatMap((building: any) =>
          building.floors.flatMap((floor: any) => floor.rooms || [])
        )
      );

      const mockOccupancy = roomsData.slice(0, 10).map((room: any) => ({
        start: "2025-10-13T00:00:00Z",
        measurement: "room_occupancy",
        value: 0,
        asset_id: room.id,
        asset_name: room.name,
      }));

      vi.mocked(reportingClient.getCurrentOccupancy).mockResolvedValue(mockOccupancy);

      const result = await executeAvailableRooms({});

      // Verify sorting
      if (result.available_rooms.length > 1) {
        for (let i = 1; i < result.available_rooms.length; i++) {
          const prevCap = result.available_rooms[i - 1].capacity?.max || 0;
          const currCap = result.available_rooms[i].capacity?.max || 0;
          expect(currCap).toBeLessThanOrEqual(prevCap);
        }
      }
    });
  });

  describe("Capacity filtering", () => {
    // Reference rooms in full-topology-org.json with known capacity:
    //   room_000084 -> capacity.max = 1
    //   room_000095 -> capacity.max = 6
    //   room_000099 -> capacity.max = 10
    //   room_000106 -> capacity.max = 20
    const FOCUS_ROOM_IDS = ["room_000084", "room_000095", "room_000099", "room_000106"];

    function mockAllZeroOccupancy(roomIds: string[]) {
      vi.mocked(reportingClient.getCurrentOccupancy).mockResolvedValue(
        roomIds.map((id) => ({
          start: "2025-10-13T00:00:00Z",
          measurement: "room_occupancy",
          value: 0,
          asset_id: id,
        }))
      );
    }

    it("excludes rooms below min_capacity and includes those at/above it", async () => {
      const fixture = loadGraphQLFixture("full-topology-org");
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: fixture,
        loading: false,
        networkStatus: 7,
      } as any);
      mockAllZeroOccupancy(FOCUS_ROOM_IDS);

      const result = await executeAvailableRooms({ min_capacity: 10 });

      const ids = result.available_rooms.map((r) => r.id);
      expect(ids).toContain("room_000099"); // cap=10
      expect(ids).toContain("room_000106"); // cap=20
      expect(ids).not.toContain("room_000084"); // cap=1
      expect(ids).not.toContain("room_000095"); // cap=6
      result.available_rooms.forEach((r) => {
        expect(r.capacity?.max ?? 0).toBeGreaterThanOrEqual(10);
      });
    });

    it("excludes rooms above max_capacity and includes those at/below it", async () => {
      const fixture = loadGraphQLFixture("full-topology-org");
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: fixture,
        loading: false,
        networkStatus: 7,
      } as any);
      mockAllZeroOccupancy(FOCUS_ROOM_IDS);

      const result = await executeAvailableRooms({ max_capacity: 15 });

      const ids = result.available_rooms.map((r) => r.id);
      expect(ids).toContain("room_000084"); // cap=1
      expect(ids).toContain("room_000095"); // cap=6
      expect(ids).toContain("room_000099"); // cap=10
      expect(ids).not.toContain("room_000106"); // cap=20
      result.available_rooms.forEach((r) => {
        expect(r.capacity?.max ?? 0).toBeLessThanOrEqual(15);
      });
    });

    it("filters by both min and max capacity (inclusive bounds)", async () => {
      const fixture = loadGraphQLFixture("full-topology-org");
      vi.mocked(apolloClient.query).mockResolvedValue({
        data: fixture,
        loading: false,
        networkStatus: 7,
      } as any);
      mockAllZeroOccupancy(FOCUS_ROOM_IDS);

      const result = await executeAvailableRooms({ min_capacity: 6, max_capacity: 10 });

      const ids = result.available_rooms.map((r) => r.id);
      expect(ids).toContain("room_000095"); // cap=6 (lower bound)
      expect(ids).toContain("room_000099"); // cap=10 (upper bound)
      expect(ids).not.toContain("room_000084"); // cap=1
      expect(ids).not.toContain("room_000106"); // cap=20
    });
  });

  describe("Empty results", () => {
    it("handles no available rooms gracefully", async () => {
      const fixture = loadGraphQLFixture("full-topology-org");

      vi.mocked(apolloClient.query).mockResolvedValue({
        data: fixture,
        loading: false,
        networkStatus: 7,
      } as any);

      // Mock all rooms as occupied
      const allRoomsOccupied = fixture.sites.data.flatMap((site: any) =>
        site.buildings.flatMap((building: any) =>
          building.floors.flatMap((floor: any) =>
            (floor.rooms || []).map((room: any) => ({
              start: "2025-10-13T00:00:00Z",
              measurement: "room_occupancy",
              value: 5, // All occupied
              asset_id: room.id,
              asset_name: room.name,
            }))
          )
        )
      );

      vi.mocked(reportingClient.getCurrentOccupancy).mockResolvedValue(
        allRoomsOccupied.slice(0, 50)
      );

      const result = await executeAvailableRooms({});

      expect(result.total_available).toBe(0);
      expect(result.available_rooms).toEqual([]);
      expect(result.summary).toContain("No");
      expect(result.summary).toContain("currently available");
    });

    it("handles capacity filter with no matches", async () => {
      const fixture = loadGraphQLFixture("full-topology-org");

      vi.mocked(apolloClient.query).mockResolvedValue({
        data: fixture,
        loading: false,
        networkStatus: 7,
      } as any);

      const result = await executeAvailableRooms({ min_capacity: 1000 });

      expect(result.total_available).toBe(0);
      expect(result.available_rooms).toEqual([]);
    });
  });

  describe("Response structure", () => {
    it("includes all required fields", async () => {
      const fixture = loadGraphQLFixture("full-topology-org");

      vi.mocked(apolloClient.query).mockResolvedValue({
        data: fixture,
        loading: false,
        networkStatus: 7,
      } as any);

      vi.mocked(reportingClient.getCurrentOccupancy).mockResolvedValue([
        {
          start: "2025-10-13T00:00:00Z",
          measurement: "room_occupancy",
          value: 0,
          asset_id: "room_2mtO0lzPDNifN2n3COW36N6mzWv",
          asset_name: "Test Room",
        },
      ]);

      const result = await executeAvailableRooms({});

      expect(result.summary).toBeDefined();
      expect(result.available_rooms).toBeDefined();
      expect(result.total_available).toBeDefined();
      expect(result.timestamp).toBeDefined();
    });

    it("includes filtered_by when filters provided", async () => {
      const fixture = loadGraphQLFixture("full-topology-org");

      vi.mocked(apolloClient.query).mockResolvedValue({
        data: fixture,
        loading: false,
        networkStatus: 7,
      } as any);

      vi.mocked(reportingClient.getCurrentOccupancy).mockResolvedValue([]);

      const result = await executeAvailableRooms({ min_capacity: 6 });

      expect(result.filtered_by).toEqual({ min_capacity: 6 });
    });
  });

  describe("Tag filtering", () => {
    const tagsResponse = {
      tags: [
        { id: "tag_000001", name: "videoconf" },
        { id: "tag_000002", name: "focus" },
        { id: "tag_000003", name: "huddle" },
      ],
    };

    function buildRoomsByTagResponse(roomIds: string[]) {
      return {
        roomsByTag: {
          data: roomIds.map((id, i) => ({
            __typename: "Room",
            id,
            name: `Tagged Room ${i + 1}`,
            floorID: "space_000001",
            roomType: null,
            customID: null,
            capacity: { __typename: "Capacity", max: 6, mid: 4 },
            area: null,
            coordinates: null,
            floor: {
              __typename: "Floor",
              id: "space_000001",
              name: "Floor 1",
              building_id: "building_000001",
              building: {
                __typename: "Building",
                id: "building_000001",
                name: "Main Building",
                site_id: "site_000001",
              },
            },
          })),
        },
      };
    }

    it("resolves tag names to IDs and calls roomsByTag with tagIDs (AND semantics by default)", async () => {
      vi.mocked(apolloClient.query)
        .mockResolvedValueOnce({
          data: tagsResponse,
          loading: false,
          networkStatus: 7,
        } as never)
        .mockResolvedValueOnce({
          data: buildRoomsByTagResponse(["room_000001"]),
          loading: false,
          networkStatus: 7,
        } as never);

      vi.mocked(reportingClient.getCurrentOccupancy).mockResolvedValue([
        {
          start: "2025-10-13T00:00:00Z",
          measurement: "room_occupancy",
          value: 0,
          asset_id: "room_000001",
          asset_name: "Tagged Room 1",
        },
      ]);

      const result = await executeAvailableRooms({ tags: ["focus", "videoconf"] });

      expect(apolloClient.query).toHaveBeenCalledTimes(2);
      const roomsCall = vi.mocked(apolloClient.query).mock.calls[1][0];
      expect(roomsCall.query).toBe(GET_ROOMS_BY_TAG);
      expect(roomsCall.variables).toEqual({
        tagIDs: ["tag_000002", "tag_000001"],
        useOR: false,
      });

      expect(result.total_available).toBe(1);
      expect(result.available_rooms[0].id).toBe("room_000001");
    });

    it("uses useOR=true when tag_match='any'", async () => {
      vi.mocked(apolloClient.query)
        .mockResolvedValueOnce({
          data: tagsResponse,
          loading: false,
          networkStatus: 7,
        } as never)
        .mockResolvedValueOnce({
          data: buildRoomsByTagResponse(["room_000001", "room_000002"]),
          loading: false,
          networkStatus: 7,
        } as never);

      vi.mocked(reportingClient.getCurrentOccupancy).mockResolvedValue([]);

      await executeAvailableRooms({ tags: ["videoconf"], tag_match: "any" });

      const roomsCall = vi.mocked(apolloClient.query).mock.calls[1][0];
      expect(roomsCall.variables).toEqual({
        tagIDs: ["tag_000001"],
        useOR: true,
      });
    });

    it("uses useOR=false when tag_match='all' is explicit", async () => {
      vi.mocked(apolloClient.query)
        .mockResolvedValueOnce({
          data: tagsResponse,
          loading: false,
          networkStatus: 7,
        } as never)
        .mockResolvedValueOnce({
          data: buildRoomsByTagResponse([]),
          loading: false,
          networkStatus: 7,
        } as never);

      vi.mocked(reportingClient.getCurrentOccupancy).mockResolvedValue([]);

      await executeAvailableRooms({ tags: ["videoconf"], tag_match: "all" });

      const roomsCall = vi.mocked(apolloClient.query).mock.calls[1][0];
      expect(roomsCall.variables).toEqual({
        tagIDs: ["tag_000001"],
        useOR: false,
      });
    });

    it("matches tag names case-insensitively", async () => {
      vi.mocked(apolloClient.query)
        .mockResolvedValueOnce({
          data: tagsResponse,
          loading: false,
          networkStatus: 7,
        } as never)
        .mockResolvedValueOnce({
          data: buildRoomsByTagResponse([]),
          loading: false,
          networkStatus: 7,
        } as never);

      vi.mocked(reportingClient.getCurrentOccupancy).mockResolvedValue([]);

      await executeAvailableRooms({ tags: ["VIDEOCONF", "HUDDLE"] });

      const roomsCall = vi.mocked(apolloClient.query).mock.calls[1][0];
      expect(roomsCall.variables.tagIDs.sort()).toEqual(["tag_000001", "tag_000003"].sort());
    });

    it("returns an empty result with a warning when no supplied tag exists in the org", async () => {
      vi.mocked(apolloClient.query).mockResolvedValueOnce({
        data: tagsResponse,
        loading: false,
        networkStatus: 7,
      } as never);

      const result = await executeAvailableRooms({ tags: ["does-not-exist"] });

      expect(apolloClient.query).toHaveBeenCalledTimes(1);
      expect(result.total_available).toBe(0);
      expect(result.available_rooms).toEqual([]);
      expect(result.warning).toMatch(/no matching tags/i);
      expect(result.warning).toMatch(/butlr_list_tags/i);
      expect(result.unknown_tags).toEqual(["does-not-exist"]);
    });

    it("under tag_match='all' (default), partial resolution short-circuits without querying roomsByTag", async () => {
      // C1 regression: under AND semantics, an unresolved tag means the
      // query is unsatisfiable. We must NOT silently relax to the resolved
      // subset (which would return a strictly broader result).
      vi.mocked(apolloClient.query).mockResolvedValueOnce({
        data: tagsResponse,
        loading: false,
        networkStatus: 7,
      } as never);

      const result = await executeAvailableRooms({
        tags: ["videoconf", "does-not-exist"],
      });

      // Only the tag-resolution query should have run; roomsByTag must NOT.
      expect(apolloClient.query).toHaveBeenCalledTimes(1);
      expect(reportingClient.getCurrentOccupancy).not.toHaveBeenCalled();

      expect(result.total_available).toBe(0);
      expect(result.available_rooms).toEqual([]);
      expect(result.warning).toMatch(/cannot satisfy tag_match='all'/i);
      expect(result.warning).toMatch(/does-not-exist/);
      expect(result.warning).toMatch(/butlr_list_tags/i);
      expect(result.unknown_tags).toEqual(["does-not-exist"]);
    });

    it("under tag_match='any', partial resolution surfaces structured unknown_tags + soft warning and queries with the resolved subset", async () => {
      vi.mocked(apolloClient.query)
        .mockResolvedValueOnce({
          data: tagsResponse,
          loading: false,
          networkStatus: 7,
        } as never)
        .mockResolvedValueOnce({
          data: buildRoomsByTagResponse([]),
          loading: false,
          networkStatus: 7,
        } as never);

      vi.mocked(reportingClient.getCurrentOccupancy).mockResolvedValue([]);

      const result = await executeAvailableRooms({
        tags: ["videoconf", "does-not-exist", "also-missing"],
        tag_match: "any",
      });

      const roomsCall = vi.mocked(apolloClient.query).mock.calls[1][0];
      expect(roomsCall.query).toBe(GET_ROOMS_BY_TAG);
      expect(roomsCall.variables).toEqual({ tagIDs: ["tag_000001"], useOR: true });
      expect(result.warning).toMatch(/does-not-exist/);
      expect(result.warning).toMatch(/also-missing/);
      expect(result.unknown_tags).toEqual(["does-not-exist", "also-missing"]);
    });

    it("unwraps roomsByTag.data correctly (regression: previously treated as array)", async () => {
      vi.mocked(apolloClient.query)
        .mockResolvedValueOnce({
          data: tagsResponse,
          loading: false,
          networkStatus: 7,
        } as never)
        .mockResolvedValueOnce({
          data: buildRoomsByTagResponse(["room_000001", "room_000002", "room_000003"]),
          loading: false,
          networkStatus: 7,
        } as never);

      vi.mocked(reportingClient.getCurrentOccupancy).mockResolvedValue([
        {
          start: "2025-10-13T00:00:00Z",
          measurement: "room_occupancy",
          value: 0,
          asset_id: "room_000001",
          asset_name: "Tagged Room 1",
        },
        {
          start: "2025-10-13T00:00:00Z",
          measurement: "room_occupancy",
          value: 0,
          asset_id: "room_000002",
          asset_name: "Tagged Room 2",
        },
        {
          start: "2025-10-13T00:00:00Z",
          measurement: "room_occupancy",
          value: 5,
          asset_id: "room_000003",
          asset_name: "Tagged Room 3",
        },
      ]);

      const result = await executeAvailableRooms({ tags: ["videoconf"] });

      expect(result.total_available).toBe(2);
      expect(result.available_rooms.map((r) => r.id).sort()).toEqual([
        "room_000001",
        "room_000002",
      ]);
    });

    it("throws a translated MCP error when roomsByTag returns the legacy array shape (regression for the original bug)", async () => {
      // Pre-fix code accepted an array; the fixed code expects { data: [...] }.
      // Mock the legacy shape and assert we now fail loud rather than crash on
      // an unexpected access pattern.
      vi.mocked(apolloClient.query)
        .mockResolvedValueOnce({
          data: tagsResponse,
          loading: false,
          networkStatus: 7,
        } as never)
        .mockResolvedValueOnce({
          data: { roomsByTag: [] },
          loading: false,
          networkStatus: 7,
        } as never);

      await expect(executeAvailableRooms({ tags: ["videoconf"] })).rejects.toThrow(
        /\[INTERNAL_ERROR\].*missing data envelope/i
      );
    });

    it("translates a CombinedGraphQLErrors result.error into an MCP error (regression for errorPolicy:'all' silent failure)", async () => {
      // Apollo Client 4.x with errorPolicy:'all' resolves with `result.error`
      // populated, NOT a rejected promise. Without explicit handling, the tool
      // would coerce data:null → [] and silently report "no tags found".
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

      await expect(executeAvailableRooms({ tags: ["videoconf"] })).rejects.toThrow(
        /\[AUTH_EXPIRED\]/
      );
      // roomsByTag must not have been called.
      expect(apolloClient.query).toHaveBeenCalledTimes(1);
    });
  });

  describe("Available room structure", () => {
    it("includes required fields in each available room", async () => {
      const fixture = loadGraphQLFixture("full-topology-org");

      vi.mocked(apolloClient.query).mockResolvedValue({
        data: fixture,
        loading: false,
        networkStatus: 7,
      } as any);

      vi.mocked(reportingClient.getCurrentOccupancy).mockResolvedValue([
        {
          start: "2025-10-13T00:00:00Z",
          measurement: "room_occupancy",
          value: 0,
          asset_id: "room_2mtO0lzPDNifN2n3COW36N6mzWv",
        },
      ]);

      const result = await executeAvailableRooms({});

      if (result.available_rooms.length > 0) {
        const room = result.available_rooms[0];
        expect(room.id).toBeDefined();
        expect(room.name).toBeDefined();
        expect(room.path).toBeDefined();
        expect(room.capacity).toBeDefined();
        expect(room.data_window_minutes).toBe(5);
      }
    });
  });

  describe("archived rooms", () => {
    beforeEach(() => {});

    function buildingWithArchivedRoom(opts?: { withArchiveFields?: boolean }) {
      const withArchiveFields = opts?.withArchiveFields ?? true;
      return {
        building: {
          id: "building_arch",
          name: "Indy Tower",
          site_id: "site_arch",
          floors: [
            {
              id: "floor_arch",
              name: "Floor 07",
              building_id: "building_arch",
              rooms: [
                {
                  id: "room_arch_free",
                  name: "Huddle_V2",
                  floorID: "floor_arch",
                  capacity: { max: 4 },
                },
                {
                  id: "room_arch_busy",
                  name: "Focus_V2",
                  floorID: "floor_arch",
                  capacity: { max: 2 },
                },
                {
                  id: "room_arch_old",
                  name: "Pilot - Huddle",
                  floorID: "floor_arch",
                  capacity: { max: 4 },
                  ...(withArchiveFields ? { archivedAt: "2026-10-21T01:30:00Z" } : {}),
                },
              ],
            },
          ],
        },
      };
    }

    it("keeps an archived room that still has sensors (live, per E4) in the listing and counts", async () => {
      const building = buildingWithArchivedRoom();
      (building.building.floors[0].rooms[2] as any).sensors = [{ id: "sensor_1" }];
      vi.mocked(apolloClient.query).mockResolvedValue({ data: building } as any);
      vi.mocked(reportingClient.getCurrentOccupancy).mockImplementation(async (_type, ids) =>
        ids.map((id) => ({
          start: "2026-10-23T00:00:00Z",
          measurement: "room_occupancy",
          value: 0,
          asset_id: id,
        }))
      );

      const result = await executeAvailableRooms({ building_id: "building_arch" });

      expect(vi.mocked(reportingClient.getCurrentOccupancy).mock.calls[0][1]).toHaveLength(3);
      expect(result.building_context?.total_rooms).toBe(3);
      // Listed, but marked: archived with sensors still attributed.
      const archived = result.available_rooms.find((r) => r.id === "room_arch_old");
      expect(archived?.archived_at).toBe("2026-10-21T01:30:00Z");
      expect(result.warning).toMatch(
        /1 listed room\(s\) are archived but still have sensors attributed/
      );
    });

    it("leaves out a room retired by sensorsRemovedAt alone", async () => {
      const building = buildingWithArchivedRoom({ withArchiveFields: false });
      (building.building.floors[0].rooms[2] as any).sensorsRemovedAt = "2026-10-21T01:30:00Z";
      vi.mocked(apolloClient.query).mockResolvedValue({ data: building } as any);
      vi.mocked(reportingClient.getCurrentOccupancy).mockResolvedValue([]);

      await executeAvailableRooms({ building_id: "building_arch" });

      expect(vi.mocked(reportingClient.getCurrentOccupancy).mock.calls[0][1]).toEqual([
        "room_arch_free",
        "room_arch_busy",
      ]);
    });

    it("fails with the reporting status on a 401/429 instead of degrading to a warning", async () => {
      vi.mocked(apolloClient.query).mockResolvedValue({ data: buildingWithArchivedRoom() } as any);
      for (const status of [401, 429]) {
        vi.mocked(reportingClient.getCurrentOccupancy).mockRejectedValueOnce(
          new reportingClient.ApiError(status, "nope")
        );
        await expect(executeAvailableRooms({ building_id: "building_arch" })).rejects.toMatchObject(
          {
            statusCode: status,
          }
        );
      }
    });

    it("never lists an archived room and leaves it out of the building's room count", async () => {
      vi.mocked(apolloClient.query).mockResolvedValue({ data: buildingWithArchivedRoom() } as any);
      vi.mocked(reportingClient.getCurrentOccupancy).mockImplementation(async (_type, ids) =>
        ids.map((id) => ({
          start: "2026-10-23T00:00:00Z",
          measurement: "room_occupancy",
          value: id === "room_arch_busy" ? 2 : 0,
          asset_id: id,
        }))
      );

      const result = await executeAvailableRooms({ building_id: "building_arch" });

      expect(vi.mocked(reportingClient.getCurrentOccupancy).mock.calls[0][1]).toEqual([
        "room_arch_free",
        "room_arch_busy",
      ]);
      expect(result.available_rooms.map((r) => r.id)).toEqual(["room_arch_free"]);
      expect(result.building_context).toMatchObject({
        total_rooms: 2,
        available_rooms: 1,
        occupancy_percent: 50,
      });
    });

    it("strips the archive fields when the API lacks them", async () => {
      // The schema check found none of the optional fields.
      primeSpaceFieldSupport([]);
      vi.mocked(apolloClient.query).mockResolvedValueOnce({
        data: buildingWithArchivedRoom({ withArchiveFields: false }),
      } as any);
      vi.mocked(reportingClient.getCurrentOccupancy).mockResolvedValue([]);

      await executeAvailableRooms({ building_id: "building_arch" });

      const calls = vi.mocked(apolloClient.query).mock.calls;
      expect(calls).toHaveLength(1);
      expect(print(calls[0][0].query)).not.toMatch(/archivedAt|replacesID|sensorsRemovedAt/);
      expect(calls[0][0].variables).toEqual({ buildingId: "building_arch" });
      // Without the fields nothing is known to be archived, so all 3 rooms count.
      expect(vi.mocked(reportingClient.getCurrentOccupancy).mock.calls[0][1]).toHaveLength(3);
    });
  });
});
