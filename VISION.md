# Butlr MCP Server — Design & Local Development Guide

## Vision

Provide a secure, read-only **Model Context Protocol (MCP)** adapter that allows customers to query their Butlr occupancy and asset data via natural-language interfaces such as chatbots. The Butlr MCP server should translate high-level questions (e.g. "Show me the hourly occupancy in all rooms on Floor 7 last week") into parameterized API calls against Butlr's GraphQL and REST endpoints and return normalized results suitable for LLMs. It should enforce authentication, rate limits and consistent schemas and expose only a curated set of safe tools so that agents cannot abuse the underlying APIs.

## Problem Statement

Customers currently need to know their room or zone IDs, choose between GraphQL or REST endpoints, manage pagination and rate-limits, and normalize heterogeneous response formats when querying Butlr data. This complexity leads to inconsistent implementations and slows adoption. A well-designed MCP server abstracts these details and lets clients focus on intent rather than API mechanics.

## Goals

1. **Expose a small set of high-value tools** covering common Butlr use cases (occupancy time series, asset topology, device inventory). Each tool should have a clear input schema and deterministic output shape.

2. **Centralize authentication and error handling**. The server should accept a Butlr API token and handle refresh, rate limiting and caching internally.

3. **Normalize responses** from GraphQL and REST to stable JSON shapes (ISO-8601 timestamps, consistent enumeration values and keys) so agents don't need to understand Butlr's native formats.

4. **Protect customer data** by following least-privilege principles, enforcing read-only scopes and offering a way to select only the tools needed.

5. **Be easy to adopt**: packaged as an npm module with a CLI that can be run via `npx`, with sensible defaults and environment variables for configuration.

## MCP Tools Overview

The Butlr MCP Server provides **10 tools** organized into two tiers: **Conversational Tools** (answer user questions) and **Data Tools** (raw data access). **6 tools are currently operational** (4 conversational + 2 data). See `docs/MCP_TOOLS_DESIGN.md` for complete specifications.

### Design Philosophy: Question-Driven Architecture

**Traditional Approach (API-Driven):**
Tools map to API endpoints → Agents must understand Butlr APIs and compute insights

**Our Approach (Question-Driven):**
Tools answer user questions → Agents ask natural questions, get conversational answers

**Benefits:**
- ✅ Follows MCP best practice: "Avoid mapping every API endpoint to a new MCP tool"
- ✅ Reduces LLM confusion (9 focused tools vs many generic ones)
- ✅ Natural language outputs perfect for Slack/Teams bots
- ✅ Server-side computation reduces token usage and latency

### Implementation Status

#### Tier 1: Conversational Tools (8 tools)

**Operational Health:**
1. **`butlr_hardware_snapshot`** ✅ IMPLEMENTED - *"How are our devices doing?"*
   - Unified device health: online/offline + battery status
   - Context-efficient: summaries by default, detailed lists on request
   - Includes MAC addresses (sensors) and serial numbers (hives)
   - Battery tracking: critical/due_soon/healthy buckets

**Real-Time Awareness:**
2. **`butlr_available_rooms`** ✅ IMPLEMENTED - *"Are there conference rooms free?"*
   - Find unoccupied rooms filtered by capacity/tags
   - Returns natural language summary + structured data
   - Cache integration for <2s response time

3. **`butlr_space_busyness`** ✅ IMPLEMENTED - *"How busy is the café?"*
   - Qualitative labels (quiet/moderate/busy)
   - Compares to typical occupancy for day/time
   - Business recommendations included

4. **`butlr_traffic_flow`** ✅ IMPLEMENTED - *"How many people entered the lobby today?"*
   - Entry/exit counts for traffic-mode sensors
   - Hourly breakdown and peak hour identification
   - Time window presets (20m, 1h, today, custom)

**Summary & Insights:**
5. **`butlr_now_summary`** 📋 PLANNED - *"What's the office like right now?"*
   - Building snapshot: occupancy %, busiest floors, available rooms
   - Quick decision-making for facility managers

6. **`butlr_space_insights`** 📋 PLANNED - *"Tell me something interesting"*
   - AI-generated insights: underutilized spaces, patterns, anomalies
   - Recommendations with potential ROI

**Usage Analysis:**
7. **`butlr_top_used_spaces`** 📋 PLANNED - *"What are the most used rooms?"*
   - Rank spaces by utilization over period
   - Supports tag filtering (conference rooms, focus areas)

8. **`butlr_usage_trend`** 📋 PLANNED - *"Is this room used more than last week?"*
   - Period-over-period comparison
   - Significance labels (notable/slight/minimal change)

#### Tier 2: Data Tools (2 tools)

9. **`butlr_get_occupancy_data`** 📋 PLANNED - Raw timeseries for power users
   - Flexible parameters (custom intervals, time ranges, measurements)
   - Maps to v3/reporting endpoint
   - ~10% of queries requiring custom analysis

10. **`butlr_search_assets`** ✅ IMPLEMENTED - Fuzzy asset search
   - Implemented in: `src/tools/search-assets.ts`
   - Workaround for GraphQL's ID-only constraint
   - Used by both conversational and data tools

### Key Design Decisions

**Why question-driven?** Users ask "Is the café busy?" not "Query room_occupancy for room_567 from -5m to now with max function". Question-driven tools provide instant, actionable answers with natural language.

**Why two tiers?** Conversational tools (90% of queries) are optimized for natural questions with pre-computed insights. Data tools (10% of queries) provide flexibility for power users who need custom time ranges or external integrations.

**Why fuzzy search?** The GraphQL API only supports ID-based queries. To enable natural language like "show me the café", we fetch full topology and implement client-side fuzzy matching with caching. See `src/utils/fuzzy-match.ts`.

**Why server-side computation?** Pre-computing insights (labels, trends, rankings) provides better UX, consistent interpretation, and reduced token usage compared to returning raw data for agents to process.

**API Versions:** Production uses **v3/reporting** for timeseries queries and **v4/stats** for pre-computed statistics. v4/reporting exists but has dashboard-only access restrictions.

For detailed API constraints and workarounds, see `docs/API_CONSTRAINTS.md`.

## Technical Stack & Architecture

- **Language:** Node.js (>= 18). TypeScript for type safety and maintainability.
- **Transport:** MCP over stdio to maximize host compatibility. The CLI accepts flags and env variables and spawns the server in stdio mode.
- **HTTP Client:** undici for modern HTTP/2 support and connection pooling
- **Dependencies:**
  - GraphQL: `@apollo/client` for GraphQL API
  - REST: `undici` for v3/reporting and v4/stats
  - Caching: `lru-cache` for topology and occupancy
  - Validation: `zod` for JSON schema
  - CLI: `commander` for argument parsing
- **Packaging:** Publish as `@butlr/butlr-mcp-server` with CLI entry point at `bin/cli.js`. Clients run it with `npx @butlr/butlr-mcp-server`.
- **Caching:**
  - Topology cache (TTL: 600s) for slow-changing asset structure
  - Occupancy cache (TTL: 60s) for fast-changing current occupancy
  - Stats cache (future, TTL: 300s) for historical aggregates
- **Error translation:** Converts upstream HTTP/GraphQL errors to structured MCP errors (`AUTH_EXPIRED`, `RATE_LIMITED`, `VALIDATION_FAILED`) with actionable hints.

### Architecture Diagram

```
LLM Client (Claude Desktop, VS Code, etc.)
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
     ├── Butlr GraphQL API
     └── Butlr Reporting REST API
```

## Local Development & Testing (Without Publishing)

You can build and test the MCP server locally before publishing it to the npm registry. The Auth0 server provides a good reference for a TypeScript-based project: cloning the repository, installing dependencies, building, and running the server with local commands. The GitHub server provides an alternative example written in Go that can be built locally with `go build` and run with a personal access token.

The following approach adapts these patterns for a Node/TypeScript Butlr server:

### 1. Set up your repository

```bash
git clone https://yourrepo/butlr-mcp-server.git
cd butlr-mcp-server
npm install
```

### 2. Develop with hot-reload

Use a dev script similar to Auth0's `npm run dev`. Configure it with `ts-node` or `tsx` so that changes to TypeScript files automatically restart the server. Provide a `dev:debug` script that sets a debug environment variable to enable verbose logging.

```json
"scripts": {
  "dev": "tsx src/index.ts",
  "dev:debug": "DEBUG=butlr-mcp tsx src/index.ts"
}
```

### 3. Run locally via `npx .`

Add a `bin/cli.js` that imports your compiled or ts-node server and invokes it with stdio transport. With a properly configured `package.json`, you can run the local project without publishing using `npx .` (similar to Auth0's `npx . init` command). This is useful for early testing.

### 4. Link for global testing

`npm link` registers your package globally so that you can run `butlr-mcp` from any directory. This simulates the behaviour of a published package. When finished, run `npm unlink`.

### 5. Support CLI flags

Your CLI should accept flags for `--org-id`, `--token`, `--base-url`, `--cache-ttl`, `--max-ids`, etc. The flags should override environment variables.

### 6. Write unit and integration tests

Use a framework like Vitest or Jest. Mock the Butlr APIs to simulate GraphQL and REST responses. Add contract tests to ensure your tool schemas and normalization logic produce deterministic outputs.

### 7. Debugging

Provide a `DEBUG=butlr-mcp` environment variable to enable verbose logging, following the pattern in Auth0's server. When set, log request/response metadata, cache hits and rate-limit decisions. Avoid logging sensitive tokens.

## Recommended Environment Variables & Settings

Following the patterns used by the GitHub and Auth0 servers, use environment variables to avoid hard-coding secrets and to enable flexible configuration. The GitHub server recommends storing personal access tokens in environment variables or a `.env` file and referencing them in configuration. Auth0's server uses `DEBUG` to enable debug logs and `AUTH0_MCP_ANALYTICS=false` to opt out of analytics.

### Core Settings for the Butlr MCP Server

| Variable | Purpose | Notes |
|----------|---------|-------|
| `BUTLR_TOKEN` | **Required.** Long-lived API token for Butlr API. | Should be stored in your shell environment or `.env` file to avoid committing secrets. |
| `BUTLR_ORG_ID` | Organization ID used for asset queries. | If omitted, require it as a CLI flag. |
| `BUTLR_BASE_URL` | Base URL for Butlr's APIs (e.g. `https://api.butlr.io`). | Allows pointing to staging or regional deployments. |
| `BUTLR_TIMEZONE` | Default timezone used for reporting queries. | Defaults to `UTC`. |
| `MCP_CACHE_TOPO_TTL` | TTL (in seconds) for topology cache. | Short caches (e.g. 600 s) reduce API calls. |
| `MCP_MAX_IDS` | Maximum number of IDs accepted per call. | Protects API from fan-out. |
| `MCP_MAX_LOOKBACK_DAYS` | Maximum number of days allowed in a time-series query. | |
| `MCP_CONCURRENCY` | Maximum number of concurrent upstream API calls. | Controls rate-limiting. |
| `MCP_TELEMETRY` | Whether to send anonymized usage data (on/off). | Default should be off; consider an opt-in model. |
| `DEBUG` | Set to `butlr-mcp` or `*` to enable verbose debug logging. | Use for troubleshooting. |
| `BUTLR_MCP_ANALYTICS` | Set to `false` to disable any anonymized analytics collection. | Mirrors Auth0's `AUTH0_MCP_ANALYTICS=false` opt-out. |
| `BUTLR_TOOLSETS` | Comma-separated list to enable or disable groups of tools. | Mirrors GitHub's `GITHUB_TOOLSETS` variable. For example, `BUTLR_TOOLSETS="occupancy,topology,devices"`. |

### Security Best Practices

- **Store tokens in environment variables or a `.env` file** rather than embedding them in configuration. The GitHub server recommends exporting a `GITHUB_PAT` and protecting your `.env` by adding it to `.gitignore`. Apply the same practice for `BUTLR_TOKEN`.

- **Grant minimum scopes** needed for your tools. GitHub's docs encourage minimal permission scopes and separate tokens per project. For Butlr, restrict tokens to the necessary read-only scopes.

- **Rotate tokens regularly** and never commit them to version control.

- **Provide a logout or token-revocation command** to clear stored credentials, similar to Auth0's `logout` command.

## Additional Implementation Notes & Best Practices

1. **Interactive scope selection:** Consider an initialization command that lets users pick which API scopes or tool groups to enable. Auth0's server starts with no scopes selected and provides an interactive interface to add them. This protects users from inadvertently granting more access than needed.

2. **Toolset filtering:** Expose a `--toolsets` CLI flag or a `BUTLR_TOOLSETS` environment variable, similar to GitHub's `--toolsets` flag, so administrators can disable tools that are not relevant for their organization.

3. **Debugging:** Offer an MCP inspector command (like `npx @modelcontextprotocol/inspector`) with the environment set to your server module to trace incoming and outgoing messages. Auth0's docs show using the inspector with `DEBUG` environment variables for troubleshooting.

4. **Opt-out telemetry:** Make anonymized telemetry off by default or easy to disable. Auth0 allows users to opt out by setting `AUTH0_MCP_ANALYTICS=false`.

5. **Secure key storage:** If you decide to persist tokens for convenience, store them in the OS keychain rather than plain files. Auth0 persists credentials securely and removes them on logout.

6. **Match the MCP spec:** Ensure your tool schemas are valid JSON Schema; include `additionalProperties: false` to reject unknown inputs; return deterministic fields; implement pagination with `next_cursor` where necessary.

## Conclusion

A Butlr MCP server that exposes a concise set of tools, normalizes Butlr API responses and enforces strong security practices will make it much easier for customers to integrate occupancy and asset data into natural-language workflows. By following the examples from GitHub's Go-based server and Auth0's TypeScript server—especially around environment variables, interactive configuration and local development—your Butlr server can be built and tested locally without publishing to npm. Store tokens in environment variables or secure storage, provide debug and analytics controls via environment variables, and expose toolsets selectively to give customers fine-grained control over what their LLM agents can do.

## References

- [GitHub - auth0/auth0-mcp-server](https://github.com/auth0/auth0-mcp-server)
- [GitHub - github/github-mcp-server: GitHub's official MCP Server](https://github.com/github/github-mcp-server)
