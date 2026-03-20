# Butlr MCP Server

[![npm version](https://img.shields.io/npm/v/@butlr/butlr-mcp-server.svg)](https://www.npmjs.com/package/@butlr/butlr-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)

A [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that connects AI assistants to [Butlr's](https://www.butlr.com) occupancy sensing platform. Query real-time space utilization, search facility assets, and analyze occupancy patterns through natural language.

### What you can do

- **Find available spaces** — "Are there any free conference rooms right now with capacity for 8?"
- **Monitor occupancy** — "How busy is the cafe? Should I head there now?"
- **Analyze trends** — "Show me occupancy patterns for Floor 3 over the past week"
- **Search your portfolio** — "Find all rooms named 'huddle' across Building 2"
- **Check sensor health** — "Which sensors are offline or need battery replacement?"
- **Track foot traffic** — "How many people entered the main lobby today?"

## Prerequisites

- [Node.js](https://nodejs.org/) 18 or higher
- An MCP-compatible client ([Claude Desktop](https://claude.ai/download), [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [VS Code](https://code.visualstudio.com/), [Cursor](https://cursor.com/), etc.)
- Butlr API token — see [Getting API Credentials](#getting-api-credentials)

## Quick Start

<details open>
<summary><strong>Claude Desktop</strong></summary>

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "butlr": {
      "command": "npx",
      "args": ["-y", "@butlr/butlr-mcp-server@latest"],
      "env": {
        "BUTLR_CLIENT_ID": "your_client_id",
        "BUTLR_CLIENT_SECRET": "your_client_secret"
      }
    }
  }
}
```

</details>

<details>
<summary><strong>Claude Code</strong></summary>

```bash
claude mcp add butlr \
  -e BUTLR_CLIENT_ID=your_client_id \
  -e BUTLR_CLIENT_SECRET=your_client_secret \
  -- npx -y @butlr/butlr-mcp-server@latest
```

</details>

<details>
<summary><strong>VS Code (Copilot)</strong></summary>

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "butlr": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@butlr/butlr-mcp-server@latest"],
      "env": {
        "BUTLR_CLIENT_ID": "your_client_id",
        "BUTLR_CLIENT_SECRET": "your_client_secret"
      }
    }
  }
}
```

</details>

<details>
<summary><strong>Cursor</strong></summary>

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "butlr": {
      "command": "npx",
      "args": ["-y", "@butlr/butlr-mcp-server@latest"],
      "env": {
        "BUTLR_CLIENT_ID": "your_client_id",
        "BUTLR_CLIENT_SECRET": "your_client_secret"
      }
    }
  }
}
```

</details>

<details>
<summary><strong>Other MCP clients</strong></summary>

For any MCP client that supports stdio transport, use this command:

```
npx -y @butlr/butlr-mcp-server@latest
```

Pass the required environment variables (`BUTLR_CLIENT_ID`, `BUTLR_CLIENT_SECRET`) through your client's configuration.

</details>

## Available Tools

| Tool | Description | Try asking... |
|------|-------------|---------------|
| `butlr_search_assets` | Search for assets (sites, buildings, floors, rooms, sensors) by name with fuzzy matching | "Find the main lobby" |
| `butlr_get_asset_details` | Get comprehensive details for specific assets by ID with batch support | "Show me details for Conference Room 401" |
| `butlr_hardware_snapshot` | Device health check: online/offline status and battery levels across your portfolio | "Which sensors need battery replacement?" |
| `butlr_available_rooms` | Find currently unoccupied rooms, filterable by capacity and tags | "Are there any free conference rooms right now?" |
| `butlr_space_busyness` | Current occupancy with qualitative labels (quiet/moderate/busy) and trend comparison | "How busy is the cafe right now?" |
| `butlr_traffic_flow` | Entry/exit counts with hourly breakdown for traffic-mode sensors | "How many people entered the lobby today?" |
| `butlr_list_topology` | Display org hierarchy tree with flexible depth control | "Show me all floors in Building 2" |
| `butlr_fetch_entity_details` | Retrieve specific fields for entities by ID (minimal token usage) | "What's the timezone for this site?" |
| `butlr_get_occupancy_timeseries` | Historical occupancy data with configurable time ranges | "Show occupancy trends for Floor 3 this week" |
| `butlr_get_current_occupancy` | Real-time occupancy snapshot (last 5 minutes median) | "How many people are on Floor 2 right now?" |

All tools are **read-only** — the server cannot modify any data in your Butlr account.

## Configuration

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BUTLR_CLIENT_ID` | **Yes** | - | API token client ID |
| `BUTLR_CLIENT_SECRET` | **Yes** | - | API token client secret |
| `BUTLR_BASE_URL` | No | `https://api.butlr.io` | API base URL |
| `BUTLR_TIMEZONE` | No | `UTC` | Default timezone |
| `MCP_CACHE_TOPO_TTL` | No | `600` | Topology cache TTL (seconds) |
| `DEBUG` | No | - | Set to `butlr-mcp` for verbose logging |

## Getting API Credentials

1. Log in to [app.butlr.io](https://app.butlr.io)
2. Click your username in the top-right corner, then **Account Settings**
3. Go to **API Tokens** and create a new token
4. Copy the **Client ID** and **Client Secret**

You need **edit access** to Butlr Studio to create API tokens. If you don't have edit permissions, ask someone in your organization who does, or contact your Butlr sales representative or [submit a support ticket](https://www.butlr.com).

## Troubleshooting

**Authentication errors** — Verify your `BUTLR_CLIENT_ID` and `BUTLR_CLIENT_SECRET` are correct. Tokens are refreshed automatically.

**Rate limiting** — The server handles rate limits automatically with retry logic. If you see persistent rate limit errors, reduce the frequency of requests.

**No data returned** — Ensure your organization has active sensors deployed. Use `butlr_search_assets` to verify your org has discoverable assets.

**Debug logging** — Set `DEBUG=butlr-mcp` in your environment to see detailed request/response logs on stderr.

## Development

See [CONTRIBUTING.md](CONTRIBUTING.md) for full development workflow and standards.

```bash
npm install          # Install dependencies
npm run build        # Build TypeScript
npm test             # Run tests (442 tests)
npm run typecheck    # Type checking
npm run lint         # ESLint
npm run dev          # Dev with hot-reload
npm run dev:debug    # Dev with debug logging
```

## Security

- All tools enforce read-only API access
- Never commit credentials to version control
- See [SECURITY.md](SECURITY.md) for vulnerability disclosure

## License

MIT - see [LICENSE](LICENSE)
