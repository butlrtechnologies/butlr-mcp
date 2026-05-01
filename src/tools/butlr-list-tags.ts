import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { apolloClient } from "../clients/graphql-client.js";
import {
  GET_TAGS_WITH_USAGE,
  type RawTagWithUsage,
  type TaggedEntityRef,
} from "../clients/queries/tags.js";
import { rethrowIfGraphQLError, throwIfGraphQLErrors } from "../utils/graphql-helpers.js";
import { projectValidRefs } from "../utils/tag-resolver.js";
import { withToolErrorHandling, throwInternalError } from "../errors/mcp-errors.js";
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
      "When true, each tag's response includes `applied_to_entities` with the id and name of every valid tagged room, zone, and floor (not just counts). Refs without a usable id (deleted entities whose tag link survived; partial GraphQL responses) are dropped silently — `applied_to.{rooms,zones,floors}` counts are derived from the SAME filtered list so they cannot disagree. Default false to keep the response token-light; set true when you need to know exactly which entities are tagged without follow-up calls."
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
  "Response Shape: { tags: [{ id, name, applied_to: { rooms: number, zones: number, floors: number }, applied_to_entities?: { rooms: [{id, name?}], zones: [{id, name?}], floors: [{id, name?}] } }], total, timestamp }. Tags are sorted by total usage descending. `applied_to_entities` is present only when include_entities=true; the inner `name` is best-effort (omitted when upstream returns no name for the tagged entity).\n\n" +
  "Note on coverage: spot-level tags exist in the data model but are not yet exposed by this tool — applied_to and applied_to_entities cover rooms, zones, and floors only.\n\n" +
  "See Also: butlr_list_topology (tag_names filter for tagged subtrees), butlr_available_rooms (uses tag names from this tool), butlr_search_assets";

export interface TagFootprint {
  readonly rooms: number;
  readonly zones: number;
  readonly floors: number;
}

export interface TaggedEntities {
  readonly rooms: ReadonlyArray<TaggedEntityRef>;
  readonly zones: ReadonlyArray<TaggedEntityRef>;
  readonly floors: ReadonlyArray<TaggedEntityRef>;
}

export interface TagSummary {
  readonly id: string;
  readonly name: string;
  readonly applied_to: TagFootprint;
  readonly applied_to_entities?: TaggedEntities;
}

export interface ListTagsResponse {
  readonly tags: ReadonlyArray<TagSummary>;
  readonly total: number;
  readonly timestamp: string;
  readonly filtered_by?: Record<string, unknown>;
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
    // Distinguish "empty array" (legitimate — org has no tags) from
    // "null" (upstream contract violation — should be `[]` if empty).
    // `?? []` would silently equate the two, hiding a real signal.
    const tags = result.data?.tags;
    if (tags !== null && tags !== undefined && !Array.isArray(tags)) {
      throwInternalError(
        "Unexpected response shape from tags query (expected array, got " +
          `${typeof tags}). Please retry; if persistent, the upstream API contract may have changed.`
      );
    }
    rawTags = tags ?? [];
  } catch (error: unknown) {
    rethrowIfGraphQLError(error);
    throw error;
  }

  // `projectValidRefs` filters out refs without a usable id (dangling
  // associations after a hard delete, or partial GraphQL responses).
  // Counts and the optional entity array are computed off the same
  // filtered list so they cannot disagree within a single response. The
  // helper is shared with `butlr_list_topology` so the validity predicate
  // lives in one place — if the rule ever tightens, both tools update
  // together.
  let tags: TagSummary[] = rawTags.map((t) => {
    const rooms = projectValidRefs(t.rooms);
    const zones = projectValidRefs(t.zones);
    const floors = projectValidRefs(t.floors);
    const applied_to: TagFootprint = {
      rooms: rooms.length,
      zones: zones.length,
      floors: floors.length,
    };
    return args.include_entities
      ? {
          id: t.id,
          name: t.name,
          applied_to,
          applied_to_entities: { rooms, zones, floors },
        }
      : { id: t.id, name: t.name, applied_to };
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

  // Surface the args used to filter, but only when at least one filter was
  // actually supplied. `include_entities` defaults to false at the schema
  // layer so it's always set on `args`; treat the all-defaults case as
  // "no filter applied".
  const { include_entities, ...rest } = args;
  const explicitFilters: Record<string, unknown> = { ...rest };
  if (include_entities === true) explicitFilters.include_entities = true;
  const hasFilters = Object.keys(explicitFilters).length > 0;

  return {
    tags,
    total: tags.length,
    timestamp: new Date().toISOString(),
    ...(hasFilters ? { filtered_by: explicitFilters } : {}),
  };
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
