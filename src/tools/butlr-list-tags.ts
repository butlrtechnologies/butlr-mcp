import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apolloClient } from "../clients/graphql-client.js";
import { GET_TAGS_WITH_USAGE } from "../clients/queries/tags.js";
import { rethrowIfGraphQLError } from "../utils/graphql-helpers.js";
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
};

export const ListTagsArgsSchema = z.object(listTagsInputShape).strict();

export type ListTagsArgs = z.output<typeof ListTagsArgsSchema>;

const LIST_TAGS_DESCRIPTION =
  "List every tag in the organization, with the footprint (count of rooms, zones, and floors each tag is applied to). Tags are org-scoped labels — the same tag can be attached to any mix of rooms, zones, and floors. Use this tool first to discover what tags exist and which entity types they apply to before calling tag-filtered queries.\n\n" +
  "Primary Users:\n" +
  "- All Users: Discover what tag vocabulary exists in the org and where each tag is used\n" +
  "- Workplace Manager: Find equipment, zone-type, or department tags before filtering availability\n" +
  "- Facilities Coordinator: Audit tag coverage across rooms vs. zones\n\n" +
  "Example Queries:\n" +
  '1. "What tags are used in this org?" → list everything\n' +
  '2. "Show me tags related to BSC" → name_contains: "bsc"\n' +
  '3. "Which tags are actually in use?" → min_usage: 1\n' +
  '4. "Find equipment tags applied to many zones" → list, then look at applied_to.zones\n\n' +
  "When to Use:\n" +
  "- Before any tag-based filter, to map a human term (e.g. 'bsc') to the right tag id and entity level\n" +
  "- To understand whether a tag lives on rooms, zones, floors, or several levels at once\n" +
  "- To audit tagging hygiene (unused tags, single-level tags, etc.)\n\n" +
  "When NOT to Use:\n" +
  "- You already have tag IDs and want the actual tagged rooms/zones — call the appropriate tag-filtered tool instead\n" +
  "- You want full topology browsing — use butlr_list_topology\n\n" +
  "Response Shape: { tags: [{ id, name, applied_to: { rooms, zones, floors } }], total, timestamp }. Tags are sorted by total usage descending (most-used first).\n\n" +
  "Note on coverage: spot-level tags exist in the data model but are not yet exposed by this tool — applied_to includes rooms, zones, and floors only.\n\n" +
  "See Also: butlr_available_rooms (uses tag IDs from this tool), butlr_search_assets, butlr_list_topology";

export interface TagFootprint {
  rooms: number;
  zones: number;
  floors: number;
}

export interface TagSummary {
  id: string;
  name: string;
  applied_to: TagFootprint;
}

export interface ListTagsResponse {
  tags: TagSummary[];
  total: number;
  timestamp: string;
  filtered_by?: Record<string, unknown>;
}

interface RawTag {
  id: string;
  name: string;
  organization_id?: string;
  rooms?: Array<{ id: string }> | null;
  zones?: Array<{ id: string }> | null;
  floors?: Array<{ id: string }> | null;
}

function totalUsage(t: TagSummary): number {
  return t.applied_to.rooms + t.applied_to.zones + t.applied_to.floors;
}

export async function executeListTags(args: ListTagsArgs): Promise<ListTagsResponse> {
  debug("list-tags", "Listing tags with args:", JSON.stringify(args));

  let rawTags: RawTag[] = [];

  try {
    const result = await apolloClient.query<{ tags: RawTag[] | null }>({
      query: GET_TAGS_WITH_USAGE,
      fetchPolicy: "network-only",
    });

    rawTags = result.data?.tags ?? [];
  } catch (error: unknown) {
    rethrowIfGraphQLError(error);
    throw error;
  }

  let tags: TagSummary[] = rawTags.map((t) => ({
    id: t.id,
    name: t.name,
    applied_to: {
      rooms: t.rooms?.length ?? 0,
      zones: t.zones?.length ?? 0,
      floors: t.floors?.length ?? 0,
    },
  }));

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

  if (Object.keys(args).length > 0) {
    response.filtered_by = args;
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
