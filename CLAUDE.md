# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is the **Butlr MCP Server** - a Model Context Protocol (MCP) adapter that will provide secure, read-only access to Butlr occupancy and asset data through natural-language interfaces. The server will translate high-level queries into parameterized API calls against Butlr's GraphQL and REST endpoints, handling authentication, rate limiting, caching, and response normalization.

**Current Status:** ✅ 10 active tools (4 conversational + 2 data + 4 foundation) with full infrastructure (v3 API clients, caching, natural language utilities).

## Planned Architecture

The MCP server will act as a middleware layer between LLM clients and Butlr's APIs:

```
LLM Client (Desktop apps, VS Code, etc.)
 │
 │ MCP stdio (spawn process)
 ▼
Butlr MCP Server (Node.js)
 ├── Tool registry (T1–T3)
 ├── Auth & token refresh
 ├── Rate limiter & caching
 ├── Response normalizer
 └── Error translator
     │
     ├── Butlr GraphQL API (asset topology, device inventory)
     └── Butlr Reporting REST API (occupancy timeseries)
```

### MCP Tools (10 Active + 4 Planned)

Question-driven design: tools answer user questions, not map to API endpoints.

**Tier 1: Conversational Tools** - Answer user questions with natural language
1. **`butlr_hardware_snapshot`** ✅ - "How are our devices doing?"
2. **`butlr_available_rooms`** ✅ - "Are there conference rooms free?"
3. **`butlr_space_busyness`** ✅ - "How busy is the café?"
4. **`butlr_traffic_flow`** ✅ - "How many people entered today?"
5. **`butlr_now_summary`** 📋 PLANNED - "What's the office like right now?"
6. **`butlr_top_used_spaces`** 📋 PLANNED - "What are the most used rooms?"
7. **`butlr_usage_trend`** 📋 PLANNED - "Is this room used more than last week?"
8. **`butlr_space_insights`** 📋 PLANNED - "Tell me something interesting about my office"

**Tier 2: Data Tools** - Raw data access for power users
9. **`butlr_search_assets`** ✅ - Fuzzy asset search
10. **`butlr_get_asset_details`** ✅ - Full asset details by ID

**Tier 3: Foundation Tools** - Validation/debugging for developers
11. **`butlr_list_topology`** ✅ - Tree view of org hierarchy
12. **`butlr_fetch_entity_details`** ✅ - Selective field fetching
13. **`butlr_get_occupancy_timeseries`** ✅ - Timeseries occupancy data
14. **`butlr_get_current_occupancy`** ✅ - Current occupancy snapshot

See `docs/MCP_TOOLS_DESIGN.md` for complete specifications.

### Key Design Principles

- **Question-driven design**: Tools answer user questions, not map to API endpoints (follows MCP best practice: "avoid mapping every endpoint to a tool")
- **Natural language outputs**: Conversational summaries + structured data for Slack/Teams bots
- **Server-side computation**: Pre-compute insights (labels, trends, rankings) for better UX
- **Two-tier architecture**: Conversational tools (90% of queries) + data tools (10% for power users)
- **Read-only access**: All tools enforce read-only scopes to protect customer data
- **Response normalization**: Convert GraphQL and REST responses to stable JSON shapes with ISO-8601 timestamps
- **Error translation**: Map HTTP/GraphQL to structured MCP errors (`AUTH_EXPIRED`, `RATE_LIMITED`, `VALIDATION_FAILED`)
- **Selective toolsets**: (Planned) Support `BUTLR_TOOLSETS` to enable/disable tool groups (conversational, data)

## Planned Technical Stack

- **Language**: Node.js >= 18, TypeScript for type safety
- **Transport**: MCP over stdio for maximum host compatibility
- **Packaging**: Publish as `@butlr/butlr-mcp-server` with CLI entry point at `bin/cli.js`
- **Key Dependencies** (to be added):
  - Butlr GraphQL & REST client libraries
  - JSON Schema validation
  - Rate limiters and caching (`lru-cache`)
  - MCP SDK

## Planned Project Structure

```
butlr-mcp-server/
├── src/
│   ├── index.ts           # Main entry point, stdio transport setup
│   ├── tools/             # Tool implementations
│   ├── clients/           # Butlr API clients (GraphQL, REST)
│   ├── normalizers/       # Response normalization logic
│   ├── cache/             # Caching layer with TTL
│   └── errors/            # MCP error translation
├── bin/
│   └── cli.js             # CLI entry point for npx
├── .claude/tasks/         # Task tracking (not in git)
└── CLAUDE.md              # Agent instructions for Claude Code
```

**Note**: This structure is preliminary and will be refined during implementation.

## Development Commands

```bash
# Development with hot-reload
npm run dev

# Development with debug logging
npm run dev:debug  # Will set DEBUG=butlr-mcp

# Build TypeScript
npm run build

# Run tests
npm test

# Run tests for specific file
npm test -- path/to/test

# Local testing without publishing
npx .

# Link for global testing
npm link
npm unlink  # when done
```

## Planned Environment Variables

All configuration will use environment variables or CLI flags (flags override env vars):

| Variable | Required | Purpose |
|----------|----------|---------|
| `BUTLR_CLIENT_ID` | Yes | OAuth2 client ID for Butlr API |
| `BUTLR_CLIENT_SECRET` | Yes | OAuth2 client secret for Butlr API |
| `BUTLR_ORG_ID` | Yes* | Organization ID (*or provide via `--org-id` flag) |
| `BUTLR_BASE_URL` | No | API base URL (default: `https://api.butlr.io`) |
| `BUTLR_TIMEZONE` | No | Default timezone for reports (default: `UTC`) |
| `MCP_CACHE_TOPO_TTL` | No | Topology cache TTL in seconds (default: 600) |
| `MCP_MAX_IDS` | No | Max IDs per request (prevents fan-out) |
| `MCP_MAX_LOOKBACK_DAYS` | No | Max days for timeseries queries |
| `MCP_CONCURRENCY` | No | Max concurrent upstream API calls |
| `DEBUG` | No | Set to `butlr-mcp` for verbose logging |
| `BUTLR_TOOLSETS` | No | Planned - not yet implemented. Comma-separated list: `"occupancy,topology,devices"` |

**Security**: Never commit credentials. Store in `.env` file (add to `.gitignore`) or shell environment.

## Planned CLI Flags

The CLI supports:
- `--org-id` - Organization ID
- `--client-id` - OAuth2 client ID
- `--client-secret` - OAuth2 client secret
- `--base-url` - Base URL for Butlr APIs
- `--cache-ttl` - Cache TTL in seconds
- `--max-ids` - Maximum IDs per call
- `--toolsets` - Enabled tool groups (planned - not yet implemented)

## Testing Approach

- Use Vitest or Jest for testing framework
- Mock Butlr GraphQL and REST APIs to simulate responses
- Write contract tests to ensure tool schemas produce deterministic outputs
- Test response normalization (ISO-8601 timestamps, consistent keys)
- Test error translation from HTTP/GraphQL to MCP error codes
- Test rate limiting and caching behavior

## Key Implementation Considerations

### Response Normalization
- All timestamps must be ISO-8601 format
- Consistent field naming across GraphQL and REST sources
- Stable enumeration values
- Include metadata about query parameters in responses

### Caching Strategy
- In-memory caches for topology and ID maps (use TTLs)
- Short-lived memoization for repetitive timeseries calls
- Cache hits/misses logged when `DEBUG=butlr-mcp`

### Error Handling
Convert upstream errors to actionable MCP errors:
- 401/403 → `AUTH_EXPIRED` (with token refresh hint)
- 429 → `RATE_LIMITED` (with retry-after info)
- 400 → `VALIDATION_FAILED` (with schema hints)
- Network errors → clear error messages for debugging

### JSON Schema Validation
- All tool input schemas must be valid JSON Schema
- Include `additionalProperties: false` to reject unknown inputs
- Return deterministic fields in responses
- Implement pagination with `next_cursor` pattern
