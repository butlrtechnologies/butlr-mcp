import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { apolloClient } from "../clients/graphql-client.js";
import { gql } from "@apollo/client";
import { z } from "zod";
import { detectAssetType } from "../utils/asset-helpers.js";
import { type EntityType, ENTITY_TYPES, getValidatedFields } from "../utils/field-validator.js";
import { createValidationError } from "../errors/mcp-errors.js";
import { rethrowIfGraphQLError } from "../utils/graphql-helpers.js";
import type { FetchEntityDetailsResponse, EntityResult } from "../types/responses.js";

const FETCH_ENTITY_DETAILS_DESCRIPTION =
  "Retrieve specific fields for entities by ID with selective field fetching. " +
  "Supports mixed entity types in a single call (site_, building_, floor_, room_, zone_, sensor_, hive_). " +
  "Minimizes token usage by fetching only requested fields. " +
  "Default fields if none specified: Sites (id, name), Buildings (id, name), Floors (id, name, floorNumber), " +
  "Rooms (id, name), Zones (id, name), Sensors (id, mac_address), Hives (id, serialNumber).";

/** Shared shape — used by both registerTool (SDK schema) and full validation */
const fetchEntityDetailsInputShape = {
  ids: z
    .array(z.string())
    .min(1, "ids must contain at least 1 entity ID")
    .max(50, "ids cannot exceed 50 entities")
    .describe(
      "Entity IDs (mixed types supported: site_, building_, floor_, room_, zone_, sensor_, hive_)"
    ),

  site_fields: z
    .array(z.string())
    .optional()
    .describe("Optional: Fields to fetch for sites (e.g., ['timezone', 'siteNumber', 'customID'])"),

  building_fields: z
    .array(z.string())
    .optional()
    .describe("Optional: Fields for buildings (e.g., ['capacity', 'address', 'building_number'])"),

  floor_fields: z
    .array(z.string())
    .optional()
    .describe("Optional: Fields for floors (e.g., ['floorNumber', 'capacity', 'timezone'])"),

  room_fields: z
    .array(z.string())
    .optional()
    .describe("Optional: Fields for rooms (e.g., ['roomType', 'capacity', 'coordinates'])"),

  zone_fields: z
    .array(z.string())
    .optional()
    .describe("Optional: Fields for zones (e.g., ['roomID', 'capacity'])"),

  sensor_fields: z
    .array(z.string())
    .optional()
    .describe("Optional: Fields for sensors (e.g., ['name', 'mac_address', 'mode', 'is_online'])"),

  hive_fields: z
    .array(z.string())
    .optional()
    .describe("Optional: Fields for hives (e.g., ['name', 'serialNumber', 'isOnline'])"),
};

export const FetchEntityDetailsArgsSchema = z.object(fetchEntityDetailsInputShape).strict();

type FetchEntityDetailsArgs = z.output<typeof FetchEntityDetailsArgsSchema>;

/**
 * Build GraphQL query dynamically based on requested fields
 */
function buildQueryForFields(type: string, fields: string[]): ReturnType<typeof gql> {
  // Defense-in-depth: reject any field name that isn't a simple identifier
  for (const field of fields) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(field) || field.startsWith("__")) {
      throw new Error(`Invalid field name: ${field}`);
    }
  }
  const fieldList = fields.join("\n      ");

  switch (type) {
    case "site":
      return gql`
        query GetSiteDetails($id: ID!) {
          site(id: $id) {
            ${fieldList}
          }
        }
      `;

    case "building":
      return gql`
        query GetBuildingDetails($id: ID!) {
          building(id: $id) {
            ${fieldList}
          }
        }
      `;

    case "floor":
      return gql`
        query GetFloorDetails($id: ID!) {
          floor(id: $id) {
            ${fieldList}
          }
        }
      `;

    case "room":
      return gql`
        query GetRoomDetails($id: ID!) {
          room(id: $id) {
            ${fieldList}
          }
        }
      `;

    case "zone":
      return gql`
        query GetZoneDetails($id: ID!) {
          zone(id: $id) {
            ${fieldList}
          }
        }
      `;

    case "sensor":
      // Sensors API accepts ids parameter (batch query)
      return gql`
        query GetSensorDetails($ids: [String!]) {
          sensors(ids: $ids) {
            data {
              ${fieldList}
            }
          }
        }
      `;

    case "hive":
      // Hives API accepts both ids and serial_numbers (batch query)
      return gql`
        query GetHiveDetails($ids: [String!], $serial_numbers: [String!]) {
          hives(ids: $ids, serial_numbers: $serial_numbers) {
            data {
              ${fieldList}
            }
          }
        }
      `;

    default:
      throw createValidationError(`Unsupported asset type: ${type}`);
  }
}

/**
 * Execute butlr_fetch_entity_details tool
 */
export async function executeFetchEntityDetails(
  args: FetchEntityDetailsArgs
): Promise<FetchEntityDetailsResponse> {
  if (process.env.DEBUG) {
    console.error(`[butlr-fetch-entity-details] Fetching details for ${args.ids.length} asset(s)`);
  }

  // Group IDs by type
  const assetsByType: Record<string, string[]> = {};
  for (const id of args.ids) {
    const type = detectAssetType(id);
    if (type === "unknown") {
      throw createValidationError(`Unknown asset type for ID: ${id}`);
    }

    // Validate that detectAssetType returned a known EntityType
    if (!ENTITY_TYPES.includes(type as EntityType)) {
      throw createValidationError(`Unsupported asset type: ${type}`);
    }

    if (!assetsByType[type]) {
      assetsByType[type] = [];
    }
    assetsByType[type].push(id);
  }

  // Fetch assets by type
  const results: EntityResult[] = [];

  for (const [type, ids] of Object.entries(assetsByType)) {
    const entityType = type as EntityType;

    // Get fields for this type
    const fieldParam = `${type}_fields` as keyof FetchEntityDetailsArgs;
    const requestedFields = args[fieldParam] as string[] | undefined;

    // Validate and get final field list (defaults if none provided)
    const fields = getValidatedFields(entityType, requestedFields);

    // Build query
    const query = buildQueryForFields(type, fields);

    // For hives and sensors, batch query all at once
    if (type === "hive" || type === "sensor") {
      try {
        // Use ids for both types (API supports it)
        const variables = { ids };

        const { data, error } = await apolloClient.query({
          query,
          variables,
          fetchPolicy: "network-only",
        });

        if (error) {
          throw error;
        }

        // Extract assets from response
        const pluralType = type === "hive" ? "hives" : "sensors";
        const dataArray = (data as any)[pluralType]?.data || [];

        // Add all found assets
        for (const asset of dataArray) {
          results.push({
            ...asset,
            _type: type,
          });
        }

        // Report missing assets
        const foundIds = new Set(dataArray.map((a: any) => a.id));
        for (const id of ids) {
          if (!foundIds.has(id)) {
            if (process.env.DEBUG) {
              console.error(`[butlr-fetch-entity-details] Asset not found: ${id}`);
            }
            results.push({
              id,
              _type: type,
              error: "Asset not found",
            });
          }
        }
      } catch (error: unknown) {
        rethrowIfGraphQLError(error);
        throw error;
      }
    } else {
      // Query individually for other types (site, building, floor, room, zone)
      for (const id of ids) {
        try {
          const { data, error } = await apolloClient.query({
            query,
            variables: { id },
            fetchPolicy: "network-only",
          });

          if (error) {
            throw error;
          }

          const asset = (data as any)[type];

          if (asset) {
            results.push({
              ...asset,
              _type: type,
            });
          } else {
            if (process.env.DEBUG) {
              console.error(`[butlr-fetch-entity-details] Asset not found: ${id}`);
            }
            results.push({
              id,
              _type: type,
              error: "Asset not found",
            });
          }
        } catch (error: unknown) {
          rethrowIfGraphQLError(error);
          throw error;
        }
      }
    }
  }

  const failedCount = results.filter((r) => r.error).length;
  const response: FetchEntityDetailsResponse = {
    entities: results,
    requested_count: args.ids.length,
    fetched_count: results.filter((r) => !r.error).length,
    timestamp: new Date().toISOString(),
  };

  if (failedCount > 0) {
    response.warning = `${failedCount} of ${args.ids.length} entities failed to fetch. Check individual entity 'error' fields for details.`;
  }

  return response;
}

/**
 * Register butlr_fetch_entity_details with an McpServer instance
 */
export function registerFetchEntityDetails(server: McpServer): void {
  server.registerTool(
    "butlr_fetch_entity_details",
    {
      title: "Fetch Entity Details",
      description: FETCH_ENTITY_DETAILS_DESCRIPTION,
      inputSchema: fetchEntityDetailsInputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const validated = FetchEntityDetailsArgsSchema.parse(args);
      const result = await executeFetchEntityDetails(validated);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    }
  );
}
