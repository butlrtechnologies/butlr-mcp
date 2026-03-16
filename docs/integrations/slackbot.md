# Slackbot Integration Guide

> **Status**: 🚧 **Planned** - This integration is not yet implemented. This document captures research and architectural decisions to guide future development.

This guide explains how to build a Slack bot powered by the Butlr MCP Server, enabling teams to query occupancy data, generate reports, and receive insights through natural language conversations.

## Table of Contents

- [Overview](#overview)
- [Architecture Patterns](#architecture-patterns)
- [Conversational Mode (BYOLLM)](#conversational-mode-byollm)
- [Command-Based Mode](#command-based-mode)
- [Hybrid Mode](#hybrid-mode)
- [Implementation Comparison](#implementation-comparison)
- [Conversation Memory](#conversation-memory)
- [Configuration](#configuration)
- [Deployment](#deployment)

---

## Overview

The Butlr Slackbot acts as a bridge between Slack users and the Butlr MCP Server, translating natural language queries into MCP tool calls and delivering results back to Slack channels.

### Key Features (Planned)

- **Conversational AI** - Multi-turn dialogues with context awareness
- **Bring-Your-Own-LLM** - Support for Anthropic Claude, OpenAI, Grok, and local models
- **Command mode** - Slash commands for deterministic, LLM-free operation
- **File generation** - Charts, CSVs, and PDF reports delivered directly to threads (see [Chart Generation](../features/chart-generation.md))
- **Thread isolation** - Separate conversation contexts per Slack thread
- **Multi-workspace** - Single deployment serves multiple Slack workspaces

### What Exists Today

✅ **Butlr MCP Server** with 14 tools that return natural language summaries
✅ **OAuth2 authentication** with automatic token refresh
✅ **Smart caching** to minimize API calls
✅ **Natural language responses** built into MCP tools (no LLM required for basic queries)

---

## Architecture Patterns

### High-Level Architecture

```
Slack User
    │
    │ Natural language query or slash command
    ▼
┌─────────────────────────────────────────────┐
│         Butlr Slackbot (Node.js)            │
├─────────────────────────────────────────────┤
│  • Slack SDK (Socket Mode or Events API)   │
│  • Conversation Memory (PostgreSQL/Redis)   │
│  • LLM Orchestration (optional)             │
│  • MCP Client (spawns Butlr MCP Server)    │
└─────────────────────────────────────────────┘
    │                           │
    │ LLM API calls             │ MCP stdio
    ▼                           ▼
┌──────────────┐        ┌──────────────────┐
│ User's LLM   │        │ Butlr MCP Server │
│ (optional)   │        │ (embedded)       │
├──────────────┤        ├──────────────────┤
│ • Anthropic  │        │ 14+ MCP tools    │
│ • OpenAI     │        │ OAuth2 client    │
│ • Grok       │        │ Caching layer    │
│ • Ollama     │        │ File generation  │
└──────────────┘        └──────────────────┘
                             │
                             │ Butlr API
                             ▼
                     ┌───────────────┐
                     │  Butlr APIs   │
                     │ (GraphQL/REST)│
                     └───────────────┘
```

---

## Conversational Mode (BYOLLM)

### How It Works

In conversational mode, the Slackbot uses an LLM to interpret user intent and orchestrate MCP tool calls.

**Flow:**

1. User sends natural language message in Slack
2. Slackbot retrieves conversation history (if any)
3. Slackbot calls LLM with:
   - System prompt (context about Butlr)
   - Conversation history
   - Available MCP tools
   - User's new message
4. LLM decides which tools to call (if any)
5. Slackbot executes tools via MCP protocol
6. LLM receives tool results and generates response
7. Slackbot posts response to Slack thread

### Multi-Provider Support

The bot can be configured to use any LLM provider through a unified interface (typically LangChain):

```typescript
// Pseudocode: Provider selection
const llm = config.llm.provider === "anthropic"
  ? new ChatAnthropic({
      model: "claude-3-5-sonnet",
      apiKey: config.llm.api_key
    })
  : config.llm.provider === "openai"
  ? new ChatOpenAI({
      model: "gpt-4o",
      apiKey: config.llm.api_key
    })
  : config.llm.provider === "grok"
  ? new ChatOpenAI({  // Grok uses OpenAI-compatible API
      model: "grok-beta",
      apiKey: config.llm.api_key,
      baseURL: "https://api.x.ai/v1"
    })
  : new ChatOllama({  // Local models
      model: config.llm.model,
      baseUrl: "http://localhost:11434"
    });
```

**Supported Providers:**

| Provider | Models | Cost | Latency |
|----------|--------|------|---------|
| **Anthropic Claude** | claude-3-5-sonnet, claude-3-opus | $$$ | ~2-3s |
| **OpenAI** | gpt-4o, gpt-4-turbo, gpt-3.5-turbo | $$ | ~2-4s |
| **xAI Grok** | grok-beta | $$ | ~3-5s |
| **Ollama (Local)** | llama3, mistral, custom | Free | ~1-10s |

### Configuration Example

```json
{
  "slackbot": {
    "mode": "conversational",
    "slack": {
      "bot_token": "xoxb-your-bot-token",
      "app_token": "xapp-your-app-token"
    },
    "llm": {
      "provider": "anthropic",
      "api_key": "sk-ant-...",
      "model": "claude-3-5-sonnet-20241022",
      "temperature": 0.7
    },
    "butlr": {
      "client_id": "your_client_id",
      "client_secret": "your_client_secret",
      "org_id": "org_123"
    }
  }
}
```

### Advantages

✅ **Natural UX** - Users ask questions conversationally
✅ **Context awareness** - LLM maintains conversation flow
✅ **Multi-tool orchestration** - LLM chains multiple tool calls
✅ **Intelligent responses** - LLM formats data into readable summaries
✅ **Flexibility** - Handles ambiguous or complex queries

### Disadvantages

❌ **Cost** - LLM API fees per interaction
❌ **Latency** - 2-5 second response time
❌ **Non-deterministic** - Responses may vary
❌ **Token limits** - Long conversations may hit context limits

---

## Command-Based Mode

### How It Works

In command-based mode, Slack slash commands map directly to MCP tools without LLM interpretation.

**Flow:**

1. User types slash command: `/butlr-busy cafe`
2. Slack sends webhook to bot with command payload
3. Bot parses command (simple string matching)
4. Bot maps command to MCP tool and parameters
5. Bot calls MCP tool directly
6. Bot posts result to Slack (using pre-formatted response from MCP)

### Command Mapping

```typescript
// Pseudocode: Direct command-to-tool mapping
const COMMAND_MAP = {
  "/butlr-busy": {
    tool: "butlr_space_busyness",
    params: (text) => ({ space_id_or_name: text })
  },
  "/butlr-rooms": {
    tool: "butlr_available_rooms",
    params: (text) => parseRoomFilters(text) // e.g., "capacity:4"
  },
  "/butlr-traffic": {
    tool: "butlr_traffic_flow",
    params: (text) => ({ space_id_or_name: text.split(" ")[0], time_window: "today" })
  },
  "/butlr-sensors": {
    tool: "butlr_hardware_snapshot",
    params: (text) => ({ scope_type: "org" })
  }
};

// Handle slash command
async function handleSlashCommand(command, text, channel, user) {
  const mapping = COMMAND_MAP[command];
  const params = mapping.params(text);

  // Call MCP tool directly
  const result = await mcpClient.callTool(mapping.tool, params);

  // MCP tools already return natural language summaries!
  await slack.postMessage({
    channel: channel,
    text: result.summary  // Pre-formatted by MCP tool
  });
}
```

### Slash Command Examples

```bash
# Check space busyness
/butlr-busy cafe

# Find available rooms with capacity filter
/butlr-rooms capacity:4

# Get traffic flow for today
/butlr-traffic lobby today

# Check sensor health for specific building
/butlr-sensors building:HQ

# Search for assets
/butlr-search sensor mac:abc123

# Get current occupancy
/butlr-occupancy room_123
```

### Advantages

✅ **Zero LLM cost** - No AI API fees
✅ **Fast** - ~500ms response time
✅ **Deterministic** - Predictable behavior
✅ **Simple setup** - Just Slack + Butlr credentials
✅ **Still natural language** - MCP tools return conversational summaries

### Disadvantages

❌ **Rigid syntax** - Users must learn command structure
❌ **No context** - Each command is independent
❌ **Limited composition** - Can't chain multiple tools
❌ **Command proliferation** - Need many commands for coverage

---

## Hybrid Mode

### Best of Both Worlds

Offer both conversational and command-based modes with a configuration flag:

```json
{
  "slackbot": {
    "mode": "hybrid",  // Enable both modes
    "conversational_trigger": "@butlr",  // Only use LLM when mentioned
    "commands_enabled": true
  }
}
```

### Interaction Patterns

**Scenario 1: Quick lookup (command mode)**
```
User: /butlr-busy cafe
Butlr: ⚡ The café is moderately busy with 12 people.
```

**Scenario 2: Complex query (conversational mode)**
```
User: @butlr compare café traffic to lobby for the last week
Butlr: 📊 [Generates chart showing comparison]
      The café averaged 68 people/day vs lobby's 45 people/day.
      Café was 51% busier. Peak days: Tue (café), Wed (lobby).
```

**Scenario 3: Follow-up (conversational mode)**
```
User: @butlr how busy is HQ?
Butlr: HQ has 45 people right now, moderate for 2pm.

User: what about Floor 2?  [LLM remembers "HQ" context]
Butlr: Floor 2 in HQ has 12 people.
```

---

## Implementation Comparison

| Aspect | Conversational Mode | Command-Based Mode | Hybrid Mode |
|--------|-------------------|-------------------|-------------|
| **UX** | Natural chat | Slash commands | Both |
| **Cost** | LLM API fees | Zero | API fees when using LLM |
| **Latency** | 2-5 seconds | ~500ms | Depends on mode |
| **Context** | Multi-turn aware | Stateless | Multi-turn when using LLM |
| **Setup complexity** | Medium | Low | Medium |
| **Learning curve** | None (natural language) | Must learn commands | Users choose |
| **Flexibility** | High | Low | High |
| **Determinism** | Low | High | User chooses |

### Use Case Recommendations

**Choose Conversational Mode when:**
- Users need exploratory, complex queries
- Budget allows for LLM API costs
- UX is top priority
- Users are non-technical

**Choose Command-Based Mode when:**
- Cost must be minimized
- Speed is critical
- Queries are repetitive and well-defined
- Users prefer keyboard shortcuts

**Choose Hybrid Mode when:**
- Serving diverse user base
- Want flexibility without forcing choice
- Have both power users and casual users
- Budget allows for some LLM usage

---

## Conversation Memory

Conversational mode requires tracking context across messages. See [Conversation Memory Guide](../features/conversation-memory.md) for detailed implementation.

### Session Identification

Slack provides natural conversation boundaries:

```typescript
// Pseudocode: Session ID generation
function getSessionId(event) {
  // Threaded conversations
  if (event.thread_ts) {
    return `${event.channel}_${event.thread_ts}`;
  }

  // Direct messages (per-user)
  if (event.channel.startsWith('D')) {
    return `${event.channel}_${event.user}`;
  }

  // Channel messages (per-user to avoid cross-talk)
  return `${event.channel}_${event.user}`;
}
```

### Storage Options

| Storage | Best For | Persistence | Cost |
|---------|----------|-------------|------|
| **In-Memory** | Dev/testing | Lost on restart | Free |
| **PostgreSQL** | Production | Permanent | $ |
| **Redis** | High-traffic | TTL-based | $$ |

---

## Configuration

### Minimal Configuration (Command Mode)

```json
{
  "mode": "command",
  "slack": {
    "bot_token": "xoxb-...",
    "signing_secret": "..."
  },
  "butlr": {
    "client_id": "...",
    "client_secret": "...",
    "org_id": "..."
  }
}
```

### Full Configuration (Conversational Mode)

```json
{
  "mode": "conversational",
  "slack": {
    "bot_token": "xoxb-...",
    "app_token": "xapp-...",
    "signing_secret": "..."
  },
  "llm": {
    "provider": "anthropic",
    "api_key": "sk-ant-...",
    "model": "claude-3-5-sonnet-20241022",
    "temperature": 0.7,
    "max_tokens": 4096
  },
  "memory": {
    "type": "postgresql",
    "connection_string": "postgresql://...",
    "ttl_days": 7
  },
  "butlr": {
    "client_id": "...",
    "client_secret": "...",
    "org_id": "...",
    "base_url": "https://api.butlr.io",
    "cache_ttl": 600
  }
}
```

---

## Deployment

### Infrastructure Requirements

**Minimum (Command Mode):**
- Node.js 18+ runtime
- 512MB RAM
- Slack bot token
- Butlr API credentials

**Production (Conversational Mode):**
- Node.js 18+ runtime
- 2GB+ RAM (for MCP server + bot)
- PostgreSQL or Redis for memory
- LLM API key
- Butlr API credentials

### Slack App Setup

1. **Create Slack App** at https://api.slack.com/apps
2. **Enable Socket Mode** (for conversational) or **Request URL** (for commands)
3. **Add Bot Token Scopes**:
   - `app_mentions:read` (for @mentions)
   - `chat:write` (to post messages)
   - `files:write` (to upload charts/PDFs)
   - `commands` (for slash commands)
4. **Install to Workspace**

### Environment Variables

```bash
# Slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...  # Only for Socket Mode
SLACK_SIGNING_SECRET=...

# LLM (conversational mode only)
LLM_PROVIDER=anthropic  # anthropic | openai | grok | ollama
ANTHROPIC_API_KEY=sk-ant-...
# or
OPENAI_API_KEY=sk-...

# Butlr
BUTLR_CLIENT_ID=...
BUTLR_CLIENT_SECRET=...
BUTLR_ORG_ID=...

# Memory (conversational mode only)
DATABASE_URL=postgresql://...
# or
REDIS_URL=redis://...
```

### Running the Bot

```bash
# Development
npm run dev

# Production
npm run build
npm start

# Docker
docker build -t butlr-slackbot .
docker run -e SLACK_BOT_TOKEN=... -e BUTLR_CLIENT_ID=... butlr-slackbot
```

---

## Real-World Example

### Conversational Flow

```
┌─────────────────────────────────────────────────────┐
│ Slack Thread: #operations                           │
├─────────────────────────────────────────────────────┤
│ Sarah: @butlr how busy is the café?                 │
│                                                     │
│ Butlr: The café is moderately busy with 18 people, │
│        typical for 2pm on Thursday.                 │
│                                                     │
│ Sarah: plot the last 12 hours                       │
│                                                     │
│ Butlr: [Generating chart...]                        │
│        📊 [cafe_traffic_12h.png]                    │
│        Peak: 45 people at 12:30pm                   │
│        Average: 28 people/hour                      │
│                                                     │
│ Sarah: export as CSV                                │
│                                                     │
│ Butlr: 📄 [cafe_traffic_2025-01-15.csv]            │
│        Done! Hourly data with timestamps.           │
└─────────────────────────────────────────────────────┘
```

---

## Next Steps

- **[Chart Generation](../features/chart-generation.md)** - Learn how to generate and deliver visualizations
- **[Conversation Memory](../features/conversation-memory.md)** - Deep dive into session management
- **[MCP Patterns](../architecture/mcp-patterns.md)** - Understand MCP protocol patterns

---

## Related Documentation

- [Chart Generation](../features/chart-generation.md)
- [Conversation Memory](../features/conversation-memory.md)
- [MCP Patterns](../architecture/mcp-patterns.md)
