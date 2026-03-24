# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is the **Butlr MCP Server** - a Model Context Protocol (MCP) adapter providing secure, read-only access to Butlr occupancy and asset data through natural-language interfaces. The server translates high-level queries into parameterized API calls against Butlr's GraphQL and REST endpoints, handling authentication, rate limiting, caching, and response normalization.

## Architecture

```
LLM Client (Desktop apps, VS Code, etc.)
 │
 │ MCP stdio (spawn process)
 ▼
Butlr MCP Server (Node.js)
 ├── Tool registry
 ├── Auth & token refresh
 ├── Rate limiter & caching
 ├── Response normalizer
 └── Error translator
     │
     ├── Butlr GraphQL API (asset topology, device inventory)
     └── Butlr Reporting REST API (occupancy timeseries)
```

## Key Design Principles

- **Question-driven design**: Tools answer user questions, not map to API endpoints
- **Natural language outputs**: Conversational summaries + structured data
- **Read-only access**: All tools enforce read-only scopes
- **Response normalization**: ISO-8601 timestamps, consistent field naming
- **Error translation**: Map HTTP/GraphQL to MCP errors (`AUTH_EXPIRED`, `RATE_LIMITED`, `VALIDATION_FAILED`)

## Project Structure

```
butlr-mcp/
├── src/
│   ├── index.ts           # Main entry point, stdio transport setup
│   ├── tools/             # Tool implementations
│   ├── clients/           # Butlr API clients (GraphQL, REST)
│   ├── cache/             # Caching layer with TTL
│   ├── errors/            # MCP error translation
│   └── utils/             # Shared utilities
└── dist/                  # Compiled output (bin entry: dist/index.js)
```

## Development Commands

```bash
npm run dev          # Development with hot-reload
npm run dev:debug    # With debug logging (DEBUG=butlr-mcp)
npm run build        # Build TypeScript
npm test             # Run tests
npm run typecheck    # Type checking
npm run lint         # ESLint
npm run format       # Prettier
```

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `BUTLR_CLIENT_ID` | Yes | OAuth2 client ID |
| `BUTLR_CLIENT_SECRET` | Yes | OAuth2 client secret |
| `BUTLR_ORG_ID` | No | Organization ID (optional as of v0.1.1) |
| `BUTLR_BASE_URL` | No | API base URL (default: `https://api.butlr.io`) |
| `BUTLR_TIMEZONE` | No | Default timezone (default: `UTC`) |
| `MCP_CACHE_TOPO_TTL` | No | Topology cache TTL in seconds (default: 600) |
| `DEBUG` | No | Set to `butlr-mcp` for verbose logging |

## Testing

- Vitest for test framework
- Mock Butlr GraphQL and REST APIs with sanitized fixture data
- Timezone-independent tests (verified UTC, Asia/Tokyo, Europe/London)
- Pre-commit hooks run typecheck + full test suite

## Error Handling

Convert upstream errors to actionable MCP errors:
- 401/403 → `AUTH_EXPIRED` (with token refresh hint)
- 429 → `RATE_LIMITED` (with retry-after info)
- 400 → `VALIDATION_FAILED` (with schema hints)
- Network errors → clear error messages for debugging
