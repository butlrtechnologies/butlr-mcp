# MCP Tools Design Document

**Last Updated:** 2025-01-13
**Architecture:** Question-Driven Design
**Total Tools:** 10 (8 conversational + 2 data)

This document provides comprehensive specifications for all MCP tools in the Butlr MCP Server, designed around **user questions** rather than API endpoints.

---

## Design Philosophy

### Question-Driven vs API-Driven

**Traditional API-Driven Approach:**
```
Tools map to API endpoints:
- get_room_occupancy(ids, start, stop, interval, function...)
→ Agent must understand APIs, compute insights, format responses
```

**Our Question-Driven Approach:**
```
Tools answer questions:
- butlr_available_rooms() → "Are there conference rooms free?"
- butlr_space_busyness(space_id) → "How busy is the café?"
→ Agent asks natural questions, gets conversational answers
```

### Why Question-Driven?

**MCP Best Practices Alignment:**
1. ✅ "Avoid mapping every API endpoint to a new MCP tool" - Group related tasks
2. ✅ "Too many tools cause LLM confusion" - Each tool = one question type
3. ✅ "Intentional tool design" - Clear purpose, natural language outputs
4. ✅ "Reduce token overhead" - 9 focused tools vs many generic ones

**Real-World Usage:**
- Slack/Teams bots answer questions, not API queries
- Dashboard pre-computes insights ("quiet", "moderate", "busy")
- Users want answers ("5 rooms available") not data (`[{occupancy: 0}, ...]`)

---

## Tool Architecture: Two Tiers

### Tier 1: Conversational Tools (8 tools)
**Target:** Slack/Teams bots, voice assistants, chat interfaces
**Characteristics:** Natural language I/O, pre-computed insights, opinionated time windows
**Coverage:** ~90% of user queries

**Tools:**
1. `butlr_hardware_snapshot` 🆕 - Device health & battery status
2. `butlr_available_rooms` - Room availability finder
3. `butlr_space_busyness` - Real-time busyness check
4. `butlr_traffic_flow` - Entry/exit counts
5. `butlr_now_summary` - Building snapshot
6. `butlr_top_used_spaces` - Utilization rankings
7. `butlr_usage_trend` - Period comparisons
8. `butlr_space_insights` - AI-generated insights

### Tier 2: Data Tools (2 tools)
**Target:** Power users, custom analytics, external integrations
**Characteristics:** Flexible parameters, raw timeseries, minimal processing
**Coverage:** ~10% of queries requiring custom analysis

**Tools:**
9. `butlr_get_occupancy_data` - Raw timeseries queries
10. `butlr_search_assets` ✅ - Fuzzy asset search (implemented)

---

## Tier 1: Conversational Tools

### 1. `butlr_hardware_snapshot` 🆕

**User Question:** *"How are our devices doing today?"*

**Purpose:** Unified device health check combining online/offline status and battery health. Single tool answers operational health questions without chaining separate tools.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "scope_type": {
      "type": "string",
      "enum": ["org", "site", "building", "floor", "room"],
      "default": "org",
      "description": "Scope of the health check"
    },
    "scope_id": {
      "type": "string",
      "description": "Required if scope_type != 'org'"
    },
    "include_battery_details": {
      "type": "boolean",
      "default": false,
      "description": "Include list of sensors needing battery service (context-efficient: returns only when needed)"
    },
    "battery_status_filter": {
      "type": "string",
      "enum": ["critical", "due_soon", "healthy", "all"],
      "default": "all",
      "description": "Filter battery details by status. 'critical' = overdue, 'due_soon' = <30 days"
    },
    "limit": {
      "type": "number",
      "default": 20,
      "description": "Max devices to return in battery_details list"
    }
  },
  "additionalProperties": false
}
```

**Output Schema:**
```json
{
  "summary": "45 of 52 sensors online (87%), 8 of 8 hives online (100%). 3 batteries critical, 7 due within 30 days.",
  "sensors": {
    "total": 52,
    "online": 45,
    "offline": 7,
    "percent_online": 86.5
  },
  "hives": {
    "total": 8,
    "online": 8,
    "offline": 0,
    "percent_online": 100
  },
  "battery_health": {
    "critical": 3,
    "due_soon": 7,
    "healthy": 42,
    "no_battery": 0
  },
  "battery_details": [
    {
      "sensor_id": "sensor_789",
      "sensor_name": "Conference Room A",
      "mac_address": "00-17-0d-00-00-76-32-e6",
      "path": "HQ > Building 1 > Floor 3 > Conf A",
      "status": "critical",
      "battery_change_by_date": "2025-01-10",
      "days_remaining": -2,
      "last_battery_change_date": "2024-07-15",
      "next_battery_change_date": "2025-01-10"
    }
  ],
  "breakdown_by_floor": [
    {
      "floor_id": "floor_456",
      "floor_name": "Floor 3",
      "sensors_online": 12,
      "sensors_total": 15,
      "percent_online": 80,
      "batteries_critical": 1,
      "batteries_due_soon": 3
    }
  ],
  "offline_devices": [
    {
      "type": "sensor",
      "id": "sensor_123",
      "name": "Lobby Entrance",
      "mac_address": "00-17-0d-00-00-76-27-40",
      "path": "HQ > Building 1 > Floor 1 > Lobby",
      "last_heartbeat": "2025-01-12T08:00:00Z",
      "hours_offline": 30
    },
    {
      "type": "hive",
      "id": "hive_456",
      "name": "Hive 12",
      "serial_number": "H2-2024-001",
      "path": "HQ > Building 1 > Floor 3",
      "last_heartbeat": "2025-01-11T14:00:00Z",
      "hours_offline": 44
    }
  ],
  "scope": {
    "type": "building",
    "id": "building_1",
    "name": "HQ Building"
  },
  "timestamp": "2025-01-13T14:00:00Z"
}
```

**API Mapping:**
1. **GraphQL:** Query sensors and hives with online status
   ```graphql
   query GetDeviceHealth($buildingId: ID) {
     building(id: $buildingId) {
       floors {
         sensors {
           id, name, mac_address, is_online, power_type,
           last_battery_change_date,
           next_battery_change_date,
           battery_change_by_date,
           last_heartbeat, floorID, roomID
         }
         hives {
           id, name, serialNumber, isOnline, lastHeartbeat, floorID
         }
       }
     }
   }
   ```
2. **Compute Battery Status:**
   ```typescript
   function getBatteryStatus(sensor: Sensor): "critical" | "due_soon" | "healthy" | "no_battery" {
     if (sensor.power_type === "Wired") return "no_battery";
     const daysRemaining = daysBetween(now, sensor.battery_change_by_date);
     if (daysRemaining < 0) return "critical";
     if (daysRemaining <= 30) return "due_soon";
     return "healthy";
   }
   ```
3. **Aggregate by Floor:** If scope is building/site with >1 floor
4. **Sort:** Battery details by `days_remaining` ascending (most urgent first)

**Implementation Notes:**
- **Context-Efficient:** Default returns summaries only (~200 tokens)
- **Actionable Details:** `include_battery_details=true` returns specific devices needing service
- **Workflow-Oriented:** Answers "How are devices?" + "Which need battery changes?" in one call
- **Multi-Level:** Automatically includes floor breakdown for multi-floor buildings
- **Human-Readable IDs:** Includes MAC addresses (sensors) and serial numbers (hives) that staff actually use
- Wired sensors excluded from battery calculations but counted in online/offline
- Sort offline devices by hours offline (longest first)
- Battery details sorted by urgency (days_remaining ascending)

---

### 2. `butlr_available_rooms`

**User Question:** *"Are there any conference rooms free right now?"*

**Purpose:** Find rooms currently unoccupied, optionally filtered by capacity or tags.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "min_capacity": {
      "type": "number",
      "description": "Minimum room capacity (number of people)"
    },
    "max_capacity": {
      "type": "number",
      "description": "Maximum room capacity"
    },
    "tags": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Filter by room tags (e.g., ['conference', 'video-equipped'])"
    },
    "building_id": {
      "type": "string",
      "description": "Limit to specific building"
    },
    "floor_id": {
      "type": "string",
      "description": "Limit to specific floor"
    }
  },
  "additionalProperties": false
}
```

**Output Schema:**
```json
{
  "summary": "5 conference rooms available (capacity 4-12 people)",
  "available_rooms": [
    {
      "id": "room_123",
      "name": "Conference Room A",
      "path": "HQ > Building 1 > Floor 3 > Conf A",
      "capacity": { "max": 8, "mid": 6 },
      "area": { "value": 150, "unit": "sqft" },
      "tags": ["conference", "video-equipped"],
      "available_for_minutes": 45,
      "last_occupied": "2025-01-13T13:15:00Z"
    }
  ],
  "building_context": {
    "building_name": "Building 1",
    "total_rooms": 45,
    "available_rooms": 12,
    "occupancy_percent": 73
  },
  "total_available": 5,
  "filtered_by": {
    "min_capacity": 4,
    "tags": ["conference"]
  },
  "timestamp": "2025-01-13T14:00:00Z"
}
```

**API Mapping:**
1. **GraphQL:** `rooms(floorIDs)` or `roomsByTag(tags)` → get rooms with capacity
2. **v3/reporting:** Current occupancy for all matching rooms
   ```json
   {
     "filter": {
       "start": "-5m",
       "measurements": ["room_occupancy"],
       "rooms": { "eq": ["room_123", "room_456", ...] }
     },
     "window": { "every": "5m", "function": "max" }
   }
   ```
3. **Filter:** Rooms where `occupancy == 0`
4. **Enrich:** Add asset names/paths from topology cache
5. **Sort:** By capacity or last_occupied

**Implementation Notes:**
- Cache current occupancy (TTL: 60s) to reduce API calls
- Consider room "available" if occupancy=0 for last 5 minutes
- `available_for_minutes` = time since last occupancy > 0

---

### 3. `butlr_space_busyness`

**User Question:** *"How busy is the café right now? Should I go?"*

**Purpose:** Return relative busyness for any space with qualitative label and context.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "space_id_or_name": {
      "type": "string",
      "description": "Space ID (room_123) or search term ('café', 'lobby')"
    },
    "include_trend": {
      "type": "boolean",
      "default": true,
      "description": "Compare to typical occupancy for this day/time"
    }
  },
  "required": ["space_id_or_name"],
  "additionalProperties": false
}
```

**Output Schema:**
```json
{
  "summary": "Café: Moderate (12 people, 45% capacity, typical for 2pm Thursday)",
  "space": {
    "id": "room_567",
    "name": "Employee Café",
    "type": "room",
    "path": "HQ > Building 1 > Floor 1 > Café"
  },
  "current": {
    "occupancy": 12,
    "capacity": { "max": 27, "mid": 20 },
    "utilization_percent": 44.4,
    "label": "moderate",
    "as_of": "2025-01-13T14:00:00Z"
  },
  "trend": {
    "typical_for_time": 11.2,
    "vs_typical_percent": 7.1,
    "trend_label": "typical",
    "historical_context": "Thursday 2pm avg: 11 people (last 4 weeks)"
  },
  "recommendation": "Good time to visit - not too crowded",
  "timestamp": "2025-01-13T14:00:00Z"
}
```

**API Mapping:**
1. **If name provided:** `butlr_search_assets(query, types=['room', 'zone'])` → get ID
2. **GraphQL:** `room(id)` or `zone(id)` → get capacity
3. **v3/reporting:** Current occupancy
   ```json
   {
     "filter": {
       "start": "-5m",
       "measurements": ["room_occupancy"],
       "rooms": { "eq": ["room_567"] }
     },
     "window": { "every": "1m", "function": "max" }
   }
   ```
4. **v4/stats (optional):** Historical average for same day-of-week + hour
   ```json
   {
     "measurements": ["room_occupancy"],
     "items": ["room_567"],
     "start": "-4w",
     "stop": "now"
   }
   // Then filter to same day-of-week + hour client-side
   ```
5. **Compute:**
   - `utilization_percent = (occupancy / capacity.max) * 100`
   - `label = getLabel(utilization_percent)` (quiet <30%, moderate 30-70%, busy >70%)
   - `trend_label = compareTo Typical(current, typical)`

**Implementation Notes:**
- Qualitative labels make responses more conversational
- Historical context adds value ("typical for Thursday 2pm")
- Recommendation field helps decision-making

---

### 4. `butlr_traffic_flow`

**User Question:** *"How many people entered the lobby today?"*

**Purpose:** Return entry/exit counts for spaces with traffic-mode sensors.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "space_id_or_name": {
      "type": "string",
      "description": "Space ID or search term"
    },
    "time_window": {
      "type": "string",
      "enum": ["20m", "1h", "today", "custom"],
      "default": "today",
      "description": "Time period for traffic count"
    },
    "custom_start": {
      "type": "string",
      "description": "Custom start time (ISO-8601 or relative '-24h'). Required if time_window='custom'"
    },
    "custom_stop": {
      "type": "string",
      "description": "Custom stop time. Defaults to 'now'"
    },
    "include_trend": {
      "type": "boolean",
      "default": true,
      "description": "Compare to typical traffic for this period"
    }
  },
  "required": ["space_id_or_name"],
  "additionalProperties": false
}
```

**Output Schema:**
```json
{
  "summary": "Lobby: 47 entries today (8am-2pm), 23% higher than typical Monday",
  "space": {
    "id": "room_890",
    "name": "Main Lobby",
    "type": "room",
    "path": "HQ > Building 1 > Floor 1 > Lobby",
    "sensor_mode": "traffic"
  },
  "traffic": {
    "entries": 47,
    "exits": 39,
    "net": 8,
    "period": {
      "start": "2025-01-13T08:00:00Z",
      "stop": "2025-01-13T14:00:00Z",
      "duration_hours": 6,
      "description": "Today (so far)"
    }
  },
  "trend": {
    "typical_entries_for_period": 38.3,
    "vs_typical_percent": 22.7,
    "trend_label": "busier",
    "historical_context": "Monday 8am-2pm avg: 38 entries (last 4 weeks)"
  },
  "hourly_breakdown": [
    { "hour": "08:00", "entries": 12, "exits": 3 },
    { "hour": "09:00", "entries": 15, "exits": 8 },
    { "hour": "10:00", "entries": 8, "exits": 11 }
  ],
  "peak_hour": "09:00-10:00 (15 entries)",
  "timestamp": "2025-01-13T14:00:00Z"
}
```

**API Mapping:**
1. **If name:** `butlr_search_assets` → get ID
2. **GraphQL:** `room(id)` → verify has traffic-mode sensors
3. **v3/reporting:** Traffic data with sum aggregation
   ```json
   {
     "filter": {
       "start": "2025-01-13T00:00:00Z",  // Or "-20m" for recent
       "stop": "now",
       "measurements": ["traffic"],
       "rooms": { "eq": ["room_890"] }
     },
     "window": { "every": "1h", "function": "sum" },
     "group_by": { "order": ["room_id"], "raw": false }
   }
   ```
4. **v4/stats (optional):** Historical traffic for comparison
5. **Compute:**
   - Net traffic = entries - exits
   - Compare to historical average
   - Identify peak hour
   - Generate trend label

**Implementation Notes:**
- Validate space has traffic-mode sensors before querying
- Traffic sensors reset daily - note in period description
- Hourly breakdown useful for identifying peak times
- Net traffic can indicate accumulation (people staying)

---

### 5. `butlr_now_summary`

**User Question:** *"What's the office like right now?"*

**Purpose:** Compact snapshot of building occupancy, busiest areas, availability.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "building_id": {
      "type": "string",
      "description": "Specific building ID. If omitted, summarizes all buildings"
    },
    "include_floor_breakdown": {
      "type": "boolean",
      "default": true,
      "description": "Include per-floor occupancy details"
    },
    "include_available_rooms": {
      "type": "boolean",
      "default": true,
      "description": "Count available meeting rooms"
    }
  },
  "additionalProperties": false
}
```

**Output Schema:**
```json
{
  "summary": "Building HQ: 60% occupied. Floor 3 busiest (85%). 23 rooms available.",
  "building": {
    "id": "building_1",
    "name": "HQ Building",
    "current_occupancy": 142,
    "capacity": { "max": 235, "mid": 180 },
    "utilization_percent": 60.4,
    "label": "moderate"
  },
  "floors": [
    {
      "id": "floor_3",
      "name": "Floor 3",
      "occupancy": 48,
      "capacity": { "max": 56 },
      "utilization_percent": 85.7,
      "label": "busy",
      "rank": 1
    },
    {
      "id": "floor_1",
      "name": "Floor 1",
      "occupancy": 32,
      "capacity": { "max": 67 },
      "utilization_percent": 47.8,
      "label": "moderate",
      "rank": 2
    }
  ],
  "available_rooms": {
    "total": 23,
    "by_capacity": {
      "small_1_4": 12,
      "medium_5_8": 8,
      "large_9_plus": 3
    }
  },
  "time_context": {
    "as_of": "2025-01-13T14:00:00Z",
    "day_of_week": "Monday",
    "typical_for_time": "This is typical Monday 2pm occupancy"
  },
  "timestamp": "2025-01-13T14:00:00Z"
}
```

**API Mapping:**
1. **GraphQL:** `building(id)` with nested `floors` and `rooms` → get hierarchy + capacity
2. **v3/reporting:** Current occupancy for all floors
   ```json
   {
     "filter": {
       "start": "-5m",
       "measurements": ["floor_occupancy"],
       "spaces": { "eq": ["floor_1", "floor_2", "floor_3"] }
     },
     "window": { "every": "5m", "function": "max" }
   }
   ```
3. **v3/reporting:** Current room occupancy (if include_available_rooms)
4. **Aggregate:** Building total, rank floors, count available rooms
5. **Format:** Natural language summary

**Implementation Notes:**
- Most expensive query (building-wide data)
- Cache aggressively (60s TTL for current occupancy)
- Rank floors by utilization %
- Group available rooms by size for better UX

---

### 6. `butlr_top_used_spaces`

**User Question:** *"What are the most used conference rooms this week?"*

**Purpose:** Rank spaces by utilization over a time period.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "space_type": {
      "type": "string",
      "enum": ["room", "zone", "floor"],
      "description": "Type of space to rank"
    },
    "period": {
      "type": "string",
      "enum": ["today", "week", "month", "custom"],
      "default": "week",
      "description": "Time period for analysis"
    },
    "custom_start": {
      "type": "string",
      "description": "Custom period start (if period='custom')"
    },
    "custom_stop": {
      "type": "string",
      "description": "Custom period stop"
    },
    "tags": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Filter by tags (e.g., ['conference'])"
    },
    "scope_id": {
      "type": "string",
      "description": "Limit to building or floor"
    },
    "limit": {
      "type": "number",
      "default": 10,
      "description": "Number of results to return"
    },
    "order_by": {
      "type": "string",
      "enum": ["utilization", "occupancy", "hours_occupied"],
      "default": "utilization"
    }
  },
  "required": ["space_type"],
  "additionalProperties": false
}
```

**Output Schema:**
```json
{
  "summary": "Top 5 conference rooms this week (by utilization %)",
  "period": {
    "start": "2025-01-06T00:00:00Z",
    "stop": "2025-01-13T00:00:00Z",
    "description": "This week (Mon-Sun)",
    "total_hours": 168
  },
  "spaces": [
    {
      "rank": 1,
      "id": "room_234",
      "name": "Executive Boardroom",
      "path": "HQ > Building 1 > Floor 5 > Exec Boardroom",
      "capacity": { "max": 16, "mid": 12 },
      "tags": ["conference", "executive"],
      "statistics": {
        "utilization_percent": 78.5,
        "avg_occupancy": 9.4,
        "peak_occupancy": 15,
        "hours_occupied": 132,
        "hours_available": 36
      }
    }
  ],
  "metadata": {
    "total_spaces_analyzed": 23,
    "filter_applied": {
      "tags": ["conference"],
      "scope": "building_1"
    }
  },
  "timestamp": "2025-01-13T14:00:00Z"
}
```

**API Mapping:**
1. **If tags:** `roomsByTag(tags)` → get room IDs
2. **v4/stats:** Aggregate statistics for period
   ```json
   {
     "measurements": ["room_occupancy"],
     "items": ["room_123", "room_234", ...],
     "start": "-7d",
     "stop": "now"
   }
   ```
3. **GraphQL:** Get capacity for utilization calculation
4. **Compute:**
   - `utilization_percent = (mean_occupancy / capacity.max) * 100`
   - `hours_occupied = periods where occupancy > 0`
5. **Sort:** By chosen metric, limit to N

**Implementation Notes:**
- Use v4/stats for efficiency (returns pre-computed min/max/mean)
- Utilization % is most meaningful ranking metric
- Include both avg and peak for context

---

### 7. `butlr_usage_trend`

**User Question:** *"Is this room used more this week than last week?"*

**Purpose:** Compare space utilization between two time periods.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "space_id_or_name": {
      "type": "string",
      "description": "Space ID or search term"
    },
    "compare_periods": {
      "type": "array",
      "items": { "type": "string" },
      "enum": [
        ["this_week", "last_week"],
        ["this_month", "last_month"],
        ["today", "yesterday"],
        "custom"
      ],
      "default": ["this_week", "last_week"],
      "description": "Periods to compare"
    },
    "custom_periods": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "start": { "type": "string" },
          "stop": { "type": "string" },
          "label": { "type": "string" }
        }
      },
      "description": "Custom periods if compare_periods='custom'"
    }
  },
  "required": ["space_id_or_name"],
  "additionalProperties": false
}
```

**Output Schema:**
```json
{
  "summary": "Room 5A: 23% more utilized this week (67% vs 54%)",
  "space": {
    "id": "room_123",
    "name": "Room 5A",
    "type": "room",
    "capacity": { "max": 8 }
  },
  "periods": [
    {
      "label": "This week",
      "start": "2025-01-06T00:00:00Z",
      "stop": "2025-01-13T00:00:00Z",
      "statistics": {
        "avg_occupancy": 5.4,
        "utilization_percent": 67.5,
        "peak_occupancy": 8,
        "hours_occupied": 112
      }
    },
    {
      "label": "Last week",
      "start": "2024-12-30T00:00:00Z",
      "stop": "2025-01-06T00:00:00Z",
      "statistics": {
        "avg_occupancy": 4.3,
        "utilization_percent": 53.8,
        "peak_occupancy": 8,
        "hours_occupied": 94
      }
    }
  ],
  "comparison": {
    "delta_occupancy": 1.1,
    "delta_utilization_percent": 13.7,
    "delta_hours_occupied": 18,
    "trend": "increasing",
    "significance": "notable",
    "interpretation": "Usage increased significantly compared to last week"
  },
  "timestamp": "2025-01-13T14:00:00Z"
}
```

**API Mapping:**
1. **If name:** `butlr_search_assets` → get ID
2. **GraphQL:** Get capacity
3. **v4/stats:** Two queries (one per period)
   ```json
   // Period 1
   { "items": ["room_123"], "start": "-7d", "stop": "now" }

   // Period 2
   { "items": ["room_123"], "start": "-14d", "stop": "-7d" }
   ```
4. **Compute:**
   - Delta in occupancy, utilization, hours
   - Trend direction (increasing/decreasing/stable)
   - Significance (notable if >15% change, slight if 5-15%, minimal if <5%)

**Implementation Notes:**
- Period presets ("this_week") handle timezone complexity
- Significance threshold helps filter noise
- Interpretation field makes trend actionable

---

### 8. `butlr_space_insights`

**User Question:** *"Tell me something about my office I might not think to ask"*

**Purpose:** Surface interesting patterns, anomalies, or optimization opportunities.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "scope": {
      "type": "string",
      "enum": ["building", "floor", "site"],
      "default": "building",
      "description": "Analysis scope"
    },
    "scope_id": {
      "type": "string",
      "description": "Specific scope ID. If omitted, uses user's default building"
    },
    "insight_types": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": ["underutilized", "overutilized", "anomalies", "patterns", "opportunities"]
      },
      "description": "Types of insights to generate. If omitted, finds all"
    },
    "period": {
      "type": "string",
      "enum": ["week", "month"],
      "default": "month",
      "description": "Analysis period"
    },
    "min_severity": {
      "type": "string",
      "enum": ["low", "medium", "high"],
      "default": "medium",
      "description": "Minimum insight severity to include"
    }
  },
  "additionalProperties": false
}
```

**Output Schema:**
```json
{
  "summary": "Found 3 notable insights for Building HQ (analyzed last month)",
  "scope": {
    "type": "building",
    "id": "building_1",
    "name": "HQ Building",
    "total_spaces": 67
  },
  "insights": [
    {
      "type": "underutilized",
      "severity": "high",
      "title": "4 rarely-used rooms on Floor 2",
      "description": "Rooms 2A, 2B, 2C, 2D averaged <10% utilization this month (typical is 45%)",
      "affected_spaces": [
        {
          "id": "room_2a",
          "name": "Room 2A",
          "utilization_percent": 8.3,
          "vs_building_avg": -36.7
        }
      ],
      "recommendation": "Consider repurposing as focus areas or storage",
      "potential_impact": {
        "energy_savings_annual": "$15,000",
        "freed_space_sqft": 600
      },
      "supporting_data": {
        "period_analyzed": "Last 30 days",
        "building_avg_utilization": 45.0
      }
    },
    {
      "type": "pattern",
      "severity": "medium",
      "title": "Gym peak usage: 12-1pm and 5-6pm",
      "description": "Consistent daily pattern with 2 peaks. Consider staggered lunch breaks to reduce crowding.",
      "affected_spaces": [{ "id": "room_gym", "name": "Employee Gym" }],
      "recommendation": "Communicate peak times to employees; suggest off-peak incentives"
    },
    {
      "type": "opportunity",
      "severity": "medium",
      "title": "Floor 4 has uneven utilization",
      "description": "East wing 72% utilized, west wing 31%. Imbalanced load.",
      "recommendation": "Redistribute teams or convert west wing to collaboration spaces",
      "potential_impact": {
        "better_space_utilization": "Could reduce footprint by 20%"
      }
    }
  ],
  "metadata": {
    "total_insights_found": 3,
    "period": "Last 30 days",
    "spaces_analyzed": 67,
    "filters_applied": { "min_severity": "medium" }
  },
  "timestamp": "2025-01-13T14:00:00Z"
}
```

**API Mapping:**
1. **GraphQL:** Get all rooms/zones in scope with tags, capacity
2. **v4/stats:** Aggregate stats for period
3. **Analyze:**
   - Underutilized: `utilization < 15%` and `< (avg - 2*stdev)`
   - Overutilized: `utilization > 85%` consistently
   - Anomalies: High variance (stdev > mean)
   - Patterns: Detect daily/weekly cycles
4. **Generate:** Natural language insights with recommendations

**Implementation Notes:**
- Most complex tool - requires pattern detection algorithms
- Could use simple heuristics initially, ML models later
- Prioritize insights by severity (high = actionable, low = FYI)
- ROI estimates add business value

---

## Tier 2: Data Tools

### 9. `butlr_get_occupancy_data`

**User Question:** *"Show me minute-by-minute occupancy for Room 5A last month"*

**Purpose:** Raw timeseries data for power users and custom analysis.

**Input Schema:**
```json
{
  "type": "object",
  "properties": {
    "asset_ids": {
      "type": "array",
      "items": { "type": "string" },
      "description": "Asset IDs to query"
    },
    "asset_type": {
      "type": "string",
      "enum": ["room", "zone", "floor"],
      "description": "Asset type (determines filter field and measurement)"
    },
    "start": {
      "type": "string",
      "description": "Start time (ISO-8601 or relative '-7d')"
    },
    "stop": {
      "type": "string",
      "description": "Stop time. Defaults to 'now'"
    },
    "interval": {
      "type": "string",
      "enum": ["1m", "5m", "15m", "30m", "1h", "6h", "12h", "1d"],
      "default": "1h",
      "description": "Aggregation window"
    },
    "function": {
      "type": "string",
      "enum": ["mean", "max", "min", "sum", "first", "last"],
      "default": "mean",
      "description": "Aggregation function"
    },
    "measurements": {
      "type": "array",
      "items": {
        "type": "string",
        "enum": ["room_occupancy", "zone_occupancy", "floor_occupancy", "traffic"]
      },
      "description": "Measurements to include. Defaults based on asset_type"
    },
    "timezone": {
      "type": "string",
      "default": "UTC",
      "description": "Timezone for timestamps"
    },
    "include_statistics": {
      "type": "boolean",
      "default": false,
      "description": "Include min/max/mean summary statistics"
    },
    "include_metadata": {
      "type": "boolean",
      "default": true,
      "description": "Include asset names and capacity info"
    }
  },
  "required": ["asset_ids", "asset_type", "start"],
  "additionalProperties": false
}
```

**Output Schema:**
```json
{
  "series": {
    "room_123": {
      "asset": {
        "id": "room_123",
        "name": "Conference Room A",
        "type": "room",
        "path": "HQ > Building 1 > Floor 3 > Conf A",
        "capacity": { "max": 8, "mid": 6 }
      },
      "data_points": [
        {
          "start": "2024-12-15T00:00:00Z",
          "stop": "2024-12-15T01:00:00Z",
          "room_occupancy": 0
        },
        {
          "start": "2024-12-15T01:00:00Z",
          "stop": "2024-12-15T02:00:00Z",
          "room_occupancy": 2.3
        }
      ],
      "statistics": {
        "min": 0,
        "max": 8,
        "mean": 3.4,
        "sum": 2448,
        "count": 720
      }
    }
  },
  "query_metadata": {
    "asset_ids": ["room_123"],
    "asset_type": "room",
    "start": "2024-12-15T00:00:00Z",
    "stop": "2025-01-15T00:00:00Z",
    "interval": "1h",
    "function": "mean",
    "measurements": ["room_occupancy"],
    "timezone": "America/Los_Angeles",
    "total_points_per_series": 720
  },
  "timestamp": "2025-01-13T14:00:00Z"
}
```

**API Mapping:**
1. **v3/reporting:** Direct mapping
   ```json
   {
     "group_by": { "order": ["room_id"], "raw": true },
     "window": {
       "every": "1h",
       "function": "mean",
       "timezone": "America/Los_Angeles"
     },
     "filter": {
       "start": "2024-12-15T00:00:00Z",
       "stop": "2025-01-15T00:00:00Z",
       "measurements": ["room_occupancy"],
       "rooms": { "eq": ["room_123"] }
     },
     "options": { "format": "json", "timestamp": "RFC3339" }
   }
   ```
2. **GraphQL (if include_metadata):** Enrich with asset names, capacity
3. **Process:** Normalize timestamps to ISO-8601, group by asset_id

**Implementation Notes:**
- Maps asset_type to correct filter field (room→`rooms`, floor→`spaces`, zone→`zones`)
- Maps asset_type to correct measurement (`room_occupancy`, `floor_occupancy`, `zone_occupancy`)
- Validate: Respect `MCP_MAX_IDS` and `MCP_MAX_LOOKBACK_DAYS` limits
- Warn if query will return >10K points

---

### 10. `butlr_search_assets` ✅ IMPLEMENTED

See existing implementation in `src/tools/search-assets.ts`.

**Note:** Fuzzy matching successfully works around GraphQL's ID-only constraint.

---

## API Version & Endpoint Reference

### Production Endpoints

From `butlr-api-container/cmd/reporting/main.go:115-117`:

| Endpoint | Version | Access | Purpose |
|----------|---------|--------|---------|
| `POST /v3/reporting` | v3 | ✅ Production | Full-featured occupancy queries |
| `POST /v4/reporting` | v4 | ⚠️ Dashboard only | Simplified API (restricted) |
| `POST /v4/reporting/stats` | v4 | ✅ Production | Pre-computed statistics |

### v3/reporting API Schema

**Request Structure** (from `pkg/reporting/models/request.go`):

```typescript
{
  group_by?: {
    order?: string[],      // Group by fields: ['room_id', 'building_id']
    raw?: boolean          // true = raw points, false = nested grouping
  },
  window?: {
    every: string,         // '1m', '5m', '15m', '30m', '1h', '6h', '12h', '1d'
    function: string,      // 'mean', 'max', 'min', 'sum', 'first', 'last'
    offset?: string,       // Window offset
    timezone?: string,     // 'America/Los_Angeles', 'UTC'
    create_empty?: boolean,// Create buckets for missing data
    fill?: {
      use_previous?: boolean,
      value?: number
    }
  },
  filter?: {
    measurements: string[],    // Required: ['room_occupancy', 'traffic']
    start: string,             // ISO-8601 or relative '-24h'
    stop?: string,             // Defaults to 'now'
    spaces?: { eq: string[] },        // Floors (ID filter)
    rooms?: { eq: string[] },         // Rooms
    zones?: { eq: string[] },         // Zones
    tags?: { eq: string[] },          // Tag filter
    clients?: { eq: string[] },       // Sites/organizations
    buildings?: { eq: string[] },     // Buildings
    value?: {                  // Value range filter
      gte?: number,
      lte?: number,
      gt?: number,
      lt?: number
    },
    calibrated?: string,       // 'yes' or 'no'
    time_constraints?: {
      time_ranges?: [{ start: string, stop: string }],
      exclude_days_of_week?: string[]  // ['saturday', 'sunday']
    }
  },
  options?: {
    format?: 'json' | 'csv',
    precision?: 's' | 'ms' | 'us' | 'ns',
    timestamp?: 'RFC3339',
    includeCalibrationPoints?: boolean
  },
  paginate?: {
    page: number,   // 1-indexed
    limit: number   // Max per page
  },
  calibrationPoints?: [{
    timestamp: string,
    occupancy: number,
    type: 'user_provided' | 'pir_zero'
  }]
}
```

**Response Structure:**

```typescript
{
  data: {
    [group_key: string]: [{
      field: string,
      measurement: string,
      time: string,        // RFC3339
      value: number,
      timezone_offset: string,
      building_id: string,
      building_name: string,
      space_id: string,    // Floor ID
      space_name: string,  // Floor name
      room_id: string,
      room_name: string,
      zone_id: string,
      hive_id: string,
      sensor_id: string,
      mac_address: string
    }]
  },
  page_info?: {
    page: number,
    page_item_count: number,
    total_item_count: number,
    total_pages: number
  },
  calibrationPoints?: [...]  // If requested
}
```

### v4/stats API Schema

**Request Structure** (from `pkg/reporting/query/reportingv4/handler.go`):

```typescript
{
  measurements: string[],  // ['room_occupancy']
  items: string[] | [{ id: string, filter?: string[] }],  // Asset IDs
  start?: string,          // ISO-8601 or relative '-7d'
  stop?: string,           // Defaults to 'now'
  interval?: string        // Optional interval (may not be used for stats)
}
```

**Response Structure:**

```typescript
{
  data: {
    [asset_id: string]: {
      count: number,
      first: number,
      last: number,
      max: number,
      mean: number,
      median: number,
      min: number,
      stdev: number,
      sum: number
    }
  }
}
```

---

## Key Corrections from Initial Documentation

### Field Name Corrections
- ✅ `start` and `stop` (NOT `start` and `end`)
- ✅ Filter uses `stop`, not `end`

### Measurement Names
- ✅ `room_occupancy` (not generic `"occupancy"`)
- ✅ `zone_occupancy`
- ✅ `floor_occupancy`
- ✅ `traffic`

### Filter Field Mapping
| Asset Type | GraphQL Field | v3 Filter Field | Measurement |
|------------|---------------|-----------------|-------------|
| Site | `site` | `clients` | N/A (aggregate only) |
| Building | `building` | `buildings` | N/A (aggregate only) |
| Floor | `floor` | `spaces` | `floor_occupancy` |
| Room | `room` | `rooms` | `room_occupancy` |
| Zone | `zone` | `zones` | `zone_occupancy` |
| Sensor | `sensor` | `sensors` | N/A (device level) |
| Hive | `hive` | `hives` | N/A (device level) |

### Relative Time Support
The v3 API supports relative time strings:
- `"-24h"` - Last 24 hours
- `"-7d"` - Last 7 days
- `"-1w"` - Last week
- `"-1M"` - Last month
- `"now"` - Current time

---

## Implementation Guidelines

### Natural Language Formatting

**Qualitative Labels:**
```typescript
function getOccupancyLabel(utilization: number): string {
  if (utilization < 30) return "quiet";
  if (utilization < 70) return "moderate";
  return "busy";
}

function getTrendLabel(delta: number): "increasing" | "decreasing" | "stable" {
  if (delta > 15) return "increasing";
  if (delta < -15) return "decreasing";
  return "stable";
}

function getSignificance(delta: number): "notable" | "slight" | "minimal" {
  if (Math.abs(delta) > 15) return "notable";
  if (Math.abs(delta) > 5) return "slight";
  return "minimal";
}
```

### Summary String Construction

**Pattern:** `[Space]: [Label] ([Details], [Context])`

```typescript
function buildBusinessSummary(space: Space, current: Current, trend: Trend): string {
  const parts = [
    `${space.name}: ${current.label}`,
    `(${current.occupancy} people, ${current.utilization_percent}% capacity`,
  ];

  if (trend.trend_label !== "typical") {
    parts.push(`${trend.trend_label}`);
  }

  parts.push(`for ${getDayAndTime()})`);

  return parts.join(" ");
}

// Output: "Café: Moderate (12 people, 45% capacity, typical for 2pm Thursday)"
```

### Error Handling

Convert API errors to conversational responses:

```typescript
// API: 404 Not Found
{
  error: "Space not found",
  suggestion: "Try searching with: butlr_search_assets('café')"
}

// API: No traffic sensors
{
  error: "This space doesn't have traffic sensors",
  available_data: "Current occupancy available via butlr_space_busyness"
}

// API: Time range too large
{
  error: "Time range exceeds 90-day limit",
  suggestion: "Try a shorter period or use get_occupancy_data with pagination"
}
```

---

## Configuration

All tools respect these environment variables:

```bash
# API Configuration
BUTLR_TOKEN=<api_token>              # Required: API authentication token
BUTLR_ORG_ID=<org_id>                # Required: Organization ID
BUTLR_BASE_URL=https://api.butlr.io  # Optional: API base URL
BUTLR_TIMEZONE=America/Los_Angeles   # Optional: Default timezone

# Performance & Limits
MCP_CACHE_TOPO_TTL=600              # Topology cache TTL (seconds)
MCP_CACHE_OCCUPANCY_TTL=60          # Current occupancy cache TTL
MCP_CACHE_STATS_TTL=300             # Historical stats cache TTL
MCP_MAX_IDS=100                     # Max asset IDs per request
MCP_MAX_LOOKBACK_DAYS=90            # Max days for historical queries
MCP_CONCURRENCY=5                   # Max concurrent API calls

# Tool Configuration
BUTLR_TOOLSETS=conversational,data  # Enable/disable tool groups
BUTLR_BUSYNESS_THRESHOLDS=30,70     # Quiet/moderate/busy thresholds (%)
BUTLR_TREND_THRESHOLD=15            # Minimum % change for "notable" trend

# Debugging
DEBUG=butlr-mcp                     # Enable verbose logging
BUTLR_MCP_ANALYTICS=false           # Disable analytics
```

---

## Testing Strategy

### Unit Tests
- Natural language formatters (`getOccupancyLabel`, `buildSummary`)
- Trend calculators (`computeDelta`, `getSignificance`)
- Cache logic (TTL, invalidation)

### Integration Tests
- Mock v3/v4 API responses
- Test full tool execution end-to-end
- Validate output schemas

### Contract Tests
- Ensure tools match JSON Schema specs
- Validate all required fields present
- Test error handling paths

### Example Test Cases:
```typescript
describe('butlr_available_rooms', () => {
  it('returns empty list when no rooms available', async () => {
    mockCurrentOccupancy({ all_rooms_occupied: true });
    const result = await executeAvailableRooms({});
    expect(result.available_rooms).toEqual([]);
    expect(result.summary).toContain('0 rooms available');
  });

  it('filters by min_capacity', async () => {
    const result = await executeAvailableRooms({ min_capacity: 10 });
    result.available_rooms.forEach(room => {
      expect(room.capacity.max).toBeGreaterThanOrEqual(10);
    });
  });
});
```

---

## Performance Considerations

### Caching Strategy

**Three-Layer Cache:**
```typescript
// Layer 1: Topology (slow-changing)
const topologyCache = new LRUCache({
  max: 100,
  ttl: 600_000  // 10 minutes
});

// Layer 2: Current Occupancy (fast-changing)
const occupancyCache = new LRUCache({
  max: 500,
  ttl: 60_000   // 1 minute
});

// Layer 3: Historical Stats (medium-changing)
const statsCache = new LRUCache({
  max: 200,
  ttl: 300_000  // 5 minutes
});
```

### Request Optimization

**Batch Requests:**
```typescript
// Instead of N queries for N rooms:
const rooms = await Promise.all(ids.map(id => fetchRoom(id)));

// Do 1 query with grouped response:
const result = await v3Reporting({
  group_by: { order: ['room_id'], raw: true },
  filter: { rooms: { eq: ids } }
});
```

**Parallel Execution:**
```typescript
// Fetch topology and occupancy in parallel
const [topology, occupancy] = await Promise.all([
  getTopology(building_id),
  getCurrentOccupancy(building_id)
]);
```

---

## Implementation Status

### Phase 1: Foundation ✅ COMPLETE
- [x] `butlr_search_assets` - Fuzzy asset search
- [x] `butlr_get_asset_details` - Asset metadata retrieval

### Phase 2 Sprint 1: Real-Time Awareness ✅ COMPLETE (Jan 13, 2025)
**Infrastructure:**
- [x] v3 Reporting REST Client (`src/clients/reporting-client.ts`)
- [x] v4 Stats REST Client (`src/clients/stats-client.ts`)
- [x] Occupancy Cache (`src/cache/occupancy-cache.ts`)
- [x] Natural Language Utilities (`src/utils/natural-language.ts`)
- [x] undici HTTP client installed

**Tools:**
- [x] `butlr_hardware_snapshot` - Device health & battery status (NEW)
- [x] `butlr_available_rooms` - Room availability finder
- [x] `butlr_space_busyness` - Real-time busyness check
- [x] `butlr_traffic_flow` - Entry/exit counts

**Total: 6 tools operational (4 conversational + 2 data)**

### Next Steps

1. **Testing & Validation (Week of Jan 13-20)**
   - Write unit tests for natural-language.ts
   - Write integration tests (mocked APIs)
   - Test tools with real Butlr API
   - Performance testing (cache hit rates, response times)

2. **Documentation (Week of Jan 13-20)**
   - Create example queries guide
   - Update README with new tools
   - Add troubleshooting guide

3. **Phase 2 Sprint 2: Summary & Insights (Late Jan)**
   - `butlr_now_summary` - Building snapshot
   - `butlr_space_insights` - AI-generated insights

4. **Phase 2 Sprint 3: Analysis Tools (Early Feb)**
   - `butlr_top_used_spaces` - Utilization rankings
   - `butlr_usage_trend` - Period comparisons

5. **Phase 3: Data Tool (Mid Feb)**
   - `butlr_get_occupancy_data` - Raw timeseries queries

6. **Phase 4: Polish & Release (Late Feb)**
   - Comprehensive testing
   - Performance optimization
   - Documentation finalization
   - npm publish

---

## MCP Tool Annotations

All Butlr MCP tools include the following MCP protocol annotations:

- **readOnlyHint: true** - All tools perform read-only operations against the Butlr API. No data modification or deletion occurs.
- **destructiveHint: false** - No destructive operations are performed. Tools only query and return data.
- **idempotentHint: true** - Tools are idempotent. The same query parameters will return the same results (within cache TTL windows).
- **openWorldHint: true** - All tools interact with the external Butlr API. Results depend on live data from production systems.

These annotations help MCP clients (like Claude Desktop) understand tool behavior and optimize their usage patterns.

---

## Related Documentation

- `USER_STORIES.md` - User questions that drive tool design
- `API_CONSTRAINTS.md` - API limitations and workarounds
- `VISION.md` - Overall architecture and philosophy
- `.claude/tasks/006-question-driven-redesign.md` - Design decision rationale
- `.claude/tasks/ROADMAP.md` - Implementation roadmap
