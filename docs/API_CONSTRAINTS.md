# Butlr API Constraints & Workarounds

This document catalogs the limitations and constraints of Butlr's GraphQL and REST APIs that impact MCP tool design, along with the workarounds implemented in the Butlr MCP Server.

---

## GraphQL API Constraints

### 1. No Name-Based Filtering

**Constraint:** GraphQL queries only support ID-based lookups. There is no built-in way to search or filter assets by name.

**Impact:**
- Cannot query `room(name: "Conference Room A")`
- Cannot use wildcards or fuzzy matching
- Must know exact IDs to fetch specific assets

**Workaround:**
```typescript
// ✅ Implemented in search-assets.ts
// 1. Fetch full topology via sites query
// 2. Flatten hierarchy into searchable list
// 3. Implement client-side fuzzy matching
// 4. Cache topology with TTL to reduce repeated fetches
```

**Example:**
```typescript
// User wants to find "conference"
// MCP fetches entire topology, then searches locally:
const results = searchAssets(cachedTopology, "conference", {
  matchFields: ["name"],
  minScore: 70
});
```

**Performance Considerations:**
- Initial topology fetch can be large (100s of assets)
- Must cache aggressively (default TTL: 600s)
- Subsequent searches are instant (in-memory)

---

### 2. No Bulk ID Queries

**Constraint:** Most GraphQL queries accept a single ID, not an array of IDs.

**Available Queries:**
```graphql
site(id: ID!): Site           # ❌ Single ID only
building(id: ID!): Building   # ❌ Single ID only
floor(id: ID!): Floor         # ❌ Single ID only
room(id: ID!): Room           # ❌ Single ID only
zone(id: ID!): Zone           # ❌ Single ID only

# Only sensors/hives support arrays:
sensors(ids: [ID!]): [Sensor]  # ✅ Bulk query supported
hives(ids: [ID!]): [Hive]      # ✅ Bulk query supported
```

**Impact:**
- Fetching 10 rooms requires 10 separate GraphQL queries
- Can't efficiently fetch arbitrary asset collections
- High latency for multi-asset queries

**Workaround:**
```typescript
// ✅ Implemented in get-asset-details.ts
// 1. Group IDs by asset type
// 2. Execute queries sequentially (or with controlled concurrency)
// 3. Handle partial failures gracefully
```

**Example:**
```typescript
// Fetch multiple assets of different types
const ids = ["room_123", "floor_456", "building_789"];

// Group by type
const groups = {
  room: ["room_123"],
  floor: ["floor_456"],
  building: ["building_789"]
};

// Execute separate queries per type
for (const [type, typeIds] of Object.entries(groups)) {
  for (const id of typeIds) {
    await apolloClient.query({ query: getQueryForType(type), variables: { id } });
  }
}
```

**Mitigation:**
- Implement request batching with configurable concurrency (`MCP_CONCURRENCY`)
- Set reasonable limits on bulk operations (`MCP_MAX_IDS`)
- Consider parallel execution where appropriate

---

### 3. No Pagination on Nested Hierarchy

**Constraint:** When fetching nested relationships (e.g., `site { buildings { floors } }`), all nested entities are returned at once. No cursor or pagination support.

**Impact:**
- Large sites with many buildings/floors return massive payloads
- Cannot limit depth or breadth of traversal
- May hit memory limits on very large organizations

**Example Problem:**
```graphql
query GetSite {
  site(id: "site_123") {
    buildings {        # Returns ALL buildings
      floors {         # Returns ALL floors for each building
        rooms {        # Returns ALL rooms for each floor
          zones {      # Returns ALL zones for each room
            sensors  # Returns ALL sensors for each zone
          }
        }
      }
    }
  }
}
# This could return 10,000+ entities!
```

**Workaround:**
```typescript
// ✅ Implement depth control in get_asset_topology
// Allow users to specify max_depth
{
  max_depth: 3  // Only traverse: site → building → floor (stop before rooms)
}

// Conditionally build GraphQL query based on depth
const query = gql`
  query GetTopology($includeRooms: Boolean!) {
    sites {
      buildings {
        floors {
          rooms @include(if: $includeRooms) {
            zones
          }
        }
      }
    }
  }
`;
```

**Best Practices:**
- Default to shallow queries (depth=2 or 3)
- Document payload size expectations
- Warn users when requesting deep hierarchies
- Implement client-side pagination/chunking for large result sets

---

### 4. Separate Tag-Based Queries

**Constraint:** Tag filtering requires separate, specialized queries. No unified tag search across asset types.

**Available Tag Queries:**
```graphql
floorsByTag(tags: [String!]!): [Floor]
roomsByTag(tags: [String!]!): [Room]
zonesByTag(tags: [String!]!): [Zone]

# ❌ No generic: assetsByTag(tags: [String!]!): [Asset]
```

**Impact:**
- Must know asset type before querying by tag
- Cannot search "all conference rooms" without knowing they're rooms vs zones
- Requires multiple queries to search across types

**Workaround:**
```typescript
// ✅ Implement in get_occupancy_by_tag
// 1. Require user to specify asset_type
// 2. Use appropriate tag query
// 3. For multi-type search, execute multiple queries and merge results
```

**Example:**
```typescript
// User wants occupancy for all "conference" tagged spaces
// Option 1: Require asset type
{
  tags: ["conference"],
  asset_type: "room"  // Must specify
}

// Option 2: Search all types (future enhancement)
const rooms = await apolloClient.query({ query: roomsByTag, variables: { tags: ["conference"] } });
const zones = await apolloClient.query({ query: zonesByTag, variables: { tags: ["conference"] } });
const allAssets = [...rooms, ...zones];
```

---

### 5. Limited Sensor Query Filters

**Constraint:** Sensor queries support specific filters but not arbitrary combinations.

**Supported Filters:**
```graphql
sensors(
  ids: [ID!]
  mac_addresses: [String!]
  floorIDs: [ID!]
  roomIDs: [ID!]
  hiveIDs: [ID!]
): [Sensor]
```

**Not Supported:**
- ❌ Filter by sensor mode (presence vs traffic)
- ❌ Filter by online/offline status
- ❌ Filter by model
- ❌ Complex boolean logic (AND/OR combinations)

**Workaround:**
```typescript
// Fetch all sensors in scope, then filter client-side
const sensors = await fetchSensorsForFloor(floorID);
const onlineSensors = sensors.filter(s => s.is_online);
const presenceSensors = sensors.filter(s => s.mode === "presence");
```

---

### 6. No Cursor-Based Pagination

**Constraint:** GraphQL queries don't return pagination cursors. Must fetch all results or implement custom pagination logic.

**Impact:**
- Cannot stream large result sets
- Must load entire response into memory
- No standard "next page" token

**Mitigation:**
- Cache aggressively
- Limit query scope (by site, building, floor)
- Warn users about large queries

---

## REST API (Reporting) Constraints

### API Versions Overview

**From Production Deployment** (`butlr-api-container/cmd/reporting/main.go:115-117`):

| Endpoint | Access | Purpose | Use in MCP |
|----------|--------|---------|------------|
| `POST /v3/reporting` | ✅ All users | Full-featured occupancy queries | ✅ Primary endpoint |
| `POST /v4/reporting` | ⚠️ Dashboard only | Simplified API (restricted access) | ❌ Don't use |
| `POST /v4/reporting/stats` | ✅ All users | Pre-computed statistics (min/max/mean/etc.) | ✅ For aggregates |

**Dashboard Usage** (`butlr-dashboard/src/hooks/api/reporting.ts:12-13`):
```typescript
const REPORTING_URL = '/api/v3/reporting';  // Primary
const STATS_URL = '/api/v4/reporting/stats'; // Stats only
```

**Decision:** Use **v3/reporting** for timeseries, **v4/stats** for aggregates.

---

### 1. Complex Request Structure (v3/reporting)

**Constraint:** v3 Reporting API requires deeply nested request objects with specific structure.

**Required Structure:**
```json
{
  "group_by": {
    "order": ["room_id"],
    "raw": true
  },
  "window": {
    "every": "1h",
    "function": "mean",
    "timezone": "America/Los_Angeles"
  },
  "filter": {
    "measurements": ["room_occupancy"],
    "start": "2024-01-01T00:00:00Z",
    "stop": "2024-01-07T23:59:59Z",
    "rooms": { "eq": ["room_123"] }
  },
  "options": {
    "format": "json",
    "timestamp": "RFC3339",
    "precision": "s"
  }
}
```

**Impact:**
- Verbose requests (100+ lines for complex queries)
- Easy to construct invalid requests
- Multiple levels of nesting

**Workaround:**
```typescript
// ✅ Create request builder utilities
class ReportingRequestBuilder {
  buildOccupancyRequest(params: OccupancyParams): ReportingRequest {
    return {
      filter: {
        measurements: ["occupancy"],
        start: params.start,
        stop: params.stop,
        [this.getScopeKey(params.assetType)]: { eq: params.assetIds }
      },
      window: {
        every: params.interval || "1h",
        function: params.aggregationFunction || "mean",
        timezone: params.timezone || "UTC"
      },
      options: {
        format: "json",
        timestamp: "RFC3339",
        precision: "s"
      }
    };
  }
}
```

---

### 2. Field Name Corrections (IMPORTANT!)

**From Dashboard Code Analysis** (`butlr-dashboard/src/hooks/api/reporting.ts`):

❌ **Incorrect (Initial Documentation):**
```json
{
  "filter": {
    "start": "...",
    "end": "..."  // ❌ WRONG - API doesn't use "end"
  }
}
```

✅ **Correct (Actual API):**
```json
{
  "filter": {
    "start": "2024-01-01T00:00:00Z",
    "stop": "2024-01-07T23:59:59Z"  // ✅ Use "stop", not "end"
  }
}
```

**Measurement Name Corrections:**

| Asset Type | Correct Measurement | ❌ Incorrect |
|------------|---------------------|--------------|
| Room | `room_occupancy` | ~~`occupancy`~~ |
| Zone | `zone_occupancy` | ~~`occupancy`~~ |
| Floor | `floor_occupancy` | ~~`occupancy`~~ |
| Traffic | `traffic` | ✅ Correct |

**Example from Dashboard:**
```typescript
// Real dashboard query
{
  filter: {
    measurements: ['room_occupancy', 'traffic'],  // Specific names
    rooms: { eq: [id] }
  }
}
```

---

###  3. Inconsistent Filter Field Names

**Constraint:** Different asset types use different field names in `filter` object.

**Complete Mapping:**
```typescript
const FILTER_FIELD_MAP = {
  site: "clients",        // ❌ Not "sites"
  building: "buildings",  // ✅ Consistent
  floor: "spaces",        // ❌ Not "floors"
  room: "rooms",          // ✅ Consistent
  zone: "zones",          // ✅ Consistent
  sensor: "sensors",      // ✅ Consistent
  hive: "hives"           // ✅ Consistent
};
```

**Measurement Mapping:**
```typescript
const MEASUREMENT_MAP = {
  room: "room_occupancy",
  zone: "zone_occupancy",
  floor: "floor_occupancy"
};
```

**Example:**
```typescript
// Query floor occupancy
{
  filter: {
    measurements: ["floor_occupancy"],  // ← Measurement name
    spaces: { eq: ["floor_123"] }       // ← Filter field
  }
}

// Query room occupancy
{
  filter: {
    measurements: ["room_occupancy"],   // ← Different measurement
    rooms: { eq: ["room_456"] }         // ← Different filter field
  }
}
```

**Workaround:**
```typescript
// ✅ Implement dual mapper
function getFilterConfig(assetType: string) {
  const filterFieldMap = { floor: "spaces", site: "clients" };
  const measurementMap = {
    room: "room_occupancy",
    zone: "zone_occupancy",
    floor: "floor_occupancy"
  };

  return {
    filterField: filterFieldMap[assetType] || `${assetType}s`,
    measurement: measurementMap[assetType]
  };
}
```

---

### 4. Relative Time Support ✅

**Feature:** v3 API supports relative time strings (very useful!)

**Supported Formats:**
```typescript
"-20m"  // Last 20 minutes
"-1h"   // Last hour
"-24h"  // Last 24 hours
"-7d"   // Last 7 days
"-1w"   // Last week
"-1M"   // Last month
"now"   // Current time
```

**Dashboard Example** (`reporting.ts:155`):
```typescript
{
  filter: {
    start: "-24h",  // Relative time!
    measurements: ["room_occupancy"],
    rooms: { eq: [id] }
  }
}
```

**Benefits:**
- No timezone math needed for "last 24 hours"
- Simpler queries for recent data
- Automatically adjusts to current time

**Workaround:**
```typescript
// Support both ISO-8601 and relative formats
function normalizeTimestamp(input: string): string {
  // If already relative format, pass through
  if (input.match(/^-\d+[mhdwM]$/) || input === "now") {
    return input;
  }
  // Otherwise convert to ISO-8601
  return new Date(input).toISOString();
}
```

---

### 5. Time Format Requirements

**Constraint:** When using absolute timestamps, must use RFC3339 format.

**Requirements:**
- **Start/Stop:** RFC3339 format (`2024-01-01T00:00:00Z`) OR relative (`"-24h"`)
- **Timezone:** Separate field in `window` object (not embedded in timestamps)
- **Precision:** Specified in `options.precision` (`s`, `ms`, `us`, `ns`)

**Example:**
```json
{
  "filter": {
    "start": "2024-01-01T00:00:00Z",  // Absolute (UTC)
    "stop": "now"                      // Or relative
  },
  "window": {
    "timezone": "America/Los_Angeles"  // Separate timezone field
  }
}
```

**Workaround:**
```typescript
// ✅ Support both formats
function buildTimeFilter(start: string, stop?: string, timezone?: string) {
  return {
    start: normalizeTimestamp(start),
    stop: stop ? normalizeTimestamp(stop) : "now",
    timezone: timezone || "UTC"
  };
}
```

---

### 6. Window Aggregation Constraints (v3/reporting)

**Constraint:** Window intervals must align with specific values and functions.

**Supported Intervals:**
- `1m`, `5m`, `15m`, `30m`
- `1h`, `6h`, `12h`
- `1d`, `1w`

**Supported Functions:**
- `mean`, `max`, `min`, `sum`
- `first`, `last`
- `median` (limited support)

**Not Supported by v3:**
- ❌ Custom intervals (e.g., `45m`, `2h`)
- ❌ Percentiles (p50, p95, p99)
- ❌ Standard deviation (use v4/stats instead)
- ❌ Count distinct

**Note:** For advanced statistics (stdev, median), use **v4/stats** endpoint instead

**Workaround:**
```typescript
// Validate intervals
const VALID_INTERVALS = ["5m", "15m", "30m", "1h", "6h", "12h", "1d", "1w"];
if (!VALID_INTERVALS.includes(interval)) {
  throw new ValidationError(`Invalid interval: ${interval}. Must be one of: ${VALID_INTERVALS.join(", ")}`);
}

// Calculate advanced statistics client-side
function calculatePercentile(values: number[], p: number): number {
  // Client-side implementation
}
```

---

### 5. Fill Strategy Limitations

**Constraint:** Limited options for handling missing data points.

**Supported Fill Methods:**
```json
{
  "window": {
    "fill": {
      "use_previous": true   // Option 1: Use previous value
    }
  }
}

{
  "window": {
    "fill": {
      "value": 0            // Option 2: Use fixed value
    }
  }
}
```

**Not Supported:**
- ❌ Linear interpolation
- ❌ Polynomial interpolation
- ❌ Forward fill with limits
- ❌ Null/None (gaps in response)

**Workaround:**
```typescript
// Set create_empty: false to omit missing points
{
  window: {
    create_empty: false  // Don't generate empty buckets
  }
}

// Or implement custom interpolation client-side
```

---

### 7. Pagination Structure (v3/reporting)

**Constraint:** REST API uses page/limit pagination (not cursor-based like GraphQL conventions).

**Structure:**
```json
{
  "paginate": {
    "page": 1,     // 1-indexed
    "limit": 100   // Max per page
  }
}
```

**Limitations:**
- Maximum `limit` varies by endpoint (typically 100-1000)
- No total count returned
- No cursor for efficient large result sets
- No "has more" indicator

**Workaround:**
```typescript
// Implement pagination helper
async function* paginateResults(request: ReportingRequest, maxPages = 10) {
  for (let page = 1; page <= maxPages; page++) {
    const response = await fetchPage({ ...request, paginate: { page, limit: 100 } });
    yield response.data;

    if (response.data.length < 100) break;  // Last page
  }
}
```

---

### 8. v4/stats API - Simplified Statistics Endpoint

**Feature:** v4/stats provides pre-computed statistics without full timeseries.

**Endpoint:** `POST /v4/reporting/stats`

**Request Structure** (from `pkg/reporting/query/reportingv4/handler.go`):
```json
{
  "measurements": ["room_occupancy"],
  "items": ["room_123", "room_456"],  // Or [{"id": "room_123", "filter": [...]}]
  "start": "-7d",                     // ISO-8601 or relative
  "stop": "now"                       // Optional, defaults to now
}
```

**Response Structure:**
```json
{
  "data": {
    "room_123": {
      "count": 1008,        // Number of data points
      "first": 0,           // First value in period
      "last": 3,            // Last value in period
      "max": 18,            // Maximum occupancy
      "mean": 4.5,          // Average occupancy
      "median": 3,          // Median occupancy
      "min": 0,             // Minimum occupancy
      "stdev": 3.2,         // Standard deviation
      "sum": 4536           // Sum of all values
    },
    "room_456": { /* ... */ }
  }
}
```

**Benefits:**
- ✅ Much faster than fetching full timeseries
- ✅ Includes stdev and median (not in v3)
- ✅ Perfect for ranking, trends, insights
- ✅ Lower bandwidth usage

**Use Cases:**
- `butlr_top_used_spaces` - Rank by mean occupancy
- `butlr_usage_trend` - Compare stats between periods
- `butlr_space_insights` - Detect anomalies via stdev

**Limitations:**
- ❌ No timeseries data (only aggregates)
- ❌ Cannot specify interval (analyzes entire period)
- ❌ No percentiles (p95, p99)

---

### 9. Time Constraints Complexity

**Constraint:** Time constraints use complex nested structure.

**Structure:**
```json
{
  "filter": {
    "time_constraints": {
      "time_ranges": [
        { "start": "09:00", "stop": "17:00" }  // Business hours only
      ],
      "exclude_days_of_week": ["saturday", "sunday"]  // Weekdays only
    }
  }
}
```

**Limitations:**
- ❌ Cannot specify date ranges within time constraints (only time-of-day)
- ❌ Cannot specify "nth weekday of month" (e.g., "first Monday")
- ❌ Cannot specify holidays or custom calendars

**Workaround:**
```typescript
// Implement calendar-aware filtering client-side
// Or break query into multiple date ranges
```

---

### 10. Calibration Points (v3/reporting)

**Constraint:** Calibration points (for drift correction) have specific requirements.

**Structure:**
```json
{
  "filter": {
    "calibrated": "yes"  // or "no" or omit
  },
  "calibration_points": [
    {
      "timestamp": "2024-01-15T14:30:00Z",
      "occupancy": 25,
      "type": "user_provided"
    }
  ]
}
```

**Requirements:**
- Timestamps must be within query time range
- Occupancy must be non-negative integer
- Type must be `user_provided` or `pir_zero`
- Maximum number of points per query (undocumented limit)

**Best Practice:**
```typescript
// Validate calibration points before submitting
function validateCalibrationPoints(points: CalibrationPoint[], start: string, stop: string) {
  for (const point of points) {
    if (point.timestamp < start || point.timestamp > stop) {
      throw new ValidationError("Calibration point timestamp outside query range");
    }
    if (point.occupancy < 0) {
      throw new ValidationError("Occupancy must be non-negative");
    }
  }
}
```

---

## Rate Limiting & Performance

### 1. No Published Rate Limits

**Constraint:** API documentation doesn't specify rate limits.

**Observed Behavior:**
- GraphQL: ~100 requests/minute (estimated)
- REST: ~50 requests/minute (estimated)
- May vary by endpoint and customer tier

**Mitigation:**
```typescript
// Implement client-side rate limiting
import pLimit from 'p-limit';

const limit = pLimit(parseInt(process.env.MCP_CONCURRENCY || '5'));

// Wrap all API calls
await limit(() => apolloClient.query(...));
```

### 2. Large Payload Performance

**Constraint:** Very large queries (1000s of data points) can timeout or return partial results.

**Mitigation:**
- Break large time ranges into smaller chunks
- Query floors/rooms individually instead of in bulk
- Implement request splitting logic

```typescript
// Split large time range
function splitTimeRange(start: Date, stop: Date, maxDays = 30): TimeRange[] {
  // Split into 30-day chunks
}
```

---

## Caching Strategy

To work around API limitations, aggressive caching is required:

```typescript
// Cache topology (updates infrequently)
const topologyCache = new LRUCache({
  max: 100,
  ttl: parseInt(process.env.MCP_CACHE_TOPO_TTL || '600') * 1000  // 10 minutes
});

// Cache tag-to-asset mappings
const tagMappingCache = new LRUCache({
  max: 500,
  ttl: 300 * 1000  // 5 minutes
});

// Short-lived memoization for repeated occupancy queries
const occupancyCache = new LRUCache({
  max: 50,
  ttl: 60 * 1000  // 1 minute
});
```

---

## Error Handling

### Common Error Responses

**GraphQL Errors:**
```json
{
  "errors": [
    {
      "message": "Asset not found",
      "extensions": {
        "code": "NOT_FOUND"
      }
    }
  ]
}
```

**REST Errors:**
```json
{
  "error": "Invalid time range",
  "code": 400,
  "details": "Start time must be before stop time"
}
```

**Translation to MCP Errors:**
```typescript
function translateError(error: any): MCPError {
  if (error.extensions?.code === "UNAUTHENTICATED") {
    return { code: "AUTH_EXPIRED", message: "Token expired or invalid" };
  }
  if (error.statusCode === 429) {
    return { code: "RATE_LIMITED", message: "Too many requests" };
  }
  // ... more mappings
}
```

---

## Best Practices

### 1. Input Validation

Always validate inputs before making API calls:

```typescript
// Validate ID format
if (!id.match(/^(site|building|floor|room|zone)_\d+$/)) {
  throw new ValidationError("Invalid ID format");
}

// Validate time range
if (start >= stop) {
  throw new ValidationError("Start time must be before stop time");
}

// Respect configured limits
if (ids.length > parseInt(process.env.MCP_MAX_IDS || '100')) {
  throw new ValidationError(`Too many IDs (max: ${process.env.MCP_MAX_IDS})`);
}
```

### 2. Graceful Degradation

Handle partial failures gracefully:

```typescript
// Continue processing other assets if one fails
const results = [];
for (const id of ids) {
  try {
    const data = await fetchAsset(id);
    results.push(data);
  } catch (error) {
    results.push({ id, error: error.message });
  }
}
```

### 3. Response Normalization

Always normalize API responses to consistent shapes:

```typescript
// Standardize timestamp format
function normalizeTimestamp(ts: any): string {
  return new Date(ts).toISOString();  // Always ISO-8601
}

// Standardize field names
function normalizeAsset(asset: any): NormalizedAsset {
  return {
    id: asset.id,
    name: asset.name || asset.label || "Unnamed",  // Handle variations
    type: detectAssetType(asset.id),
    // ... more normalization
  };
}
```

---

## Future API Improvements (Wishlist)

These constraints could be addressed in future API versions:

1. **GraphQL:**
   - Add name-based filtering to all queries
   - Support bulk ID arrays for all asset types
   - Implement cursor-based pagination
   - Add unified `searchAssets` query with filters

2. **REST:**
   - Simplify request structure (flatten nesting)
   - Add cursor-based pagination
   - Support custom aggregation intervals
   - Add percentile calculations
   - Return pagination metadata (total count, has more)

3. **General:**
   - Publish rate limits in documentation
   - Provide request cost estimates
   - Add GraphQL query cost analysis
   - Implement GraphQL subscriptions for real-time data

---

## Related Documentation

- See `MCP_TOOLS_DESIGN.md` for tool specifications that work within these constraints
- See `VISION.md` for high-level architecture and design principles
- See `USER_STORIES.md` for requirements that drive workaround decisions
