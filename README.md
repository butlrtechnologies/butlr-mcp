# Butlr MCP Server

<div align="center">

[![npm version](https://img.shields.io/npm/v/@butlr/butlr-mcp-server.svg)](https://www.npmjs.com/package/@butlr/butlr-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)

[Getting Started](#-getting-started) • [Tools](#-available-tools) • [Configuration](#-configuration) • [Security](#-security) • [Troubleshooting](#-troubleshooting)

</div>

A Model Context Protocol (MCP) server that connects AI assistants directly to Butlr's occupancy sensing platform. Query real-time space utilization, search facility assets, and analyze occupancy patterns using natural language.

> **Status:** ✅ Production Ready - 10 active tools with full authentication, caching, and error handling

## 🎯 Use Cases

- **Space Operations**: "How busy is the café right now?" • "Find available conference rooms"
- **Facility Management**: "Show me all offline sensors" • "Which rooms need battery replacements?"
- **Analytics**: "What's the daily traffic through the lobby?" • "Is this room busier than usual?"
- **Asset Discovery**: "Find all sensors on Floor 2" • "Show me the building hierarchy"
- **Data Analysis**: Export occupancy timeseries for custom analysis and reporting

---

## 🚀 Getting Started

### Prerequisites

- Node.js 18 or higher
- Butlr API credentials (OAuth2 client ID and secret)
- An MCP-compatible client (Claude Desktop, VS Code with Cline, etc.)

### Installation

#### Option 1: Install from npm (Recommended)

```bash
npm install -g @butlr/butlr-mcp-server
```

#### Option 2: Build from Source

```bash
git clone https://github.com/butlrtechnologies/butlr-mcp.git
cd butlr-mcp-server
npm install
npm run build
```

### Configuration

#### For Claude Desktop

Add to your Claude Desktop config file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "butlr": {
      "command": "npx",
      "args": ["-y", "@butlr/butlr-mcp-server"],
      "env": {
        "BUTLR_CLIENT_ID": "your_client_id_here",
        "BUTLR_CLIENT_SECRET": "your_client_secret_here",
        "BUTLR_ORG_ID": "your_org_id_here"
      }
    }
  }
}
```

#### For Claude Code (Cline)

Add to `.mcp.json` in your project root:

```json
{
  "mcpServers": {
    "butlr": {
      "command": "npx",
      "args": ["-y", "@butlr/butlr-mcp-server"],
      "env": {
        "BUTLR_CLIENT_ID": "${BUTLR_CLIENT_ID}",
        "BUTLR_CLIENT_SECRET": "${BUTLR_CLIENT_SECRET}",
        "BUTLR_ORG_ID": "${BUTLR_ORG_ID}"
      }
    }
  }
}
```

Set environment variables in your shell:

```bash
export BUTLR_CLIENT_ID=your_client_id
export BUTLR_CLIENT_SECRET=your_client_secret
export BUTLR_ORG_ID=your_org_id
```

#### For Other MCP Clients

See platform-specific documentation:
- **VS Code (Cline, Continue)**: [MCP Configuration Guide](https://modelcontextprotocol.io/clients)
- **Cursor**: Add to MCP settings
- **Windsurf**: Configure in IDE settings

### Verification

After configuration, restart your MCP client and ask:

```
"Show me the Butlr tools available"
```

You should see 10 tools listed. Try a query:

```
"Search for rooms named 'conference'"
```

---

## 🛠️ Available Tools

### Conversational Tools (Answer Questions)

| Tool | Description | Example Usage |
|------|-------------|---------------|
| **butlr_hardware_snapshot** | Device health overview with online/offline status and battery alerts | "How are our sensors doing?" |
| **butlr_available_rooms** | Find unoccupied spaces right now, filtered by capacity or tags | "Are there any conference rooms free?" |
| **butlr_space_busyness** | Current occupancy with qualitative labels and trend comparison | "How busy is the lobby right now?" |
| **butlr_traffic_flow** | Entry/exit counts with hourly breakdown and trend analysis | "How many people entered the café today?" |

### Data Access Tools (Power Users)

| Tool | Description | Example Usage |
|------|-------------|---------------|
| **butlr_get_occupancy_timeseries** | Retrieve timeseries occupancy data (traffic + presence) for analysis | "Get hourly occupancy for Floor 2 this week" |
| **butlr_get_current_occupancy** | Current occupancy snapshot (last 5 minutes median) | "What's the current occupancy of room_123?" |
| **search_assets** | Fuzzy search for facilities, rooms, sensors by name | "Find all sensors with 'lobby' in the name" |
| **get_asset_details** | Detailed information for specific assets by ID | "Show full details for room_abc123" |

### Foundation Tools (Validation & Debugging)

| Tool | Description | When to Use |
|------|-------------|-------------|
| **butlr_list_topology** | Tree view of organizational hierarchy (sites → sensors) | Exploring asset structure, validation |
| **butlr_fetch_entity_details** | Selective field fetching for specific entities | Minimizing token usage, targeted queries |

---

## ⚙️ Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BUTLR_CLIENT_ID` | **Yes** | - | OAuth2 client ID for API authentication |
| `BUTLR_CLIENT_SECRET` | **Yes** | - | OAuth2 client secret |
| `BUTLR_ORG_ID` | **Yes** | - | Organization ID for scoping queries |
| `BUTLR_BASE_URL` | No | `https://api.butlr.io` | API base URL (for testing/staging) |
| `BUTLR_TIMEZONE` | No | `UTC` | Default timezone for reports |
| `MCP_CACHE_TOPO_TTL` | No | `600` | Topology cache TTL in seconds |
| `DEBUG` | No | - | Set to `butlr-mcp` for verbose logging |

### CLI Flags

When running as a standalone command:

```bash
butlr-mcp --org-id=<id> --token=<token>
```

| Flag | Environment Variable | Description |
|------|---------------------|-------------|
| `--org-id` | `BUTLR_ORG_ID` | Organization ID |
| `--client-id` | `BUTLR_CLIENT_ID` | OAuth2 client ID |
| `--client-secret` | `BUTLR_CLIENT_SECRET` | OAuth2 client secret |
| `--base-url` | `BUTLR_BASE_URL` | API base URL |
| `--cache-ttl` | `MCP_CACHE_TOPO_TTL` | Cache TTL in seconds |

---

## 🔒 Security

### Best Practices

1. **Never commit credentials** - Use environment variables or secure vaults
2. **Use read-only scopes** - The MCP server only requests read-only API access
3. **Rotate credentials regularly** - Update OAuth2 secrets periodically
4. **Monitor usage** - Enable debug logging to audit API calls

### Credential Management

**Option 1: Environment Variables (Recommended)**
```bash
# Add to ~/.zshrc or ~/.bashrc
export BUTLR_CLIENT_ID=your_client_id
export BUTLR_CLIENT_SECRET=your_client_secret
export BUTLR_ORG_ID=your_org_id
```

**Option 2: .env File (Development)**
```bash
# Create .env in project root (never commit!)
BUTLR_CLIENT_ID=your_client_id
BUTLR_CLIENT_SECRET=your_client_secret
BUTLR_ORG_ID=your_org_id
```

Add to `.gitignore`:
```
.env
.env.local
```

### Authentication Flow

The server uses OAuth2 client credentials flow:

1. Client requests token from `https://api.butlr.io/api/v2/clients/login`
2. Server caches token until expiry
3. Automatic refresh on 401 responses
4. All API calls use `Authorization: Bearer <token>` header

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     MCP Client                               │
│            (Claude Desktop, VS Code, etc.)                   │
└──────────────────────────┬──────────────────────────────────┘
                           │ stdio (JSON-RPC)
┌──────────────────────────▼──────────────────────────────────┐
│                 Butlr MCP Server (Node.js)                   │
├──────────────────────────────────────────────────────────────┤
│  • Tool Registry (10 tools)                                   │
│  • OAuth2 Client (automatic token refresh)                   │
│  • LRU Cache (10-minute TTL for topology)                    │
│  • Response Normalizer (ISO-8601 timestamps)                 │
│  • Error Translator (HTTP → MCP error codes)                 │
└──────────────────────────┬──────────────────────────────────┘
                           │
           ┌───────────────┴───────────────┐
           │                               │
┌──────────▼─────────────┐   ┌────────────▼───────────┐
│  Butlr GraphQL API     │   │ Butlr Reporting API    │
│  (v3/graphql)          │   │ (v3/reporting)         │
│  • Assets & Topology   │   │ • Timeseries Data      │
│  • Device Inventory    │   │ • Real-time Occupancy  │
└────────────────────────┘   └────────────────────────┘
```

**How it works:**

1. MCP client spawns server as child process via stdio
2. Server authenticates with OAuth2, caches token
3. Client sends tool requests as JSON-RPC over stdio
4. Server translates requests → Butlr API calls
5. Responses normalized and returned to client
6. Automatic error handling and retry logic

---

## 🩺 Troubleshooting

### Debug Mode

Enable verbose logging to diagnose issues:

```bash
# In your MCP client config
{
  "env": {
    "DEBUG": "butlr-mcp"
  }
}
```

Or when running directly:
```bash
DEBUG=butlr-mcp npx @butlr/butlr-mcp-server
```

### Common Issues

#### "Authentication failed" or 401 errors

**Cause**: Invalid or expired credentials

**Solution**:
1. Verify `BUTLR_CLIENT_ID` and `BUTLR_CLIENT_SECRET` are correct
2. Check credentials have not been revoked
3. Ensure organization ID (`BUTLR_ORG_ID`) matches your credentials

#### "No tools available"

**Cause**: Server failed to start or configuration error

**Solution**:
1. Check MCP client logs for startup errors
2. Verify Node.js version >= 18
3. Try running server directly: `npx @butlr/butlr-mcp-server --version`

#### "Asset not found" errors

**Cause**: Using incorrect asset ID or searching wrong scope

**Solution**:
1. Use `search_assets` to find correct IDs
2. Use `butlr_list_topology` to explore hierarchy
3. Check asset IDs start with correct prefix (room_, floor_, etc.)

#### Rate limiting (429 errors)

**Cause**: Excessive API calls

**Solution**:
1. Increase `MCP_CACHE_TOPO_TTL` to cache assets longer
2. Reduce frequency of queries
3. Contact Butlr support for rate limit increase

### Testing Your Setup

```bash
# Clone repository
git clone https://github.com/butlrtechnologies/butlr-mcp.git
cd butlr-mcp

# Install dependencies
npm install

# Create .env file with credentials
cat > .env << EOF
BUTLR_CLIENT_ID=your_client_id
BUTLR_CLIENT_SECRET=your_client_secret
BUTLR_ORG_ID=your_org_id
EOF

# Build and run tests
npm run build
npm test
```

### Getting Help

- **Issues**: [GitHub Issues](https://github.com/butlrtechnologies/butlr-mcp/issues)
- **Documentation**: [docs.butlr.io](https://docs.butlr.io)
- **Support**: support@butlr.io

---

## 🔌 Integrations

> **Note**: Integration guides below describe planned features and architectural patterns. The Butlr MCP Server (10 tools with natural language responses) is production-ready today. Integration implementations are planned for future releases.

### Slack & Teams Bots (Planned 🚧)
Deploy conversational AI assistants that let teams query occupancy data using natural language. Will support:
- **Bring-your-own-LLM** (Anthropic Claude, OpenAI, Grok, or local models)
- **Command-based mode** (slash commands without LLM)
- **Multi-turn conversations** with context memory across threads
- **File generation** (charts, CSVs, PDFs) delivered directly in Slack

**See**: [Slackbot Integration Guide](docs/integrations/slackbot.md)

### Data Visualization & Exports (Planned 🚧)
Generate visualizations and reports on demand through conversational queries:
- **Interactive charts** (line, bar, area, heatmap)
- **CSV exports** for analysis in Excel/Tableau
- **PDF reports** with embedded charts and analytics
- **Automatic file delivery** to Slack channels and threads

**See**: [Chart Generation Guide](docs/features/chart-generation.md) • [Conversation Memory Guide](docs/features/conversation-memory.md)

### Architecture & Design
Learn about MCP patterns, design decisions, and implementation trade-offs:
- **MCP protocol patterns** (webhooks, notifications, real-time updates)
- **Multi-LLM architecture** (provider-agnostic design)
- **Design decisions** with rationale and alternatives considered

**See**: [MCP Patterns](docs/architecture/mcp-patterns.md) • [Architecture Documentation](docs/architecture/)

---

## 📚 Additional Resources

- [Model Context Protocol Documentation](https://modelcontextprotocol.io)
- [Butlr API Documentation](https://docs.butlr.io)
- [Claude Desktop MCP Guide](https://support.anthropic.com/en/articles/9832322-model-context-protocol-mcp)

---

## 🤝 Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## 📄 License

MIT - see [LICENSE](LICENSE) file for details

---

## 🗺️ Roadmap

### Completed ✅
- OAuth2 authentication with token caching
- 10 active tools across conversational, data, and foundation tiers
- Smart caching (topology: 10-minute TTL, occupancy: 60-second TTL)
- Fuzzy asset search
- Real-time occupancy queries
- Timeseries data export

### In Progress 🚧
- Additional conversational tools (now_summary, space_insights)
- Usage trend analysis
- Space utilization rankings

### Planned 📋
- **Slackbot integration** - Deploy conversational AI assistant in Slack with BYOLLM support
- **Data visualization** - Generate charts, export CSVs, and create PDF reports from conversations
- **Notification tools** - Send alerts to Slack, email, or SMS when conditions are met
- **Advanced analytics** - Generate heatmaps, peak hour analysis, and utilization reports
- **Calendar integration** - Check room availability and create bookings via Google Calendar/Outlook
- **Alert automation** - Configure rules to automatically notify when occupancy thresholds are exceeded

---

<div align="center">

**Built with ❤️ by [Butlr](https://butlr.com)**

</div>
