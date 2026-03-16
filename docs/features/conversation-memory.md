# Conversation Memory & Context Management

> **Status**: 🚧 **Planned** - Conversation memory is not yet implemented. This document captures research and architectural patterns for future chatbot integrations.

This guide explains how to maintain conversation context across multiple messages in chat-based integrations like Slackbots, enabling multi-turn dialogues and context-aware responses.

## Table of Contents

- [Overview](#overview)
- [Session Identification](#session-identification)
- [Storage Patterns](#storage-patterns)
- [Memory Lifecycle](#memory-lifecycle)
- [Implementation Examples](#implementation-examples)
- [Performance Considerations](#performance-considerations)

---

## Overview

Conversation memory enables AI assistants to:
- Remember previous messages in a conversation
- Maintain context across multiple exchanges
- Provide more natural, coherent responses
- Avoid asking users to repeat information

### What Exists Today

✅ **Butlr MCP Server** is stateless - each tool call is independent
✅ **Natural language summaries** built into MCP tools
✅ **Caching layer** for asset topology (reduces repeated API calls)

🚧 **Planned**: Conversation memory for chatbot integrations (Slack, Teams)

### Why Memory Matters

**Without Memory:**
```
User: How busy is the café?
Bot: The café has 18 people, moderate for 2pm.

User: What about the lobby?
Bot: [No context - treats as new query]
```

**With Memory:**
```
User: How busy is the café?
Bot: The café has 18 people, moderate for 2pm.

User: What about the lobby?
Bot: [Remembers café context] The lobby has 8 people.
     Would you like to compare them?
```

---

## Session Identification

### Slack Thread-Based Sessions

Slack provides natural conversation boundaries through threads, channels, and DMs:

```typescript
// Pseudocode: Session ID generation
function getSessionId(slackEvent) {
  // Threaded conversations (best isolation)
  if (slackEvent.thread_ts) {
    return `${slackEvent.channel}_${slackEvent.thread_ts}`;
  }

  // Direct messages (per-user context)
  if (slackEvent.channel.startsWith('D')) {
    return `${slackEvent.channel}_${slackEvent.user}`;
  }

  // Channel messages (per-user to avoid cross-talk)
  return `${slackEvent.channel}_${slackEvent.user}`;
}
```

### Session Properties

| Context | Session ID Pattern | Isolation | Use Case |
|---------|-------------------|-----------|----------|
| **Thread** | `C123_TS456` | Per-thread | Best for team discussions |
| **DM** | `D123_U456` | Per-user | 1:1 conversations |
| **Channel** | `C123_U456` | Per-user in channel | Avoid cross-user context bleed |

### Example Session IDs

```typescript
// Thread in #operations
sessionId = "C12345_1234567890.123456"

// DM with user
sessionId = "D98765_U23456"

// Channel message (per-user)
sessionId = "C12345_U23456"
```

---

## Storage Patterns

### Pattern 1: In-Memory (Development)

**Best for**: Development, testing, low-traffic bots

```typescript
// Pseudocode: Simple Map storage
const conversationMemory = new Map<string, Message[]>();

function getHistory(sessionId: string): Message[] {
  return conversationMemory.get(sessionId) || [];
}

function addMessage(sessionId: string, message: Message) {
  const history = getHistory(sessionId);
  history.push(message);
  conversationMemory.set(sessionId, history);
}

// Usage in bot
const sessionId = getSessionId(event);
const history = getHistory(sessionId);

const response = await llm.chat({
  messages: [
    { role: "system", content: "You are Butlr assistant..." },
    ...history,
    { role: "user", content: event.text }
  ]
});

addMessage(sessionId, { role: "user", content: event.text });
addMessage(sessionId, { role: "assistant", content: response });
```

**Advantages:**
✅ Simple implementation
✅ Fast (no network calls)
✅ No infrastructure required

**Disadvantages:**
❌ Lost on restart
❌ Not scalable (memory grows unbounded)
❌ Single-instance only

---

### Pattern 2: PostgreSQL (Production)

**Best for**: Multi-instance deployments, persistence, analytics

```typescript
// Pseudocode: PostgreSQL-backed memory
import { PostgresChatMessageHistory } from '@langchain/community';

// Database schema
CREATE TABLE conversation_history (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(255) NOT NULL,
  user_id VARCHAR(50) NOT NULL,
  channel_id VARCHAR(50) NOT NULL,
  thread_ts VARCHAR(50),
  role VARCHAR(20) NOT NULL,  -- 'user' or 'assistant'
  content TEXT NOT NULL,
  tool_calls JSONB,  -- MCP tool calls made
  timestamp TIMESTAMP DEFAULT NOW(),
  INDEX idx_session (session_id),
  INDEX idx_user (user_id),
  INDEX idx_timestamp (timestamp)
);

// Implementation
const memory = new PostgresChatMessageHistory({
  tableName: "conversation_history",
  sessionId: sessionId,
  connectionString: process.env.DATABASE_URL
});

// Retrieve history
const messages = await memory.getMessages();

// Add new messages
await memory.addUserMessage(userMessage);
await memory.addAIMessage(assistantResponse);
```

**Advantages:**
✅ Persistent across restarts
✅ Scalable (multiple bot instances)
✅ Queryable for analytics
✅ Supports TTL via SQL triggers

**Disadvantages:**
❌ Requires PostgreSQL infrastructure
❌ Slightly slower (network latency)
❌ More complex setup

---

### Pattern 3: Redis (High Performance)

**Best for**: High-traffic bots, temporary memory (hours/days)

```typescript
// Pseudocode: Redis-backed memory
import { RedisChatMessageHistory } from '@langchain/community';
import { createClient } from 'redis';

const redisClient = createClient({
  url: process.env.REDIS_URL
});

await redisClient.connect();

const memory = new RedisChatMessageHistory({
  sessionId: sessionId,
  client: redisClient,
  ttl: 3600 * 24 * 7  // 7 days TTL
});

// Same interface as PostgreSQL
const messages = await memory.getMessages();
await memory.addUserMessage(userMessage);
await memory.addAIMessage(assistantResponse);
```

**Advantages:**
✅ Very fast (in-memory datastore)
✅ Built-in TTL (auto-expires old conversations)
✅ Handles high concurrency
✅ Scalable

**Disadvantages:**
❌ Requires Redis infrastructure
❌ More expensive than PostgreSQL
❌ Data not persistent (by design)

---

## Storage Comparison

| Feature | In-Memory | PostgreSQL | Redis |
|---------|-----------|------------|-------|
| **Speed** | Fastest | Fast | Very Fast |
| **Persistence** | No | Yes | Optional |
| **Scalability** | Single instance | Multi-instance | Multi-instance |
| **TTL Support** | Manual | Via triggers | Built-in |
| **Analytics** | No | Yes (SQL queries) | Limited |
| **Cost** | Free | $ | $$ |
| **Setup Complexity** | None | Medium | Medium |
| **Best For** | Dev/testing | Production | High-traffic |

---

## Memory Lifecycle

### 1. Context Window Management

LLMs have token limits - need to manage conversation length:

```typescript
// Pseudocode: Limit context window
const MAX_MESSAGES = 20;  // Keep last 10 exchanges

function getRecentHistory(sessionId: string): Message[] {
  const fullHistory = await memory.getMessages(sessionId);

  // Keep only recent messages
  return fullHistory.slice(-MAX_MESSAGES);
}
```

### 2. Conversation Summarization

For long conversations, summarize old messages:

```typescript
// Pseudocode: Summarize old context
async function summarizeIfNeeded(sessionId: string) {
  const history = await memory.getMessages(sessionId);

  if (history.length > 50) {
    // Summarize first 40 messages
    const oldMessages = history.slice(0, 40);
    const summary = await llm.chat({
      messages: [
        { role: "system", content: "Summarize this conversation concisely" },
        ...oldMessages
      ]
    });

    // Replace with summary + keep recent 10
    const newHistory = [
      { role: "system", content: `Previous conversation: ${summary}` },
      ...history.slice(-10)
    ];

    await memory.clear(sessionId);
    for (const msg of newHistory) {
      await memory.addMessage(sessionId, msg);
    }
  }
}
```

### 3. TTL and Expiration

Auto-expire idle conversations:

```sql
-- PostgreSQL: Delete conversations older than 7 days
DELETE FROM conversation_history
WHERE timestamp < NOW() - INTERVAL '7 days';

-- Run as cron job or trigger
```

```typescript
// Redis: Automatic with TTL
const memory = new RedisChatMessageHistory({
  sessionId,
  ttl: 3600 * 24 * 7  // 7 days, auto-expires
});
```

### 4. User-Specific Context

Optional: Track user preferences across conversations:

```typescript
// Pseudocode: User context cache
interface UserContext {
  userId: string;
  preferredSite?: string;
  favoriteRooms?: string[];
  lastQueried?: string;
  timezone?: string;
}

// Store in database
const userContext = await getUserContext(event.user);

// Use in system prompt
const systemPrompt = `You are Butlr assistant.
User preferences:
- Preferred site: ${userContext.preferredSite || "none"}
- Timezone: ${userContext.timezone || "UTC"}`;
```

---

## Implementation Examples

### Basic LangChain Integration

```typescript
// Pseudocode: Complete memory integration
import { ChatAnthropic } from "@langchain/anthropic";
import { PostgresChatMessageHistory } from "@langchain/community";
import { RunnableWithMessageHistory } from "@langchain/core/runnables";

// 1. Create LLM with MCP tools
const llm = new ChatAnthropic({
  model: "claude-3-5-sonnet",
  apiKey: process.env.ANTHROPIC_API_KEY
}).bindTools(mcpTools);

// 2. Wrap with memory
const llmWithMemory = new RunnableWithMessageHistory({
  runnable: llm,
  getMessageHistory: async (sessionId) => {
    return new PostgresChatMessageHistory({
      tableName: "conversation_history",
      sessionId: sessionId,
      connectionString: process.env.DATABASE_URL
    });
  },
  inputMessagesKey: "input",
  historyMessagesKey: "history"
});

// 3. Handle Slack message
app.message(async ({ message, say }) => {
  const sessionId = getSessionId(message);

  // LangChain automatically:
  // - Loads conversation history
  // - Calls LLM with context
  // - Saves response
  const response = await llmWithMemory.invoke(
    { input: message.text },
    { configurable: { sessionId } }
  );

  await say({
    text: response.content,
    thread_ts: message.ts
  });
});
```

### Thread Isolation Example

```typescript
// Pseudocode: Separate contexts per thread
const CONVERSATIONS = {
  "C123_TS456": [  // Thread #1
    { role: "user", content: "How busy is HQ?" },
    { role: "assistant", content: "HQ has 45 people..." }
  ],
  "C123_TS789": [  // Thread #2 (separate context)
    { role: "user", content: "Check Burlingame office" },
    { role: "assistant", content: "Burlingame has 23 people..." }
  ]
};

// Each thread maintains independent context
```

---

## Performance Considerations

### Memory vs Latency Trade-offs

| Approach | Latency | Memory Usage | Scalability |
|----------|---------|--------------|-------------|
| **Load full history** | +100-500ms | High | Poor |
| **Load recent (20 msgs)** | +50-100ms | Low | Good |
| **Summarize + recent** | +200ms (1st time) | Very Low | Excellent |

### Recommended Limits

```typescript
const LIMITS = {
  MAX_MESSAGES_PER_SESSION: 100,
  RECENT_CONTEXT_WINDOW: 20,
  SUMMARIZE_THRESHOLD: 50,
  SESSION_TTL_DAYS: 7,
  MAX_CONCURRENT_SESSIONS: 1000
};
```

### Caching Strategy

```typescript
// Pseudocode: Cache recent sessions in memory
const recentSessions = new LRUCache({
  max: 100,  // Cache 100 active sessions
  ttl: 1000 * 60 * 5,  // 5 minute TTL
});

async function getHistory(sessionId: string) {
  // Check cache first
  if (recentSessions.has(sessionId)) {
    return recentSessions.get(sessionId);
  }

  // Load from database
  const history = await database.getMessages(sessionId);
  recentSessions.set(sessionId, history);
  return history;
}
```

---

## Best Practices

### 1. Always Include System Prompt

```typescript
const messages = [
  {
    role: "system",
    content: `You are Butlr assistant. You help teams understand space occupancy.
    Current date: ${new Date().toISOString()}
    User timezone: ${userContext.timezone}`
  },
  ...conversationHistory,
  { role: "user", content: newMessage }
];
```

### 2. Handle Context Overflow

```typescript
try {
  const response = await llm.chat({ messages });
} catch (error) {
  if (error.message.includes('context_length_exceeded')) {
    // Automatically summarize and retry
    await summarizeConversation(sessionId);
    const response = await llm.chat({ messages: await getRecentHistory(sessionId) });
  }
}
```

### 3. Graceful Degradation

```typescript
// If memory fails, fall back to stateless
try {
  const history = await memory.getMessages(sessionId);
} catch (error) {
  console.error('Memory unavailable, using stateless mode');
  const history = [];  // Continue without context
}
```

### 4. Monitor Memory Growth

```typescript
// Track session sizes
await db.query(`
  SELECT
    session_id,
    COUNT(*) as message_count,
    SUM(LENGTH(content)) as total_bytes
  FROM conversation_history
  GROUP BY session_id
  HAVING COUNT(*) > 100
  ORDER BY message_count DESC
`);
```

---

## Next Steps

Once implemented, conversation memory will enable:
- **Natural multi-turn dialogues** - Users can ask follow-up questions
- **Context-aware responses** - Bot remembers previous queries
- **Reduced repetition** - Users don't need to re-explain context
- **Better UX** - Conversations feel more natural and coherent

---

## Related Documentation

- [Slackbot Integration](../integrations/slackbot.md) - How memory fits into Slackbot architecture
- [Chart Generation](chart-generation.md) - Multi-step file generation requires context
- [MCP Patterns](../architecture/mcp-patterns.md) - MCP server remains stateless

---

## References

**Research Sources:**
- [LangChain Memory](https://python.langchain.com/docs/how_to/chatbots_memory/) - Conversation memory patterns
- [PostgresChatMessageHistory](https://python.langchain.com/docs/integrations/memory/postgres_chat_message_history/) - PostgreSQL backend
- [RedisChatMessageHistory](https://python.langchain.com/docs/integrations/memory/redis_chat_message_history/) - Redis backend
- [Slack Threads API](https://api.slack.com/messaging/managing#threads) - Thread context in Slack
