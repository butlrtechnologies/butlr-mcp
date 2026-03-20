import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apolloClient } from "../clients/graphql-client.js";
import { gql } from "@apollo/client";
import { z } from "zod";
import {
  translateGraphQLError,
  formatMCPError,
  createValidationError,
} from "../errors/mcp-errors.js";
import { detectAssetType } from "../utils/asset-helpers.js";

/**
 * Zod validation for get_asset_details
 */
const assetIdSchema = z
  .string()
  .min(1, "Asset ID cannot be empty")
  .refine(
    (val) => {
      const validPrefixes = ["site_", "building_", "space_", "floor_", "room_", "zone_"];
      return validPrefixes.some((prefix) => val.startsWith(prefix));
    },
    {
      message:
        "Asset ID must start with valid prefix: site_, building_, floor_, space_, room_, or zone_. For sensor/hive details, use butlr_search_assets or butlr_hardware_snapshot.",
    }
  );

/** Shared shape — used by both registerTool and full validation */
const getAssetDetailsInputShape = {
  ids: z
    .array(assetIdSchema)
    .min(1, "ids array must contain at least 1 asset ID")
    .max(50, "ids array cannot exceed 50 assets")
    .describe("Asset IDs to fetch (e.g., ['room_123', 'floor_456'])"),
  include_children: z.boolean().default(true).describe("Include child assets"),
  include_devices: z.boolean().default(false).describe("Include sensors and hives"),
  include_parent_context: z.boolean().default(true).describe("Include parent names for context"),
};

export const GetAssetDetailsArgsSchema = z
  .object(getAssetDetailsInputShape)
  .strict()
  .refine(
    (data) => {
      const unique = new Set(data.ids);
      return unique.size === data.ids.length;
    },
    {
      message: "ids array contains duplicate asset IDs",
      path: ["ids"],
    }
  );

const GET_ASSET_DETAILS_DESCRIPTION =
  "Get comprehensive details for specific assets by ID (sites, buildings, floors, rooms, zones). Automatically detects asset type from ID prefix and returns appropriate fields. Supports batch queries (multiple IDs), optional child/parent context, and device inclusion. Essential for configuration validation, integration development, and detailed asset inspection.\n\n" +
  "Primary Users:\n" +
  "- IT Manager: Verify sensor configurations (mode, model, online status), validate floor/building setups\n" +
  "- Field Technician: Get sensor MAC addresses, hive serial numbers, and physical coordinates before site visits\n" +
  "- Facilities Manager: Verify room capacities, areas, and metadata for space planning\n" +
  "- Developer/Integrator: Fetch asset metadata for building workplace apps, dashboards, or integrations\n\n" +
  "Example Queries:\n" +
  '1. "Show me full details for Conference Room 401" (after finding ID via search)\n' +
  '2. "Get sensor configuration for all sensors on Floor 3" (mode, model, MAC, online status)\n' +
  '3. "Show me all rooms on Floor 6 with their capacities and areas"\n' +
  '4. "Get building details including all floors and their room counts"\n' +
  "5. \"Show me sensor MAC addresses for Room 'Café Barista' for field tech visit\"\n" +
  '6. "Get hive serial numbers and online status for Building 2"\n' +
  '7. "Show me site timezone and all buildings in the Chicago office"\n' +
  '8. "Get room coordinates and rotation for floor plan mapping"\n\n' +
  "When to Use:\n" +
  "- Have asset IDs and need detailed configuration, metadata, or relationships\n" +
  "- Validating sensor/hive assignments for troubleshooting (which hive is this sensor on?)\n" +
  "- Need room capacities, areas, or coordinates for space planning or floor plan integrations\n" +
  "- Preparing for field technician site visit (need device identifiers: MACs, serials)\n" +
  "- Building integrations and need to fetch parent context (room → floor → building → site)\n\n" +
  "When NOT to Use:\n" +
  "- Don't have asset IDs yet → use butlr_search_assets first to find IDs by name\n" +
  "- Need real-time occupancy or sensor data → use occupancy/traffic tools instead\n" +
  "- Want to browse organizational hierarchy → use butlr_list_topology for tree view\n" +
  "- Need to update/configure assets → this is read-only; use Butlr Dashboard for changes\n\n" +
  "Options: include_children (default true), include_devices (default false), include_parent_context (default true)\n\n" +
  "Batch Query: Supports multiple IDs in single call - mixed asset types supported\n\n" +
  "See Also: butlr_search_assets, butlr_list_topology, butlr_fetch_entity_details, butlr_hardware_snapshot";

/**
 * Input arguments for get_asset_details (output type from Zod schema after defaults applied)
 */
export type GetAssetDetailsArgs = z.output<typeof GetAssetDetailsArgsSchema>;

/**
 * Build GraphQL query based on asset type and options
 */
function buildQuery(
  type: string,
  includeChildren: boolean,
  includeDevices: boolean,
  includeParentContext: boolean
): ReturnType<typeof gql> {
  switch (type) {
    case "site":
      return gql`
        query GetSiteDetails($id: ID!) {
          site(id: $id) {
            id
            name
            timezone
            siteNumber
            customID
            ${
              includeChildren
                ? `
            buildings {
              id
              name
              building_number
              capacity { max mid }
              ${
                includeChildren
                  ? `
              floors {
                id
                name
                floorNumber
              }
              `
                  : ""
              }
            }
            `
                : ""
            }
          }
        }
      `;

    case "building":
      return gql`
        query GetBuildingDetails($id: ID!) {
          building(id: $id) {
            id
            name
            building_number
            customID
            capacity { max mid }
            address { lines country }
            ${
              includeParentContext
                ? `
            site {
              id
              name
              timezone
            }
            `
                : ""
            }
            ${
              includeChildren
                ? `
            floors {
              id
              name
              floorNumber
              timezone
              capacity { max mid }
            }
            `
                : ""
            }
          }
        }
      `;

    case "floor":
      return gql`
        query GetFloorDetails($id: ID!) {
          floor(id: $id) {
            id
            name
            floorNumber
            timezone
            installation_date
            installation_status
            customID
            capacity { max mid }
            area { value unit }
            ${
              includeParentContext
                ? `
            building {
              id
              name
              building_number
              site {
                id
                name
                timezone
              }
            }
            `
                : ""
            }
            ${
              includeChildren
                ? `
            rooms {
              id
              name
              roomType
              customID
              capacity { max mid }
              coordinates
            }
            zones {
              id
              name
              roomID
              customID
              coordinates
            }
            `
                : ""
            }
            ${
              includeDevices
                ? `
            sensors {
              id
              name
              mac_address
              mode
              model
              roomID
              hive_serial
              is_online
            }
            hives {
              id
              name
              serialNumber
              roomID
              isOnline
              coordinates
            }
            `
                : ""
            }
          }
        }
      `;

    case "room":
      return gql`
        query GetRoomDetails($id: ID!) {
          room(id: $id) {
            id
            name
            roomType
            customID
            capacity { max mid }
            area { value unit }
            coordinates
            rotation
            note
            ${
              includeParentContext
                ? `
            floor {
              id
              name
              floorNumber
              building {
                id
                name
                site {
                  id
                  name
                }
              }
            }
            `
                : ""
            }
            ${
              includeDevices
                ? `
            sensors {
              id
              name
              mac_address
              mode
              model
              is_online
              hive_serial
            }
            `
                : ""
            }
          }
        }
      `;

    case "zone":
      return gql`
        query GetZoneDetails($id: ID!) {
          zone(id: $id) {
            id
            name
            roomID
            customID
            capacity { max mid }
            area { value unit }
            coordinates
            rotation
            note
            ${
              includeDevices
                ? `
            sensors {
              id
              name
              mac_address
              is_online
            }
            `
                : ""
            }
          }
        }
      `;

    default:
      throw createValidationError(`Unsupported asset type: ${type}`);
  }
}

/**
 * Execute get_asset_details tool
 */
export async function executeGetAssetDetails(args: GetAssetDetailsArgs) {
  const includeChildren = args.include_children !== false; // Default true
  const includeDevices = args.include_devices === true; // Default false
  const includeParentContext = args.include_parent_context !== false; // Default true

  if (process.env.DEBUG) {
    console.error(
      `[get-asset-details] Fetching details for ${args.ids.length} asset(s): ${args.ids.join(", ")}`
    );
  }

  // Group IDs by type
  const assetsByType: Record<string, string[]> = {};
  for (const id of args.ids) {
    const type = detectAssetType(id);
    if (type === "unknown") {
      if (process.env.DEBUG) {
        console.error(`[get-asset-details] Warning: Unknown asset type for ID: ${id}`);
      }
      continue;
    }

    if (!assetsByType[type]) {
      assetsByType[type] = [];
    }
    assetsByType[type].push(id);
  }

  // Fetch all assets in parallel (grouped by type for query selection)
  const fetchPromises: Array<{ id: string; type: string; promise: Promise<unknown> }> = [];

  for (const [type, ids] of Object.entries(assetsByType)) {
    const query = buildQuery(type, includeChildren, includeDevices, includeParentContext);

    for (const id of ids) {
      fetchPromises.push({
        id,
        type,
        promise: apolloClient.query({ query, variables: { id }, fetchPolicy: "network-only" }),
      });
    }
  }

  const settled = await Promise.allSettled(fetchPromises.map((f) => f.promise));

  const results: Array<Record<string, unknown>> = [];

  for (let i = 0; i < settled.length; i++) {
    const { id, type } = fetchPromises[i];
    const outcome = settled[i];

    if (outcome.status === "fulfilled") {
      const { data, error } = outcome.value as { data: Record<string, unknown>; error?: unknown };
      if (error) {
        const mcpError = translateGraphQLError(
          error as Parameters<typeof translateGraphQLError>[0]
        );
        results.push({ id, error: formatMCPError(mcpError), _type: type });
        continue;
      }
      const asset = data[type];
      if (asset && typeof asset === "object") {
        results.push({ ...(asset as Record<string, unknown>), _type: type });
      } else if (process.env.DEBUG) {
        console.error(`[get-asset-details] Asset not found: ${id}`);
      }
    } else {
      const err = outcome.reason;
      if (err && (err.graphQLErrors || err.networkError)) {
        const mcpError = translateGraphQLError(err);
        if (process.env.DEBUG) {
          console.error(`[get-asset-details] Error fetching ${id}:`, formatMCPError(mcpError));
        }
        results.push({ id, error: formatMCPError(mcpError), _type: type });
      } else {
        throw err;
      }
    }
  }

  return {
    assets: results,
    total_count: results.length,
    requested_count: args.ids.length,
    options: {
      include_children: includeChildren,
      include_devices: includeDevices,
      include_parent_context: includeParentContext,
    },
    timestamp: new Date().toISOString(),
  };
}

/**
 * Register butlr_get_asset_details with an McpServer instance
 */
export function registerGetAssetDetails(server: McpServer): void {
  server.registerTool(
    "butlr_get_asset_details",
    {
      title: "Get Butlr Asset Details",
      description: GET_ASSET_DETAILS_DESCRIPTION,
      inputSchema: getAssetDetailsInputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const validated = GetAssetDetailsArgsSchema.parse(args);
      const result = await executeGetAssetDetails(validated);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
