import { apolloClient } from "../clients/graphql-client.js";
import { z } from "zod";
import { GET_FULL_TOPOLOGY } from "../clients/queries/topology.js";
import type { SitesResponse } from "../clients/types.js";
import {
  getCachedTopology,
  setCachedTopology,
  generateTopologyCacheKey,
} from "../cache/topology-cache.js";
import { flattenTopology } from "../utils/asset-flattener.js";
import { searchAssets } from "../utils/fuzzy-match.js";
import { buildAssetPath } from "../utils/path-builder.js";
import { translateGraphQLError, formatMCPError } from "../errors/mcp-errors.js";

/**
 * Zod validation schema for search_assets
 */
const VALID_ASSET_TYPES = ["site", "building", "floor", "room", "zone", "sensor", "hive"] as const;

export const SearchAssetsArgsSchema = z
  .object({
    query: z
      .string()
      .min(1, "query cannot be empty")
      .max(500, "query too long (max: 500 chars)")
      .trim()
      .refine(
        (val) => val.length >= 2,
        "query must be at least 2 characters (after trimming whitespace)"
      )
      .describe("Search term to match against asset names"),

    asset_types: z
      .array(
        z.enum(VALID_ASSET_TYPES, {
          errorMap: () => ({
            message: `asset_type must be one of: ${VALID_ASSET_TYPES.join(", ")}`,
          }),
        })
      )
      .min(1, "asset_types array cannot be empty (omit field to search all types)")
      .max(VALID_ASSET_TYPES.length)
      .optional()
      .describe("Optional: Filter to specific asset types"),

    max_results: z
      .number()
      .int("max_results must be an integer")
      .min(1, "max_results must be at least 1")
      .max(100, "max_results cannot exceed 100")
      .default(20)
      .describe("Maximum number of results to return"),
  })
  .strict()
  .refine(
    (data) => {
      if (data.asset_types) {
        const unique = new Set(data.asset_types);
        return unique.size === data.asset_types.length;
      }
      return true;
    },
    {
      message: "asset_types contains duplicate values",
      path: ["asset_types"],
    }
  );

/**
 * Tool definition for search_assets
 */
export const searchAssetsTool = {
  name: "butlr_search_assets",
  description:
    "Search for Butlr assets (sites, buildings, floors, rooms, zones, sensors, hives) by name using fuzzy matching. Essential prerequisite tool for finding asset IDs before calling other tools. Returns minimal matched results with breadcrumb paths, match scores, and parent context. Searches across all asset types by default, with optional filters.\n\n" +
    "Primary Users:\n" +
    "- All Users: Find asset IDs by human-readable names before using other tools\n" +
    "- IT Manager: Find sensors by MAC address for troubleshooting\n" +
    "- Field Technician: Locate sensors/hives by name or serial number before site visits\n" +
    "- Workplace Manager: Find rooms/spaces by common names (e.g., 'café', 'huddle room 3')\n\n" +
    "Example Queries:\n" +
    '1. "Find the main lobby" → returns room_lobby_123\n' +
    '2. "Search for café or coffee shop" → fuzzy matches "Café Barista", "Coffee Bar"\n' +
    '3. "Find Floor 6 in SF Tower" → returns floor_sf_tower_6\n' +
    '4. "Search for sensors with MAC address starting with 00:1A" → matches sensors by MAC\n' +
    '5. "Find all conference rooms" → searches room names containing "conference"\n' +
    '6. "Locate hive with serial number HV-2023-001" → finds hive by serial\n' +
    '7. "Search for Chicago office" → finds site/building matching "Chicago"\n' +
    '8. "Find focus rooms on Floor 3" → searches for rooms with "focus" in name\n\n' +
    "When to Use:\n" +
    "- Know a space's name but not its ID (e.g., 'Café Barista' → room_cafe_123)\n" +
    "- Looking for sensors/hives by MAC address or serial number\n" +
    "- Find all assets of a specific type (e.g., all sites, all conference rooms)\n" +
    "- Exploring org topology and don't know exact asset names\n" +
    "- Want to find spaces with partial/fuzzy names (e.g., 'cafe' matches 'Café Barista')\n\n" +
    "When NOT to Use:\n" +
    "- Already have asset IDs and need detailed info → use butlr_get_asset_details directly\n" +
    "- Want to browse full organizational hierarchy → use butlr_list_topology instead\n" +
    "- Need to analyze occupancy or sensor data → use this tool first to find IDs, then use data tools\n\n" +
    "Search Features: Fuzzy matching (handles typos), multi-field search (name, MAC, serial), score threshold (≥70), type filtering, result limiting (default 20, max 100)\n\n" +
    "Example Workflow: butlr_search_assets(query: 'café') → get room_cafe_123 → butlr_space_busyness(space_id_or_name: 'room_cafe_123')\n\n" +
    "See Also: butlr_get_asset_details, butlr_list_topology, butlr_fetch_entity_details",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Search term to match against asset names (e.g., 'cafe', 'SF Tower', 'floor 6')",
      },
      asset_types: {
        type: "array",
        items: {
          type: "string",
          enum: ["site", "building", "floor", "room", "zone", "sensor", "hive"],
        },
        description: "Optional: Filter to specific asset types. If omitted, searches all types.",
      },
      max_results: {
        type: "number",
        default: 20,
        description: "Maximum number of results to return (default: 20)",
      },
    },
    required: ["query"],
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
 * Input arguments for search_assets (inferred from Zod schema)
 */
export type SearchAssetsArgs = z.output<typeof SearchAssetsArgsSchema>;

/**
 * Search result with minimal fields
 */
export interface SearchResult {
  id: string;
  name: string;
  type: string;
  path: string; // Breadcrumb path
  match_score: number;
  // Parent context
  site_id?: string;
  building_id?: string;
  floor_id?: string;
  room_id?: string;
}

/**
 * Execute search_assets tool
 */
export async function executeSearchAssets(args: SearchAssetsArgs) {
  const maxResults = args.max_results;

  if (process.env.DEBUG) {
    console.error(
      `[search-assets] Searching for "${args.query}"` +
        (args.asset_types ? ` in types: ${args.asset_types.join(",")}` : "") +
        ` (max: ${maxResults})`
    );
  }

  // Use a generic cache key for full topology (we'll search across it)
  const cacheKey = generateTopologyCacheKey(
    process.env.BUTLR_ORG_ID || "default",
    true, // include devices for comprehensive search
    true, // include zones
    undefined
  );

  // Try to get cached topology
  let sites: any[] = [];
  const cached = getCachedTopology(cacheKey);

  if (cached && cached.data && cached.data.sites) {
    if (process.env.DEBUG) {
      console.error("[search-assets] Using cached topology for search");
    }
    sites = cached.data.sites as any[];
  } else {
    // Fetch fresh topology
    if (process.env.DEBUG) {
      console.error("[search-assets] Fetching fresh topology for search");
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
        console.error(`[search-assets] Warning: GraphQL errors present, but got data anyway`);
      }

      sites = result.data.sites.data;

      // Cache for future searches
      setCachedTopology(cacheKey, { sites });

      if (process.env.DEBUG) {
        console.error(`[search-assets] Cached topology with ${sites.length} sites`);
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

  // Flatten topology into searchable list
  const flattened = flattenTopology(sites);

  if (process.env.DEBUG) {
    console.error(`[search-assets] Flattened ${flattened.length} total assets`);
  }

  // Filter by asset types if specified
  let searchableAssets = flattened;
  if (args.asset_types && args.asset_types.length > 0) {
    searchableAssets = flattened.filter((asset) => args.asset_types!.includes(asset.type));

    if (process.env.DEBUG) {
      console.error(
        `[search-assets] Filtered to ${searchableAssets.length} assets of types: ${args.asset_types.join(",")}`
      );
    }
  }

  // Perform fuzzy search
  // Search on name, mac_address (sensors), and serialNumber (hives)
  const matches = searchAssets(searchableAssets, args.query, {
    matchFields: ["name", "mac_address", "serialNumber"],
    minScore: 70,
    maxResults,
  });

  if (process.env.DEBUG) {
    console.error(`[search-assets] Found ${matches.length} matches`);
  }

  // Format results with minimal fields
  const results: SearchResult[] = matches.map((match) => ({
    id: match.asset.id,
    name: match.asset.name,
    type: match.asset.type,
    path: buildAssetPath(match.asset),
    match_score: match.score,
    site_id: match.asset.site_id as string | undefined,
    building_id: match.asset.building_id as string | undefined,
    floor_id: match.asset.floor_id as string | undefined,
    room_id: match.asset.room_id as string | undefined,
  }));

  return {
    query: args.query,
    matches: results,
    total_matches: results.length,
    searched_assets: searchableAssets.length,
    timestamp: new Date().toISOString(),
  };
}
