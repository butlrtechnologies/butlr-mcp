# Butlr MCP Server

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)](https://nodejs.org/)

A Model Context Protocol (MCP) server that connects AI assistants to Butlr's occupancy sensing platform. Query real-time space utilization, search facility assets, and analyze occupancy patterns using natural language.

> **Status:** In development (v0.1.0)

## Prerequisites

- Node.js 18 or higher
- Butlr API credentials (OAuth2 client ID and secret)
- An MCP-compatible client (Claude Desktop, VS Code, etc.)

## Development

```bash
# Install dependencies
npm install

# Build TypeScript
npm run build

# Run tests
npm test

# Type checking
npm run typecheck

# Lint
npm run lint

# Development with hot-reload
npm run dev

# Development with debug logging
npm run dev:debug
```

## Configuration

Create a `.env` file in the project root:

```bash
BUTLR_CLIENT_ID=your_client_id
BUTLR_CLIENT_SECRET=your_client_secret
BUTLR_ORG_ID=your_org_id
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BUTLR_CLIENT_ID` | **Yes** | - | OAuth2 client ID |
| `BUTLR_CLIENT_SECRET` | **Yes** | - | OAuth2 client secret |
| `BUTLR_ORG_ID` | **Yes** | - | Organization ID |
| `BUTLR_BASE_URL` | No | `https://api.butlr.io` | API base URL |
| `BUTLR_TIMEZONE` | No | `UTC` | Default timezone |
| `MCP_CACHE_TOPO_TTL` | No | `600` | Topology cache TTL (seconds) |
| `DEBUG` | No | - | Set to `butlr-mcp` for verbose logging |

## Security

- Never commit credentials to version control
- All tools enforce read-only API access
- See [SECURITY.md](SECURITY.md) for vulnerability disclosure

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development workflow and standards.

## License

MIT - see [LICENSE](LICENSE)
