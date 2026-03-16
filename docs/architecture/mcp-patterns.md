# MCP Protocol Patterns & Integration Architecture

> **Status**: 📚 **Reference** - This document explains how the Model Context Protocol works and clarifies common misconceptions about MCP capabilities.

This guide explains the Model Context Protocol's actual capabilities, limitations, and integration patterns based on research and real-world implementations.

## Table of Contents

- [Overview](#overview)
- [Three MCP Patterns](#three-mcp-patterns)
- [Common Misconceptions](#common-misconceptions)
- [Why Our Roadmap Language Changed](#why-our-roadmap-language-changed)
- [Real-World Integration Examples](#real-world-integration-examples)
- [Best Practices](#best-practices)

---

## Overview

The Model Context Protocol (MCP) is an **open standard for connecting AI assistants to data sources and tools**. However, MCP has specific architectural patterns that determine what is and isn't possible.

### What MCP Actually Does

✅ **Enables**: AI assistants (clients) to call tools and access resources from servers
✅ **Transport**: Typically stdio (spawn process) or Server-Sent Events (SSE)
✅ **Protocol**: JSON-RPC 2.0 for tool calls and responses
✅ **Stateless**: Each tool call is independent

### What MCP Does NOT Do

❌ **Does not**: Expose HTTP endpoints (no inbound webhooks)
❌ **Does not**: Push notifications to arbitrary systems
❌ **Does not**: Act as a webhook receiver
❌ **Does not**: Support true bidirectional push from server to client (limited support via resources)

---

## Three MCP Patterns

Based on extensive research, there are **three distinct architectural patterns** for different integration types:

### Pattern 1: Resource Subscriptions (MCP-Native)

**Purpose**: Real-time monitoring within the MCP protocol
**Direction**: Server → Client (limited support)

```
Client                         Server
   │                              │
   ├──subscribe to resource───────>│
   │                              │
   │                    [resource changes]
   │                              │
   │<──notification/resources/────┤
   │    updated                   │
   │                              │
   ├──read_resource (get data)───>│
   │                              │
```

**How it works:**
1. Client subscribes to a resource (e.g., `file:///project/log.txt`)
2. Server watches resource for changes
3. When resource changes, server sends `notifications/resources/updated`
4. Client must call `read_resource` to get actual updated data

**MCP Notifications:**
- `notifications/resources/list_changed` - Available resources changed
- `notifications/resources/updated` - Specific resource changed (client must re-read)

**Limitations:**
- ⚠️ **Most clients don't support this yet** (Claude Desktop doesn't, MCP Inspector does)
- ⚠️ **Requires persistent connection** (stdio or SSE, not stateless HTTP)
- ⚠️ **Pull model** - Notification says "something changed" but client must fetch data
- ⚠️ **Not suitable for external system notifications**

**Example Use Case**: File monitoring (notify when code file changes)

**Butlr Status**: ❌ Not applicable - Our data changes too frequently and clients don't support subscriptions yet

---

### Pattern 2: Outbound API Calls (Most Common)

**Purpose**: Send data TO external systems (Slack, email, etc.)
**Direction**: MCP Server → External API

```
LLM/Client          MCP Server          External API
     │                     │                    │
     ├──call tool─────────>│                    │
     │                     │                    │
     │                     ├──POST webhook──────>│
     │                     │   (Slack/Email)    │
     │                     │                    │
     │                     │<──200 OK───────────┤
     │                     │                    │
     │<──tool result───────┤                    │
     │  (success)          │                    │
```

**How it works:**
1. Client calls MCP tool (e.g., `send_slack_alert`)
2. MCP server makes HTTP POST to external API (Slack, SendGrid, etc.)
3. External API responds with success/failure
4. MCP server returns result to client

**This is NOT webhooks** - It's the MCP server making outbound calls, not receiving them.

**Example MCP Tools:**
```typescript
// Pseudocode: Outbound notification tools
{
  name: "send_slack_alert",
  description: "Send alert to Slack channel",
  inputSchema: {
    channel: "string",
    message: "string",
    priority: "enum[info, warning, danger]"
  }
}

// Implementation makes HTTP call
async function send_slack_alert(params) {
  await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    body: JSON.stringify({
      channel: params.channel,
      text: params.message,
      color: priorityToColor(params.priority)
    })
  });
}
```

**Examples:**
- **Slack notifications** - MCP tool posts to Slack webhook
- **Email alerts** - MCP tool calls SendGrid/SMTP
- **Calendar events** - MCP tool calls Google Calendar API (OAuth2)
- **File uploads** - MCP tool uploads to Slack/S3/Drive

**Butlr Status**: 🚧 Planned for future releases (Slack alerts, chart uploads)

---

### Pattern 3: Async Operations (Proposed, Not Standard)

**Purpose**: Long-running operations (minutes/hours)
**Direction**: Client polls server for status

```
Client                    Server
   │                         │
   ├──call tool (async)─────>│
   │  {token: "op_123"}      │
   │                         │
   │<──202 Accepted──────────┤
   │  {status: "submitted"}  │
   │                         │
   │                     [processing...]
   │                         │
   ├──poll status───────────>│
   │  {token: "op_123"}      │
   │                         │
   │<──status: "working"─────┤
   │                         │
   │                     [more processing...]
   │                         │
   ├──get result────────────>│
   │  {token: "op_123"}      │
   │                         │
   │<──final result──────────┤
```

**How it works:**
1. Client calls tool, gets operation token
2. Server processes in background
3. Client polls for status (submitted → working → completed)
4. Client fetches final result when complete

**Why not webhooks?**
> "Desktop applications requiring public endpoints pose security concerns" - SEP-1391

**Status**: Proposal (SEP-1391), not yet part of MCP spec

**Butlr Status**: ❌ Not needed - Our queries complete in <2 seconds

---

## Common Misconceptions

### Misconception 1: "MCP supports webhooks"

❌ **Wrong**: MCP servers cannot **receive** webhooks (no HTTP endpoint)
✅ **Right**: MCP servers can **send** data to external webhooks (outbound POST)

**Clarification**: When people say "webhook support," they usually mean one of:
1. **Outbound webhooks** - MCP tool posts to Slack/etc. (Pattern 2) ✅
2. **Inbound webhooks** - External system posts to MCP server (❌ not possible)

---

### Misconception 2: "MCP enables real-time notifications"

❌ **Wrong**: MCP can push notifications to any system
✅ **Right**: MCP has limited server-to-client notifications via resource subscriptions

**Clarification**:
- ✅ Server can notify client about resource changes (Pattern 1)
- ❌ Server cannot notify external systems (use Pattern 2 instead)
- ❌ Most clients don't even support resource subscriptions yet

---

### Misconception 3: "MCP servers can receive data from external systems"

❌ **Wrong**: MCP servers expose HTTP endpoints for incoming data
✅ **Right**: MCP servers are spawned as child processes, communicate via stdio

**Clarification**: If you need to receive data from external systems:
- Build a separate webhook receiver
- Store data in database
- MCP tools query that database

---

## Why Our Roadmap Language Changed

### Original (Confusing)

```markdown
### Planned
- Webhook support for real-time alerts
- Integration with calendar systems
- Custom alerting rules
```

**Problems:**
- "Webhook support" implies receiving webhooks (impossible)
- "Integration" is vague - doesn't explain what users can do
- Technical jargon instead of user-facing benefits

### Updated (Clear)

```markdown
### Planned
- **Notification tools** - Send alerts to Slack, email, or SMS when conditions are met
- **Calendar integration** - Check room availability and create bookings via Google Calendar/Outlook
- **Alert automation** - Configure rules to automatically notify when occupancy thresholds are exceeded
```

**Improvements:**
✅ User-facing language (what you can DO)
✅ No technical jargon
✅ Clear about outbound actions (send, check, notify)
✅ No misleading implications about inbound capabilities

---

## Real-World Integration Examples

### Example 1: Slack Notifications (Pattern 2)

```typescript
// MCP Tool: Send alert to Slack
{
  name: "send_occupancy_alert",
  description: "Send occupancy alert to Slack channel",
  inputSchema: {
    space_name: "string",
    current_occupancy: "number",
    threshold: "number",
    channel: "string"
  }
}

// Implementation (outbound POST)
async function send_occupancy_alert(params) {
  const message = `⚠️ ${params.space_name} is at ${params.current_occupancy} people (threshold: ${params.threshold})`;

  await fetch(process.env.SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      channel: params.channel,
      text: message,
      color: 'warning'
    })
  });

  return { success: true, message: "Alert sent to Slack" };
}
```

**This is Pattern 2 (outbound)**, not webhooks!

---

### Example 2: Google Calendar Integration (Pattern 2)

```typescript
// MCP Tool: Check calendar availability
{
  name: "check_room_calendar",
  description: "Check if meeting room is available in calendar",
  inputSchema: {
    room_id: "string",
    start_time: "string",
    end_time: "string"
  }
}

// Implementation (outbound OAuth2 API call)
async function check_room_calendar(params) {
  const calendar = await google.calendar({
    version: 'v3',
    auth: oauth2Client
  });

  const response = await calendar.events.list({
    calendarId: getRoomCalendarId(params.room_id),
    timeMin: params.start_time,
    timeMax: params.end_time,
    singleEvents: true
  });

  const isAvailable = response.data.items.length === 0;

  return {
    available: isAvailable,
    conflicting_events: response.data.items.length
  };
}
```

**This is Pattern 2 (outbound API call)**, not real-time sync!

---

### Example 3: File Upload to Slack (Pattern 2)

```typescript
// MCP Tool: Upload chart to Slack
{
  name: "upload_chart_to_slack",
  description: "Generate chart and upload to Slack thread",
  inputSchema: {
    data: "array",
    channel_id: "string",
    thread_ts: "string"
  }
}

// Implementation (generate + upload)
async function upload_chart_to_slack(params) {
  // Step 1: Generate chart (local)
  const chart = await generateChart(params.data);

  // Step 2: Upload to Slack (outbound)
  const { upload_url, file_id } = await slack.files.getUploadURLExternal({
    filename: 'chart.png',
    length: chart.buffer.length
  });

  await fetch(upload_url, {
    method: 'POST',
    body: chart.buffer
  });

  await slack.files.completeUploadExternal({
    files: [{ id: file_id }],
    channel_id: params.channel_id,
    thread_ts: params.thread_ts
  });

  return { success: true, file_url: result.file.permalink };
}
```

**This is Pattern 2 (outbound file upload)**, not bidirectional file sync!

---

## Best Practices

### 1. Use Clear, User-Facing Language

❌ "Webhook support"
✅ "Send alerts to Slack when occupancy exceeds threshold"

❌ "Real-time integration"
✅ "Check calendar availability and create bookings"

❌ "Bidirectional sync"
✅ "Export data to CSV and upload to Slack"

---

### 2. Understand MCP's Role

**MCP is a tool-calling protocol**, not:
- ❌ A web server
- ❌ A webhook receiver
- ❌ A message queue
- ❌ A pub/sub system

**MCP enables**:
- ✅ AI assistants to call functions
- ✅ Servers to provide tools and resources
- ✅ Standardized communication protocol

---

### 3. Design for MCP's Strengths

**Good MCP Use Cases:**
- Query data from systems (read operations)
- Trigger actions in external systems (write operations)
- Transform data for AI consumption
- Generate files/visualizations
- Orchestrate multi-step workflows

**Poor MCP Use Cases:**
- Receive events from external systems (use separate webhook receiver)
- Real-time data streaming (use WebSocket service instead)
- Long-running background jobs (use job queue instead)

---

### 4. Compose MCP with Other Patterns

```
External System
    │
    │ Webhook (inbound)
    ▼
┌─────────────────┐
│ Webhook Handler │  ← Separate service
│ (Express/HTTP)  │
└─────────────────┘
    │
    │ Store event
    ▼
┌─────────────────┐
│   Database      │
└─────────────────┘
    ▲
    │ Query
    │
┌─────────────────┐
│  MCP Server     │  ← Query stored data
└─────────────────┘
    ▲
    │ Tool call
    │
┌─────────────────┐
│  AI Assistant   │
└─────────────────┘
```

**Pattern**: MCP queries data that was stored by other systems

---

## Summary: MCP Pattern Selection

| Need | Pattern | Example |
|------|---------|---------|
| **Send notifications** | Pattern 2 (Outbound) | Post to Slack webhook |
| **Check external system** | Pattern 2 (Outbound) | Query Google Calendar API |
| **Upload files** | Pattern 2 (Outbound) | Upload chart to Slack |
| **Monitor local files** | Pattern 1 (Subscriptions) | Watch log files for changes |
| **Receive events** | ❌ Not MCP | Build separate webhook receiver |
| **Long-running tasks** | Pattern 3 (Async)* | Video processing (*proposal only) |

\* Pattern 3 is not yet part of the MCP spec

---

## Butlr MCP Patterns

### Current (Implemented)

✅ **Data access tools** - Query Butlr APIs, return structured data
✅ **Outbound calls only** - MCP tools call Butlr API (Pattern 2)
✅ **Stateless** - Each tool call is independent
✅ **Natural language responses** - Tools return conversational summaries

### Future (Planned)

🚧 **Notification tools** - Send data to Slack/email (Pattern 2)
🚧 **Chart generation** - Create visualizations, upload to Slack (Pattern 2)
🚧 **Calendar tools** - Check/create Google Calendar events (Pattern 2)
🚧 **File exports** - Generate CSVs/PDFs, upload to systems (Pattern 2)

### Not Planned

❌ **Receive webhooks** - Not possible with MCP
❌ **Real-time push to clients** - Limited support, clients don't support yet
❌ **Bidirectional sync** - Not MCP's purpose

---

## Related Documentation

- [Slackbot Integration](../integrations/slackbot.md) - How to build integrations using outbound patterns
- [Chart Generation](../features/chart-generation.md) - Generating and uploading files (Pattern 2)
- [Conversation Memory](../features/conversation-memory.md) - State management for chatbots (outside MCP)

---

## References

**MCP Specification:**
- [Model Context Protocol](https://modelcontextprotocol.io) - Official documentation
- [MCP Resources](https://modelcontextprotocol.io/docs/concepts/resources) - Resource subscriptions
- [SEP-1391](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1391) - Async operations proposal

**Community Discussions:**
- [Webhooks Discussion](https://github.com/modelcontextprotocol/specification/discussions/102) - Server-to-client communication patterns
- [Notifications Best Practices](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/1192) - Handling notifications

**Real-World Implementations:**
- [slack-mcp-client](https://github.com/tuannvm/slack-mcp-client) - Slack bot with MCP (demonstrates outbound pattern)
- [mcp-observer-server](https://github.com/hesreallyhim/mcp-observer-server) - File monitoring (demonstrates subscriptions)
- [Slack MCP integrations](https://github.com/korotovsky/slack-mcp-server) - Production Slack + MCP examples
