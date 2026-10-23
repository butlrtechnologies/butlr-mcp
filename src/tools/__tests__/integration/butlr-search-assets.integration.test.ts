import { describe, it, expect, beforeEach, vi } from "vitest";
import { executeSearchAssets } from "../../butlr-search-assets.js";
import { apolloClient } from "../../../clients/graphql-client.js";
import { topologyCache } from "../../../cache/topology-cache.js";
import { GET_FULL_TOPOLOGY, GET_FULL_TOPOLOGY_LEGACY } from "../../../clients/queries/topology.js";
import { primeSpaceFieldSupport, stripArchiveFields } from "../../../clients/archive-fallback.js";

// What the fallback sends to an API without the archive fields.
const GET_FULL_TOPOLOGY_LEGACY = stripArchiveFields(GET_FULL_TOPOLOGY);

vi.mock("../../../clients/graphql-client.js", () => ({
  apolloClient: {
    query: vi.fn(),
  },
}));

const MOCK_TOPOLOGY = {
  sites: {
    data: [
      {
        id: "site_test",
        name: "Test Site",
        timezone: "America/Los_Angeles",
        buildings: [
          {
            id: "building_test",
            name: "Test Building",
            site_id: "site_test",
            floors: [
              {
                id: "floor_test",
                name: "Test Floor",
                building_id: "building_test",
                rooms: [{ id: "room_lobby", name: "Main Lobby" }],
                zones: [],
              },
            ],
          },
        ],
      },
    ],
  },
};

const MOCK_SENSORS = [
  {
    id: "sensor_elevator",
    name: "North Elevator Door",
    mac_address: "aa:bb:cc:dd:ee:01",
    mode: "traffic",
    floor_id: "floor_test",
    room_id: "room_lobby",
  },
  {
    id: "sensor_mirror",
    name: "North Elevator Mirror",
    mac_address: "mi-rr-or-00-00-01",
    mode: "traffic",
    floor_id: "floor_test",
    room_id: "room_lobby",
  },
];

const MOCK_HIVES = [
  {
    id: "hive_lobby",
    name: "Lobby Hive",
    serialNumber: "HV-2026-001",
    floor_id: "floor_test",
    room_id: "room_lobby",
  },
  {
    id: "hive_fake",
    name: "Lobby Hive Spare",
    serialNumber: "fake-hive-001",
    floor_id: "floor_test",
    room_id: "room_lobby",
  },
];

// The topology is cloned per call: mergeSensorsAndHivesIntoTopology assigns
// floor.sensors/floor.hives onto the tree it is given, so a shared
// module-scoped fixture would leak one test's merge into the next.
const mockGraphQL = () => {
  vi.mocked(apolloClient.query).mockImplementation((options: any) => {
    const queryString = options.query.loc?.source?.body || "";
    if (queryString.includes("GetFullTopology")) {
      return Promise.resolve({
        data: structuredClone(MOCK_TOPOLOGY),
        loading: false,
        networkStatus: 7,
      } as any);
    }
    if (queryString.includes("GetAllSensors")) {
      return Promise.resolve({
        data: { sensors: { data: MOCK_SENSORS } },
        loading: false,
        networkStatus: 7,
      } as any);
    }
    if (queryString.includes("GetAllHives")) {
      return Promise.resolve({
        data: { hives: { data: MOCK_HIVES } },
        loading: false,
        networkStatus: 7,
      } as any);
    }
    return Promise.reject(new Error(`Unexpected query: ${queryString}`));
  });
};

describe("butlr_search_assets - device coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The topology cache is module scoped and survives between tests.
    topologyCache.clear();
    mockGraphQL();
  });

  // VALID_ASSET_TYPES advertises "sensor" and butlr_hardware_snapshot tells
  // callers to find sensor IDs here, but the corpus held zero devices:
  // flattenTopology reads them from floor.sensors/floor.hives, and
  // GET_FULL_TOPOLOGY selects neither.
  it("finds a sensor by name", async () => {
    const result = await executeSearchAssets({
      query: "north elevator door",
      asset_types: ["sensor"],
      max_results: 5,
    });

    expect(result.matches.map((m) => m.id)).toContain("sensor_elevator");
    expect(result.matches[0].type).toBe("sensor");
  });

  it("finds a sensor by MAC address", async () => {
    const result = await executeSearchAssets({
      query: "aa:bb:cc:dd:ee:01",
      asset_types: ["sensor"],
      max_results: 5,
    });

    expect(result.matches.map((m) => m.id)).toContain("sensor_elevator");
  });

  it("finds a hive by serial number", async () => {
    const result = await executeSearchAssets({
      query: "HV-2026-001",
      asset_types: ["hive"],
      max_results: 5,
    });

    expect(result.matches.map((m) => m.id)).toContain("hive_lobby");
  });

  it("excludes mirror sensors and fake hives from the corpus", async () => {
    const result = await executeSearchAssets({
      query: "lobby",
      max_results: 100,
    });

    const ids = result.matches.map((m) => m.id);
    expect(ids).not.toContain("sensor_mirror");
    expect(ids).not.toContain("hive_fake");
  });

  it("gives a device the full breadcrumb path including its room", async () => {
    const result = await executeSearchAssets({
      query: "north elevator door",
      asset_types: ["sensor"],
      max_results: 5,
    });

    const match = result.matches.find((m) => m.id === "sensor_elevator");
    expect(match?.path).toBe(
      "Test Site / Test Building / Test Floor / Main Lobby / North Elevator Door"
    );
    expect(match?.room_id).toBe("room_lobby");
  });

  it("does not cache a topology whose device queries errored", async () => {
    vi.mocked(apolloClient.query).mockImplementation((options: any) => {
      const queryString = options.query.loc?.source?.body || "";
      if (queryString.includes("GetFullTopology")) {
        return Promise.resolve({
          data: structuredClone(MOCK_TOPOLOGY),
          loading: false,
          networkStatus: 7,
        } as any);
      }
      if (queryString.includes("GetAllSensors")) {
        return Promise.resolve({
          data: { sensors: { data: [] } },
          error: new Error("sensors unavailable"),
          loading: false,
          networkStatus: 7,
        } as any);
      }
      return Promise.resolve({
        data: { hives: { data: MOCK_HIVES } },
        loading: false,
        networkStatus: 7,
      } as any);
    });

    // A failed device fetch surfaces as an error rather than as
    // `total_matches: 0` — the silent-failure mode the repo guidelines warn
    // against — and nothing gets cached.
    await expect(executeSearchAssets({ query: "lobby", max_results: 5 })).rejects.toThrow(
      "sensors unavailable"
    );

    // A device-empty tree must not be served to later callers as the answer.
    mockGraphQL();
    const second = await executeSearchAssets({
      query: "north elevator door",
      asset_types: ["sensor"],
      max_results: 5,
    });
    expect(second.matches.map((m) => m.id)).toContain("sensor_elevator");
  });

  it("rejects a device payload whose data is not an array instead of caching it", async () => {
    vi.mocked(apolloClient.query).mockImplementation((options: any) => {
      const queryString = options.query.loc?.source?.body || "";
      if (queryString.includes("GetFullTopology")) {
        return Promise.resolve({
          data: structuredClone(MOCK_TOPOLOGY),
          loading: false,
          networkStatus: 7,
        } as any);
      }
      if (queryString.includes("GetAllSensors")) {
        // No GraphQL error alongside it: exactly the shape that previously
        // laundered into a device-empty tree under the shared cache key.
        return Promise.resolve({
          data: { sensors: { data: null } },
          loading: false,
          networkStatus: 7,
        } as any);
      }
      return Promise.resolve({
        data: { hives: { data: MOCK_HIVES } },
        loading: false,
        networkStatus: 7,
      } as any);
    });

    await expect(executeSearchAssets({ query: "lobby", max_results: 5 })).rejects.toThrow(
      "Unexpected response shape from sensors query"
    );

    // The shared merged-devices cache entry must not have been primed.
    mockGraphQL();
    const second = await executeSearchAssets({
      query: "north elevator door",
      asset_types: ["sensor"],
      max_results: 5,
    });
    expect(second.matches.map((m) => m.id)).toContain("sensor_elevator");
  });
});

// Indy Tower Floor 7 after the re-layout: the old pilot room is archived and
// its "_V2" copy replaces it.
const FLOOR7_TOPOLOGY = {
  sites: {
    data: [
      {
        id: "site_indy",
        name: "Indy",
        timezone: "America/Indiana/Indianapolis",
        buildings: [
          {
            id: "building_tower",
            name: "Tower",
            site_id: "site_indy",
            floors: [
              {
                id: "floor_7",
                name: "Floor 07",
                building_id: "building_tower",
                rooms: [
                  {
                    id: "room_old",
                    name: "Pilot - Drop In",
                    // 01:30 UTC on Oct 21 = evening of Oct 20 in Indianapolis
                    archivedAt: "2026-10-21T01:30:00Z",
                  },
                  { id: "room_v2", name: "Huddle_V2", replacesID: "room_old" },
                ],
                zones: [
                  {
                    id: "zone_old",
                    name: "Pilot Desk Zone",
                    archivedAt: "2026-10-21T01:30:00Z",
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },
};

function mockFloor7(opts?: { apiHasArchiveFields?: boolean }) {
  // The schema check's answer: all optional fields, or none.
  primeSpaceFieldSupport(opts?.apiHasArchiveFields === false ? [] : undefined);
  vi.mocked(apolloClient.query).mockImplementation((options: any) => {
    if (options.query === GET_FULL_TOPOLOGY) {
      return Promise.resolve({ data: structuredClone(FLOOR7_TOPOLOGY) } as any);
    }
    if (options.query === GET_FULL_TOPOLOGY_LEGACY) {
      // What the old API returns: the same tree without the new fields.
      const legacy = structuredClone(FLOOR7_TOPOLOGY);
      const floor = legacy.sites.data[0].buildings[0].floors[0] as any;
      for (const space of [...floor.rooms, ...floor.zones]) {
        delete space.archivedAt;
        delete space.replacesID;
      }
      return Promise.resolve({ data: legacy } as any);
    }
    const queryString = options.query.loc?.source?.body || "";
    if (queryString.includes("GetAllSensors")) {
      return Promise.resolve({ data: { sensors: { data: [] } } } as any);
    }
    if (queryString.includes("GetAllHives")) {
      return Promise.resolve({ data: { hives: { data: [] } } } as any);
    }
    return Promise.reject(new Error(`Unexpected query: ${queryString}`));
  });
}

describe("butlr_search_assets - archived spaces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    topologyCache.clear();
    primeSpaceFieldSupport();
  });

  it("finds an archived room by its old name and labels it", async () => {
    mockFloor7();

    const result = await executeSearchAssets({ query: "Pilot - Drop In", max_results: 5 });

    const match = result.matches.find((m) => m.id === "room_old");
    expect(match).toBeDefined();
    // `name` stays plain so it can be passed to name-accepting tools.
    expect(match?.name).toBe("Pilot - Drop In");
    expect(match?.path).toBe("Indy / Tower / Floor 07 / Pilot - Drop In (archived 2026-10-20)");
    expect(match?.archived_at).toBe("2026-10-21T01:30:00Z");
    // The replacement is linked even though its name did not match.
    expect(match?.replaced_by).toEqual([{ id: "room_v2", name: "Huddle_V2" }]);
  });

  it("labels archived zones and links a replacement to its predecessor", async () => {
    mockFloor7();

    const zones = await executeSearchAssets({ query: "Pilot Desk Zone", max_results: 5 });
    expect(zones.matches.find((m) => m.id === "zone_old")?.path).toMatch(
      /\(archived 2026-10-20\)$/
    );

    const v2 = await executeSearchAssets({ query: "Huddle_V2", max_results: 5 });
    const match = v2.matches.find((m) => m.id === "room_v2");
    expect(match?.replaces_id).toBe("room_old");
    expect(match?.path).not.toMatch(/archived/);
    expect(match).not.toHaveProperty("archived_at");
  });

  it("strips the fields when the API lacks them, and does not cache that tree", async () => {
    mockFloor7({ apiHasArchiveFields: false });

    const result = await executeSearchAssets({ query: "Pilot - Drop In", max_results: 5 });

    const sent = vi.mocked(apolloClient.query).mock.calls.map((c) => c[0].query);
    expect(sent).toContain(GET_FULL_TOPOLOGY_LEGACY);
    const match = result.matches.find((m) => m.id === "room_old");
    expect(match?.path).toBe("Indy / Tower / Floor 07 / Pilot - Drop In");
    expect(match).not.toHaveProperty("archived_at");
    expect(topologyCache.size).toBe(0);
  });
});
