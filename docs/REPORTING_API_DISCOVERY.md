I # Reporting API Discovery & Reference

**Last Updated:** 2025-10-15
**Endpoint:** `https://api.butlr.io/api/v3/reporting`
**Method:** POST
**Authentication:** Bearer token (OAuth2 client credentials)

This document provides comprehensive reference for the Butlr v3 Reporting API based on API testing and source code analysis.

---

## Summary of Findings

### Key Discoveries

**1. Traffic Measurement Structure:**
- Returns **TWO data points per time window** (separate "in" and "out" fields)
- Each sensor reports its own in/out counts
- Must aggregate across sensors to get room/floor totals

**2. Timezone Support:**
- API accepts `window.timezone` parameter
- Affects how time windows are aligned (e.g., hourly windows start at local hour boundaries)
- Response includes `timezone_offset` field (e.g., "5h" for IST)

**3. Sensor-Level Granularity:**
- Data returned **per sensor**, not pre-aggregated by room/floor
- Response includes `sensor_id`, `mac_address`, `hive_serial`
- Must sum across sensors for room/floor totals

**4. Multiple Measurement Types:**
- `"traffic"` - Entry/exit counts (in/out fields)
- `"traffic_room_occupancy"` - Calculated occupancy from traffic sensors
- `"traffic_floor_occupancy"` - Floor-level traffic occupancy
- `"room_occupancy"` - Presence-based room occupancy
- `"floor_occupancy"` - Presence-based floor occupancy
- `"zone_occupancy"` - Presence-based zone occupancy

---

## Request Structure

### Basic Request

```json
{
  "filter": {
    "measurements": ["traffic"],
    "rooms": {"eq": ["room_abc123"]},
    "start": "-24h",
    "stop": "now"
  },
  "window": {
    "every": "1h",
    "function": "sum",
    "timezone": "Asia/Kolkata"
  }
}
```

### Filter Fields

**Time Range:**
- `start`: ISO-8601 timestamp OR relative time (e.g., "-24h", "-1h")
- `stop`: ISO-8601 timestamp OR "now" (optional, defaults to now)

**Asset Filters:**
- `rooms`: `{"eq": ["room_id1", "room_id2"]}`
- `spaces`: `{"eq": ["floor_id1"]}` (floors are called "spaces" in v3 API)
- `zones`: `{"eq": ["zone_id1"]}`
- `buildings`: `{"eq": ["building_id1"]}`
- `clients`: `{"eq": ["site_id1"]}` (sites are called "clients")

**Measurements:**
- `measurements`: Array of measurement names (required)
- See "Measurement Types" section below

**Value Filters:**
- `value`: `{"gte": 0, "lte": 100}` - Filter by occupancy value
- `calibrated`: `"true"` or `"false"` - Filter calibrated data

### Window Configuration

**Aggregation Intervals:**
- `every`: "1m", "5m", "15m", "30m", "1h", "6h", "12h", "1d"

**Aggregation Functions:**
- `sum` - Total (good for counting entries/exits)
- `median` - Middle value (good for smoothing noise)
- `mean` - Average
- `max` - Maximum value in window
- `min` - Minimum value
- `first` - First value
- `last` - Last value

**Timezone:**
- `timezone`: IANA timezone string (e.g., "America/Los_Angeles", "Asia/Kolkata")
- Affects how time windows are calculated
- **Important:** Aligns windows to local time boundaries

### Optional Fields

**Group By:**
```json
"group_by": {
  "order": ["time", "room_id"],
  "raw": true
}
```
- Changes response structure (use with caution)
- `raw: true` returns flat array
- `raw: false` returns nested object

**Pagination:**
```json
"paginate": {
  "page": 1,
  "limit": 100
}
```

---

## Response Structure

### Flat Array (Default, No groupBy)

```json
{
  "data": [
    {
      "field": "in",
      "measurement": "traffic",
      "time": "2025-10-15T20:00:00Z",
      "value": 47,
      "room_id": "room_abc123",
      "room_name": "Cafe",
      "sensor_id": "sensor_xyz",
      "mac_address": "00-17-0d-00-00-6e-0e-b6",
      "hive_serial": "12a469c20aeacecb",
      "space_id": "space_def456",
      "space_name": "Floor 15",
      "building_id": "building_ghi789",
      "building_name": "Block 5",
      "timezone_offset": "5h",
      "start": "2025-10-15T19:32:42Z",
      "stop": "2025-10-15T22:32:42Z"
    }
  ]
}
```

### Fields in Response

| Field | Description |
|-------|-------------|
| `field` | For traffic: "in" or "out". For occupancy: measurement name |
| `measurement` | Measurement type queried |
| `time` | Window timestamp (UTC ISO-8601) |
| `value` | Aggregated value for this window |
| `room_id` | Room ID (if room-level) |
| `room_name` | Room name |
| `space_id` | Floor ID |
| `space_name` | Floor name |
| `sensor_id` | Individual sensor ID |
| `mac_address` | Sensor MAC address |
| `hive_serial` | Parent hive serial number |
| `building_id` | Building ID |
| `building_name` | Building name |
| `timezone_offset` | Offset from UTC (e.g., "5h") |
| `start` | Query start time |
| `stop` | Query stop time |

---

## Measurement Types Reference

### 1. Traffic (Entry/Exit Counts)

**Measurement:** `"traffic"`

**Returns:** Separate "in" and "out" data points

**Use Case:** Counting people entering/exiting a space

**Example Response:**
```json
[
  {"time": "2025-10-15T08:00:00Z", "field": "in", "value": 358},
  {"time": "2025-10-15T08:00:00Z", "field": "out", "value": 438}
]
```

**Calculations:**
- Total traffic: `in + out = 796`
- Net flow: `in - out = -80` (net outflow)
- Entries only: `in = 358`
- Exits only: `out = 438`

**Supported Assets:** Rooms with traffic sensors

---

### 2. Traffic Room Occupancy

**Measurement:** `"traffic_room_occupancy"`

**Returns:** Single occupancy value (calculated from traffic sensors)

**Use Case:** Estimated people in room based on entry/exit tracking

**Example Response:**
```json
[
  {"time": "2025-10-15T08:00:00Z", "field": "traffic_room_occupancy", "value": 229}
]
```

**Supported Assets:** Rooms with traffic sensors (is_entrance=false)

---

### 3. Traffic Floor Occupancy

**Measurement:** `"traffic_floor_occupancy"`

**Returns:** Floor-level occupancy from traffic sensors

**Use Case:** Estimated people on floor based on entrance traffic

**Supported Assets:** Floors with traffic sensors (is_entrance=true)

---

### 4. Room Occupancy (Presence)

**Measurement:** `"room_occupancy"`

**Returns:** Direct people count from presence sensors

**Use Case:** Actual occupant count in room

**Supported Assets:** Rooms with presence sensors

---

### 5. Floor Occupancy (Presence)

**Measurement:** `"floor_occupancy"`

**Returns:** Direct people count from presence sensors

**Use Case:** Actual occupant count on floor

**Supported Assets:** Floors with presence sensors

---

### 6. Zone Occupancy (Presence)

**Measurement:** `"zone_occupancy"`

**Returns:** Direct people count in zone

**Use Case:** Desk/area occupancy

**Supported Assets:** Zones with presence sensors

---

## Critical Parsing Notes

### Traffic Measurement Requires Special Handling

**Problem:** Returns 2× data points (in + out per time window)

**Solution:**
```typescript
// Group by time and sensor
const byHourSensor = new Map();
for (const point of response.data) {
  const key = `${point.time}:${point.sensor_id}`;
  if (!byHourSensor.has(key)) {
    byHourSensor.set(key, { in: 0, out: 0 });
  }
  if (point.field === "in") {
    byHourSensor.get(key).in = point.value;
  } else if (point.field === "out") {
    byHourSensor.get(key).out = point.value;
  }
}

// Aggregate across sensors by hour
const byHour = new Map();
for (const [key, counts] of byHourSensor) {
  const hour = key.split(':')[0];
  if (!byHour.has(hour)) {
    byHour.set(hour, { in: 0, out: 0 });
  }
  byHour.get(hour).in += counts.in;
  byHour.get(hour).out += counts.out;
}
```

### Occupancy Measurements Are Simpler

**Already room/floor aggregated:**
```typescript
// Just extract time and value
const timeseries = response.data.map(point => ({
  timestamp: new Date(point.time).toISOString(),
  value: point.value
}));
```

---

## Timezone Behavior

### Window Alignment

**Without timezone parameter:**
```json
"window": {"every": "1h", "function": "sum"}
```
- Windows align to UTC hour boundaries (00:00, 01:00, etc.)
- India data: 9:30 AM IST falls in "04:00 UTC" window

**With timezone parameter:**
```json
"window": {"every": "1h", "function": "sum", "timezone": "Asia/Kolkata"}
```
- Windows align to LOCAL hour boundaries (00:00 IST, 01:00 IST, etc.)
- Preferred for user-facing reports

### "Today" Calculation

**Wrong (current traffic_flow tool):**
```javascript
const start = new Date();
start.setHours(0, 0, 0, 0);  // Midnight UTC
```
- For India: Starts at 5:30 AM IST (misses morning data)

**Correct:**
```javascript
// Calculate midnight in site's timezone
const localMidnight = getLocalMidnight(new Date(), "Asia/Kolkata");
// Returns: "2025-10-15T18:30:00Z" (which is midnight IST)
```

---

## Aggregation Function Selection

| Use Case | Function | Reason |
|----------|----------|--------|
| Entry/exit counts | `sum` | Total movements in window |
| Occupancy smoothing | `median` | Reduces sensor noise |
| Peak detection | `max` | Find maximum occupancy |
| Average occupancy | `mean` | Typical value |

---

## Time Range Validation

**Limits enforced:**
- `1m` interval: ≤ 1 hour range
- `1h` interval: ≤ 48 hours range
- `1d` interval: ≤ 60 days range

**Validation in tools:**
```typescript
validateTimeRange(interval, start, stop);  // Throws error if exceeded
```

---

## Common Query Patterns

### Pattern 1: Room Traffic Today (Timezone-Aware)
```json
{
  "filter": {
    "measurements": ["traffic"],
    "rooms": {"eq": ["room_123"]},
    "start": "2025-10-15T18:30:00Z"  // Midnight IST
  },
  "window": {
    "every": "1h",
    "function": "sum",
    "timezone": "Asia/Kolkata"
  }
}
```

### Pattern 2: Floor Presence Last 6 Hours
```json
{
  "filter": {
    "measurements": ["floor_occupancy"],
    "spaces": {"eq": ["floor_456"]},
    "start": "-6h"
  },
  "window": {
    "every": "1h",
    "function": "median"
  }
}
```

### Pattern 3: Current Occupancy (Last 5 Minutes)
```json
{
  "filter": {
    "measurements": ["room_occupancy"],
    "rooms": {"eq": ["room_123"]},
    "start": "-5m"
  },
  "window": {
    "every": "1m",
    "function": "median"
  }
}
```

---

## Response Parsing Examples

### Example 1: Parse Traffic In/Out
```typescript
interface TrafficCounts {
  hour: string;
  entries: number;
  exits: number;
  total: number;
  net: number;
}

function parseTrafficData(apiResponse: any[]): TrafficCounts[] {
  // Group by time
  const byHour = new Map<string, {in: number, out: number}>();

  for (const point of apiResponse) {
    if (!byHour.has(point.time)) {
      byHour.set(point.time, {in: 0, out: 0});
    }

    const counts = byHour.get(point.time)!;
    if (point.field === "in") {
      counts.in += point.value;
    } else if (point.field === "out") {
      counts.out += point.value;
    }
  }

  return Array.from(byHour.entries()).map(([time, counts]) => ({
    hour: time,
    entries: counts.in,
    exits: counts.out,
    total: counts.in + counts.out,
    net: counts.in - counts.out
  }));
}
```

### Example 2: Parse Occupancy Data
```typescript
function parseOccupancyData(apiResponse: any[]) {
  return apiResponse.map(point => ({
    timestamp: new Date(point.time).toISOString(),
    value: point.value,
    asset_id: point.room_id || point.space_id || point.zone_id
  }));
}
```

---

## Measurement Selection Guide

### For Rooms

**Question: "How many people are in the room?"**
→ Use `room_occupancy` (presence sensors)

**Question: "How many people entered the room today?"**
→ Use `traffic` measurement, sum "in" field

**Question: "What's the traffic flow?"**
→ Use `traffic` measurement, show in/out/net

**Question: "What's the estimated occupancy from traffic?"**
→ Use `traffic_room_occupancy`

### For Floors

**Question: "How many people are on the floor?"**
→ Use `floor_occupancy` (presence sensors)

**Question: "How many people entered the floor?"**
→ Use `traffic` measurement with entrance sensors

**Question: "What's the floor occupancy from traffic?"**
→ Use `traffic_floor_occupancy`

### For Zones

**Only Presence Supported:**
→ Use `zone_occupancy`

---

## Sensor Mode vs Measurement Mapping

**Presence Sensors (mode: "presence"):**
- Contribute to: `room_occupancy`, `floor_occupancy`, `zone_occupancy`
- Do NOT contribute to: `traffic` measurements

**Traffic Sensors (mode: "traffic"):**

**Entrance Sensors (is_entrance: true):**
- Contribute to: `traffic` (floor-level), `traffic_floor_occupancy`
- Used for: Building/floor entry/exit tracking

**Non-Entrance Sensors (is_entrance: false):**
- Contribute to: `traffic` (room-level), `traffic_room_occupancy`
- Used for: Room-to-room movement tracking

---

## Timezone-Aware Queries

### Calculate Local "Today"

**For Asia/Kolkata (UTC+5:30):**
```javascript
// Oct 15, 2025 midnight IST = Oct 14, 2025 18:30 UTC
const now = new Date("2025-10-15T10:00:00Z"); // 3:30 PM IST
const localMidnight = getLocalMidnight(now, "Asia/Kolkata");
// Returns: "2025-10-14T18:30:00Z"
```

**For America/Los_Angeles (UTC-7 PDT):**
```javascript
// Oct 15, 2025 midnight PDT = Oct 15, 2025 07:00 UTC
const now = new Date("2025-10-15T20:00:00Z"); // 1 PM PDT
const localMidnight = getLocalMidnight(now, "America/Los_Angeles");
// Returns: "2025-10-15T07:00:00Z"
```

### Use Timezone in Window

**Recommended for user-facing reports:**
```json
"window": {
  "every": "1h",
  "function": "sum",
  "timezone": "Asia/Kolkata"
}
```

**Result:** Hourly windows align to IST hours (12:00 AM IST, 1:00 AM IST, etc.)

---

## Common Pitfalls

### Pitfall 1: Not Aggregating Sensor Data

**Wrong:**
```typescript
const total = response.data[0].value;  // Only first sensor!
```

**Right:**
```typescript
const total = response.data
  .filter(p => p.field === "in")
  .reduce((sum, p) => sum + p.value, 0);  // Sum across all sensors
```

### Pitfall 2: Mixing In/Out Fields

**Wrong:**
```typescript
const total = response.data.reduce((sum, p) => sum + p.value, 0);
// Adds in+out together incorrectly
```

**Right:**
```typescript
const entries = response.data
  .filter(p => p.field === "in")
  .reduce((sum, p) => sum + p.value, 0);

const exits = response.data
  .filter(p => p.field === "out")
  .reduce((sum, p) => sum + p.value, 0);
```

### Pitfall 3: UTC Midnight for "Today"

**Wrong:**
```typescript
const today = new Date();
today.setHours(0, 0, 0, 0);  // Midnight UTC
```

**Right:**
```typescript
const today = getLocalMidnight(new Date(), siteTimezone);  // Midnight in site timezone
```

---

## Tool Implementation Recommendations

### For Traffic Flow Tool
1. Use `"traffic"` measurement
2. Parse in/out separately
3. Aggregate across sensors
4. Calculate: total traffic, net flow, entries, exits
5. Use timezone-aware "today"
6. Pass timezone to window parameter

### For Occupancy Tools
1. Use `"*_occupancy"` measurements
2. Simple flat array parsing (already aggregated)
3. Use `median` for noise reduction
4. Include timezone metadata
5. Analyze sensor configuration first

---

## Testing Results

**Verified with Salesforce org:**
- ✅ 382 sensors total (339 production, 43 test/placeholder)
- ✅ 191 hives total (187 production, 4 test/fake)
- ✅ Traffic measurement returns in/out per sensor
- ✅ Occupancy measurements return room/floor aggregates
- ✅ Timezone parameter affects windowing
- ✅ Multiple rooms can be queried simultaneously

---

## Source Code References

### Butlr API Container
- Request structure: `pkg/reporting/models/request.go`
- Measurements: `pkg/common/constants/influx.go`
- Window functions: `pkg/reporting/query/`

### MCP Server
- Request builder: `src/clients/reporting-client.ts`
- Traffic flow tool: `src/tools/butlr-traffic-flow.ts`
- Unified occupancy: `src/tools/butlr-get-occupancy-timeseries.ts`
- Timezone helpers: `src/utils/timezone-helpers.ts`

---

## Future Enhancements Needed

1. **Document all available measurements** - Currently only know subset
2. **Calibration point handling** - How to use `includeCalibrationPoints`
3. **Time constraints** - How to use `time_constraints` filter
4. **Tag filtering** - Query by asset tags
5. **Pagination** - Handle large result sets efficiently
