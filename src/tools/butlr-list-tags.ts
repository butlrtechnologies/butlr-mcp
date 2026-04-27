import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apolloClient } from "../clients/graphql-client.js";
import {
  GET_TAGS_WITH_USAGE,
  type RawTagWithUsage,
  type TaggedEntityRef,
} from "../clients/queries/tags.js";
import { rethrowIfGraphQLError, throwIfGraphQLErrors } from "../utils/graphql-helpers.js";
import { withToolErrorHandling } from "../errors/mcp-errors.js";
import { debug } from "../utils/debug.js";

const listTagsInputShape = {
  name_contains: z
    .string()
    .min(1, "name_contains cannot be empty")
    .max(200, "name_contains too long (max: 200 chars)")
    .optional()
    .describe("Case-insensitive substring filter on tag name"),

  min_usage: z
    .number()
    .int("min_usage must be an integer")
    .min(0, "min_usage must be >= 0")
    .max(100000)
    .optional()
    .describe(
      "Exclude tags whose total application count (rooms + zones + floors) is below this threshold"
    ),

  include_entities: z
    .boolean()
    .default(false)
    .describe(
      "When true, each tag's response includes `applied_to_entities` with the id and name of every tagged room, zone, and floor (not just counts). Default false to keep the default response token-light; set true when you need to know exactly which entities are tagged without follow-up calls."
    ),
};

export const ListTagsArgsSchema = z.object(listTagsInputShape).strict();

export type ListTagsArgs = z.output<typeof ListTagsArgsSchema>;

const LIST_TAGS_DESCRIPTION =
  "List every tag in the organization, with the footprint (count of rooms, zones, and floors each tag is applied to). Tags are org-scoped labels — the same tag can be attached to any mix of rooms, zones, and floors. Use this tool first to discover what tags exist and which entity types they apply to before calling tag-filtered queries.\n\n" +
  "Primary Users:\n" +
  "- All Users: Discover what tag vocabulary exists in the org and where each tag is used\n" +
  "- Workplace Manager: Find room-type, zone-type, or department tags before filtering availability\n" +
  "- Facilities Coordinator: Audit tag coverage across rooms vs. zones\n\n" +
  "Example Queries:\n" +
  '1. "What tags are used in this org?" → list everything\n' +
  '2. "Show me video-conferencing tags" → name_contains: "videoconf"\n' +
  '3. "Which tags are actually in use?" → min_usage: 1\n' +
  '4. "Find tags applied to many zones" → list, then look at applied_to.zones\n' +
  '5. "What rooms and zones are tagged \'huddle\'?" → name_contains: "huddle", include_entities: true\n\n' +
  "When to Use:\n" +
  "- Before any tag-based filter, to map a human term (e.g. 'videoconf') to the right tag id and entity level\n" +
  "- To understand whether a tag lives on rooms, zones, floors, or several levels at once\n" +
  "- To audit tagging hygiene (unused tags, single-level tags, etc.)\n" +
  "- With include_entities=true, to enumerate every tagged entity in one call (avoids per-tag follow-up to butlr_get_asset_details)\n\n" +
  "When NOT to Use:\n" +
  "- You want full topology browsing — use butlr_list_topology (supports tag_names filter for tagged-only views)\n" +
  "- You only need available rooms by tag — use butlr_available_rooms\n\n" +
  "Response Shape: { tags: [{ id, name, applied_to: { rooms: number, zones: number, floors: number }, applied_to_entities?: { rooms: [{id, name}], zones: [{id, name}], floors: [{id, name}] } }], total, timestamp }. Tags are sorted by total usage descending. `applied_to_entities` is present only when include_entities=true.\n\n" +
  "Note on coverage: spot-level tags exist in the data model but are not yet exposed by this tool — applied_to and applied_to_entities cover rooms, zones, and floors only.\n\n" +
  "See Also: butlr_list_topology (tag_names filter for tagged subtrees), butlr_available_rooms (uses tag names from this tool), butlr_search_assets";

export interface TagFootprint {
  rooms: number;
  zones: number;
  floors: number;
}

export interface TaggedEntities {
  rooms: TaggedEntityRef[];
  zones: TaggedEntityRef[];
  floors: TaggedEntityRef[];
}

export interface TagSummary {
  id: string;
  name: string;
  applied_to: TagFootprint;
  applied_to_entities?: TaggedEntities;
}

export interface ListTagsResponse {
  tags: TagSummary[];
  total: number;
  timestamp: string;
  filtered_by?: Record<string, unknown>;
}

function totalUsage(t: TagSummary): number {
  return t.applied_to.rooms + t.applied_to.zones + t.applied_to.floors;
}

export async function executeListTags(args: ListTagsArgs): Promise<ListTagsResponse> {
  debug("list-tags", "Listing tags with args:", JSON.stringify(args));

  let rawTags: RawTagWithUsage[] = [];

  try {
    const result = await apolloClient.query<{ tags: RawTagWithUsage[] | null }>({
      query: GET_TAGS_WITH_USAGE,
      fetchPolicy: "network-only",
    });

    throwIfGraphQLErrors(result);
    rawTags = result.data?.tags ?? [];
  } catch (error: unknown) {
    rethrowIfGraphQLError(error);
    throw error;
  }

  // Per R1 §2.2: filter out refs without a usable id (dangling associations
  // after a hard delete, or partial GraphQL responses). Counts and the
  // optional entity array are computed off the same filtered list so they
  // can never disagree within a single response.
  const project = (refs: RawTagWithUsage["rooms"]): TaggedEntityRef[] =>
    (refs ?? []).flatMap((e) =>
      typeof e.id === "string" && e.id.length > 0
        ? [typeof e.name === "string" ? { id: e.id, name: e.name } : { id: e.id }]
        : []
    );

  let tags: TagSummary[] = rawTags.map((t) => {
    const rooms = project(t.rooms);
    const zones = project(t.zones);
    const floors = project(t.floors);
    const summary: TagSummary = {
      id: t.id,
      name: t.name,
      applied_to: {
        rooms: rooms.length,
        zones: zones.length,
        floors: floors.length,
      },
    };
    if (args.include_entities) {
      summary.applied_to_entities = { rooms, zones, floors };
    }
    return summary;
  });

  if (args.name_contains) {
    const needle = args.name_contains.toLowerCase();
    tags = tags.filter((t) => t.name.toLowerCase().includes(needle));
  }

  if (args.min_usage !== undefined) {
    const threshold = args.min_usage;
    tags = tags.filter((t) => totalUsage(t) >= threshold);
  }

  tags.sort((a, b) => totalUsage(b) - totalUsage(a));

  const response: ListTagsResponse = {
    tags,
    total: tags.length,
    timestamp: new Date().toISOString(),
  };

  // Surface the args used to filter, but only when at least one filter was
  // actually supplied. `include_entities` defaults to false at the schema
  // layer so it's always set on `args`; treat the all-defaults case as
  // "no filter applied".
  const explicitFilters = { ...args };
  if (explicitFilters.include_entities === false) {
    delete (explicitFilters as Partial<typeof args>).include_entities;
  }
  if (Object.keys(explicitFilters).length > 0) {
    response.filtered_by = explicitFilters;
  }

  return response;
}

export function registerListTags(server: McpServer): void {
  server.registerTool(
    "butlr_list_tags",
    {
      title: "List Butlr Tags",
      description: LIST_TAGS_DESCRIPTION,
      inputSchema: listTagsInputShape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    withToolErrorHandling(async (args) => {
      const validated = ListTagsArgsSchema.parse(args);
      const result = await executeListTags(validated);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
      };
    })
  );
}
