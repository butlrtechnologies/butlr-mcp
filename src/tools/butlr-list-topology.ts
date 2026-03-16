import { apolloClient } from "../clients/graphql-client.js";
import { GET_FULL_TOPOLOGY, GET_ALL_SENSORS, GET_ALL_HIVES } from "../clients/queries/topology.js";
import type { SitesResponse, Sensor, Hive } from "../clients/types.js";
import {
  getCachedTopology,
  setCachedTopology,
  generateTopologyCacheKey,
} from "../cache/topology-cache.js";
import { formatTopologyTree } from "../utils/tree-formatter.js";
import { translateGraphQLError, formatMCPError } from "../errors/mcp-errors.js";

/**
 * Tool definition for butlr_list_topology
 */
export const listTopologyTool = {
  name: "butlr_list_topology",
  description:
    "Display org hierarchy tree with flexible depth control. Can show full tree, specific subtrees, or flat lists. " +
    "Supports filtering by parent asset IDs. Depth levels: 0=sites, 1=buildings, 2=floors, 3=rooms/zones, 4=hives, 5=sensors. " +
    "Use starting_depth to choose which level to show, and traversal_depth to control how many levels below to include.",
  inputSchema: {
    type: "object",
    properties: {
      asset_ids: {
        type: "array",
        items: { type: "string" },
        description:
          "Optional: Parent asset IDs to show tree for. If empty, shows all sites. " +
          "Examples: ['site_123'], ['building_456'], ['floor_789']",
      },
      starting_depth: {
        type: "number",
        default: 0,
        description:
          "Depth level to start showing assets. 0=sites, 1=buildings, 2=floors, 3=rooms/zones, 4=hives, 5=sensors. " +
          "Use with traversal_depth=0 to show only assets at this level (flat list).",
      },
      traversal_depth: {
        type: "number",
        default: 0,
        description:
          "How many levels below starting_depth to traverse. 0=starting level only, 1=one level below, etc. " +
          "Default is 0 to minimize token usage. Use 10 for full tree.",
      },
    },
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/**
 * Input arguments for butlr_list_topology
 */
export interface ListTopologyArgs {
  asset_ids?: string[];
  starting_depth?: number;
  traversal_depth?: number;
}

/**
 * Execute butlr_list_topology tool
 */
export async function executeListTopology(args: ListTopologyArgs = {}) {
  const startingDepth = args.starting_depth ?? 0;
  const traversalDepth = args.traversal_depth ?? 0;
  const assetIds = args.asset_ids ?? [];

  if (process.env.DEBUG) {
    console.error(
      `[butlr-list-topology] Fetching topology: starting_depth=${startingDepth}, traversal_depth=${traversalDepth}, assets=${assetIds.length || "all"}`
    );
  }

  // Use a cache key that includes devices
  const cacheKey = generateTopologyCacheKey(
    process.env.BUTLR_ORG_ID || "default",
    true, // include devices
    true, // include zones
    undefined
  );

  // Try to get cached topology
  let sites: any[] = [];
  const cached = getCachedTopology(cacheKey);

  if (cached && cached.data && cached.data.sites) {
    if (process.env.DEBUG) {
      console.error("[butlr-list-topology] Using cached topology");
    }
    sites = cached.data.sites;
  } else {
    // Fetch fresh topology
    if (process.env.DEBUG) {
      console.error("[butlr-list-topology] Fetching fresh topology");
    }

    try {
      const result = await apolloClient.query<{ sites: SitesResponse }>({
        query: GET_FULL_TOPOLOGY,
        fetchPolicy: "network-only",
      });

      // Apollo can return both data and errors - only fail if we have no data
      if (!result.data || !result.data.sites || !result.data.sites.data) {
        // If we have error but no data, throw
        if (result.error) {
          throw result.error;
        }
        throw new Error("Invalid response structure from API");
      }

      // Log if we got errors but still have data (partial success)
      if (result.error && process.env.DEBUG) {
        console.error(`[butlr-list-topology] Warning: GraphQL errors present, but got data anyway`);
      }

      sites = result.data.sites.data;

      // Query all sensors and hives separately (nested fields are broken)
      if (process.env.DEBUG) {
        console.error("[butlr-list-topology] Fetching all sensors and hives...");
      }

      const [sensorsResult, hivesResult] = await Promise.all([
        apolloClient.query<{ sensors: { data: Sensor[] } }>({
          query: GET_ALL_SENSORS,
          fetchPolicy: "network-only",
        }),
        apolloClient.query<{ hives: { data: Hive[] } }>({
          query: GET_ALL_HIVES,
          fetchPolicy: "network-only",
        }),
      ]);

      // Filter out test/placeholder devices from topology listing
      // (Note: These filters are ONLY for topology display, not occupancy queries)
      const allSensors = (sensorsResult.data?.sensors?.data || []).filter(
        (s) =>
          s.mac_address &&
          s.mac_address.trim() !== "" &&
          !s.mac_address.startsWith("mi-rr-or") && // Mirror/virtual sensors
          !s.mac_address.startsWith("fa-ke") // Fake test sensors
      );
      const allHives = (hivesResult.data?.hives?.data || []).filter(
        (h) =>
          h.serialNumber &&
          h.serialNumber.trim() !== "" &&
          !h.serialNumber.toLowerCase().startsWith("fake") // Fake test hives
      );

      if (process.env.DEBUG) {
        console.error(
          `[butlr-list-topology] Got ${allSensors.length} production sensors, ${allHives.length} production hives (test/placeholder devices filtered)`
        );
      }

      // Merge sensors and hives into topology by floor_id
      sites = mergeSensorsAndHivesIntoTopology(sites, allSensors, allHives);

      // Cache for future requests
      setCachedTopology(cacheKey, { sites });

      if (process.env.DEBUG) {
        console.error(`[butlr-list-topology] Cached topology with ${sites.length} sites`);
      }
    } catch (error: any) {
      if (error && (error.graphQLErrors || error.networkError)) {
        const mcpError = translateGraphQLError(error);
        const errorMessage = formatMCPError(mcpError);
        throw new Error(errorMessage);
      }
      throw error;
    }
  }

  // Filter topology by asset_ids if provided
  let filteredSites = sites;
  if (assetIds.length > 0) {
    filteredSites = filterTopologyByAssets(sites, assetIds);
  }

  // Format as tree with depth controls
  const tree = formatTopologyTree(filteredSites, startingDepth, traversalDepth);

  return {
    tree,
    query_params: {
      starting_depth: startingDepth,
      traversal_depth: traversalDepth,
      asset_filter: assetIds.length > 0 ? assetIds : "all",
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Merge sensors and hives into topology structure
 * Groups by floor_id and nests under appropriate floors
 */
function mergeSensorsAndHivesIntoTopology(
  sites: any[],
  allSensors: Sensor[],
  allHives: Hive[]
): any[] {
  // Group sensors by floor_id
  const sensorsByFloor: Record<string, Sensor[]> = {};
  for (const sensor of allSensors) {
    const floorId = sensor.floor_id || sensor.floorID;
    if (floorId) {
      if (!sensorsByFloor[floorId]) {
        sensorsByFloor[floorId] = [];
      }
      sensorsByFloor[floorId].push(sensor);
    }
  }

  // Group hives by floor_id
  const hivesByFloor: Record<string, Hive[]> = {};
  for (const hive of allHives) {
    const floorId = hive.floor_id || hive.floorID;
    if (floorId) {
      if (!hivesByFloor[floorId]) {
        hivesByFloor[floorId] = [];
      }
      hivesByFloor[floorId].push(hive);
    }
  }

  // Merge into topology
  for (const site of sites) {
    for (const building of site.buildings || []) {
      for (const floor of building.floors || []) {
        // Add sensors and hives to this floor
        floor.sensors = sensorsByFloor[floor.id] || [];
        floor.hives = hivesByFloor[floor.id] || [];
      }
    }
  }

  return sites;
}

/**
 * Filter topology to only include assets matching the provided IDs
 * Returns a subset of the topology tree
 */
function filterTopologyByAssets(sites: any[], assetIds: string[]): any[] {
  // For each asset ID, find it in the topology and include its subtree
  const idSet = new Set(assetIds);
  const filtered: any[] = [];

  for (const site of sites) {
    // Check if this site or any descendants match
    if (idSet.has(site.id)) {
      filtered.push(site);
      continue;
    }

    // Check buildings
    const matchedBuildings: any[] = [];
    for (const building of site.buildings || []) {
      if (idSet.has(building.id)) {
        matchedBuildings.push(building);
        continue;
      }

      // Check floors
      const matchedFloors: any[] = [];
      for (const floor of building.floors || []) {
        if (idSet.has(floor.id)) {
          matchedFloors.push(floor);
          continue;
        }

        // Check rooms
        const hasMatchedRoom = floor.rooms?.some((r: any) => idSet.has(r.id));
        const hasMatchedZone = floor.zones?.some((z: any) => idSet.has(z.id));
        const hasMatchedHive = floor.hives?.some((h: any) => idSet.has(h.id));
        const hasMatchedSensor = floor.sensors?.some((s: any) => idSet.has(s.id));

        if (hasMatchedRoom || hasMatchedZone || hasMatchedHive || hasMatchedSensor) {
          matchedFloors.push(floor);
        }
      }

      if (matchedFloors.length > 0) {
        matchedBuildings.push({ ...building, floors: matchedFloors });
      }
    }

    if (matchedBuildings.length > 0) {
      filtered.push({ ...site, buildings: matchedBuildings });
    }
  }

  return filtered;
}
