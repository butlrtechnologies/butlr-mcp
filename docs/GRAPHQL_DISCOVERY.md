# GraphQL API Discovery & Reference

**Last Updated:** 2025-10-15
**Source:** `/Users/goverton/Documents/Butlr/Code/butlr-api-container/pkg/graph/schemas/`

This document provides a comprehensive reference for all Butlr GraphQL queries, their supported filters, available fields, and implementation notes discovered from the source code.

---

## Summary of Findings

### Critical Issues Discovered

**🐛 FIELD NAME BUG: camelCase vs snake_case**

The GraphQL schema has duplicate fields with different naming conventions, and the camelCase versions have buggy resolvers:

| Field | camelCase (❌ Buggy) | snake_case (✅ Works) |
|-------|---------------------|---------------------|
| Floor ID | `floorID` | `floor_id` |
| Room ID | `roomID` | `room_id` |
| Hive ID | `hiveID` | `hive_id` (untested) |

**Test Results (Salesforce org: 382 sensors, 191 hives):**
- ❌ `sensors { data { roomID } }` → 294 GraphQL errors (for sensors with NULL room_id)
- ✅ `sensors { data { room_id } }` → **382 sensors** (all work!)
- ❌ `floor.sensors { roomID }` → 0 sensors returned
- ❌ `floor.sensors { room_id }` → Only 5 sensors returned (nested still broken!)
- ✅ `hives { data { room_id } }` → **191 hives**

**Root Cause:**
- `roomID`, `floorID` (camelCase) are **resolver fields** that crash for NULL values
- `room_id`, `floor_id` (snake_case) are **direct DB fields** that handle NULL correctly
- Nested `floor.sensors` field is broken regardless of field names (returns 5 instead of 150+)

**✅ What actually works:**
- ✅ `sensors { data { floor_id room_id } }` → All 382 sensors
- ✅ `hives { data { floor_id room_id } }` → All 191 hives
- ✅ `sensors(ids: [...])` - Direct ID lookup
- ✅ `sensors(mac_addresses: [...])` - MAC address lookup
- ❌ `floor.sensors` - Returns only 5 sensors (broken)
- ❌ Filter parameters (`floor_ids`, `room_ids`) - Not implemented in resolver
- ⚠️ `rooms`, `zones` - Both field formats work (no resolver bug)

---

## Query Reference by Entity Type

### 1. Sites

**Top-level Queries:**
```graphql
# Get all sites
sites: Sites!

# Get specific site
site(id: ID, customID: ID): Site
```

**Filters Supported:**
- `id`: Single site ID
- `customID`: Custom identifier

**Available Fields:**
```graphql
type Site {
  id: ID!
  name: String!
  buildings: [Building!]!          # Nested buildings
  butlrCode: String!                # Internal code (undocumented)
  siteNumber: Int                   # Unique per org
  customID: String                  # Custom ID (undocumented)
  timezone: String
  org_id: String!                   # Organization ID (undocumented)
}
```

**Implementation Notes:**
- Returns all sites for authenticated organization
- `sites` query has no filter parameters
- Nested `buildings` automatically populated

---

### 2. Buildings

**Top-level Queries:**
```graphql
# Get all buildings
buildings: Buildings!

# Get specific building
building(id: ID, customID: ID): Building
```

**Filters Supported:**
- `id`: Single building ID
- `customID`: Custom identifier

**Available Fields:**
```graphql
type Building {
  id: ID!
  name: String!
  capacity: Capacity!                # Aggregated from floors
  floors: [Floor!]!                  # Nested floors
  butlrCode: String!                 # Deprecated, use butlr_code
  butlr_code: String!                # Internal code (undocumented)
  building_number: Int               # Unique per site
  buildingNumber: Int                # Deprecated
  address: Address                   # Postal address
  customID: String                   # Custom ID (undocumented)
  site_id: ID!                       # Parent site (undocumented)
  site: Site!                        # Parent site object
}
```

**Implementation Notes:**
- Returns all buildings for user's organizations
- Capacity calculated from sum of floor capacities unless overridden
- Nested `floors` automatically populated

---

### 3. Floors

**Top-level Queries:**
```graphql
# Get floors by IDs
floors(ids: [String!]): Floors!

# Get floors by tags
floorsByTag(tagIDs: [String!], useOR: Boolean): Floors!

# Get single floor
floor(id: ID, customID: ID): Floor
```

**Filters Supported:**
- `ids`: Array of floor IDs (e.g., `["space_xxx"]`)
- `tagIDs`: Array of tag IDs
- `useOR`: Boolean - Use OR logic for tags (default: AND)
- `id`: Single floor ID
- `customID`: Custom identifier

**Available Fields:**
```graphql
type Floor {
  id: ID!
  building_id: ID!
  building: Building!
  metadata: MetaData!
  name: String!
  timezone: String!
  area: Area!
  capacity: Capacity!
  installation_date: Int!
  installation_status: InstallationStatus!

  # Device relationships (CRITICAL: These work!)
  sensors: [Sensor!]                 # ALL sensors with this floor_id
  hives: [Hive!]                     # ALL hives with this floor_id

  # Battery tracking
  last_battery_change_date: Time
  next_battery_change_date: Time

  # Spatial hierarchy
  floor_plans: [FloorPlan!]
  floorNumber: Int
  tags: [Tag!]
  rooms(ids: [String!]): [Room!]    # Optional filter
  zones(ids: [String!]): [Zone!]    # Optional filter
  fixtures(ids: [String!]): [Fixture!]  # Deprecated

  # Metadata
  butlrCode: String!                 # Internal code (undocumented)
  service_status: ServiceStatus      # Undocumented
  customID: ID                       # Undocumented
  algorithm_config: JSON             # Algo settings
}
```

**Implementation Notes:**
- `floor.sensors` uses `GetSensorsFromFloorID` dataloader (floors.resolvers.go:123-145)
- Query: `WHERE floor_id = ?` (dataloaders/sensor.go:566)
- Returns ALL sensors for floor, regardless of room assignment
- `floor.hives` queries: `WHERE floor_id = ?` (floors.resolvers.go:160)
- Timezone inherited from parent site

---

### 4. Rooms

**Top-level Queries:**
```graphql
# Get rooms by IDs
rooms(ids: [String!]): Rooms!

# Get rooms by tags
roomsByTag(tagIDs: [String!], useOR: Boolean): Rooms!

# Get single room
room(id: ID, customID: ID): Room
```

**Filters Supported:**
- `ids`: Array of room IDs (e.g., `["room_xxx"]`)
- `tagIDs`: Array of tag IDs
- `useOR`: Boolean for tag logic

**Available Fields:**
```graphql
type Room {
  id: ID!
  floorID: ID!                       # Parent floor (undocumented)
  floor: Floor!
  metadata: MetaData!
  name: String!
  area: Area!
  coordinates: [[Float!]]            # Polygon vertices
  capacity: Capacity!
  rotation: Float                    # Degrees clockwise
  tags: [Tag!]
  roomType: String                   # E.g., 'office', 'conference' (undocumented)
  sensors(ids: [String!]): [Sensor!] # Optional filter
  note: String
  customID: ID                       # Undocumented

  # PIR calibration settings
  pir_zero_enable: Boolean!
  pir_zero_threshold: Float          # 0.0-1.0, default 0.05
  pir_zero_window: Int               # Seconds, default 300

  algorithm_config: JSON
}
```

**Implementation Notes:**
- `room.sensors` returns sensors with `room_id = ?`
- PIR settings control zero-occupancy calibration behavior

---

### 5. Zones

**Top-level Queries:**
```graphql
# Get zones by IDs
zones(ids: [String!]): Zones!

# Get zones by tags
zonesByTag(tagIDs: [String!], useOR: Boolean): Zones!

# Get single zone
zone(id: ID, customID: ID): Zone
```

**Filters Supported:**
- `ids`: Array of zone IDs
- `tagIDs`: Array of tag IDs
- `useOR`: Boolean for tag logic

**Available Fields:**
```graphql
type Zone {
  id: ID!
  roomID: ID                         # Optional parent room (undocumented)
  floorID: ID!                       # Required parent floor (undocumented)
  metadata: MetaData!
  name: String!
  area: Area!
  coordinates: [[Float!]]            # Polygon vertices
  rotation: Float                    # Degrees clockwise
  capacity: Capacity!
  sensors: [Sensor!]                 # Sensors in this zone
  note: String
  customID: ID
  tags: [Tag!]
}
```

**Implementation Notes:**
- Zones can belong to rooms OR directly to floors
- `zone.sensors` returns sensors associated with zone

---

### 6. Hives

**Top-level Queries:**
```graphql
# Get hives by IDs or serial numbers
hives(
  ids: [String!]
  serial_numbers: [String!]
  returnPlaceholders: Boolean
): Hives!
```

**Filters Supported:**
- ✅ `ids`: Array of hive IDs (e.g., `["hive_xxx"]`)
- ✅ `serial_numbers`: Array of serial numbers (e.g., `["1000000abc123"]`)
- ✅ `returnPlaceholders`: Include placeholder hives (default: exclude)
- ❌ **No floor/room/building filtering** (must use nested fields)

**Available Fields:**
```graphql
type Hive {
  id: ID!
  floorID: String!                   # Parent floor (undocumented)
  floor: Floor
  roomID: String!                    # Optional parent room (undocumented)
  room: Room
  metadata: MetaData!
  serialNumber: String!              # Unique identifier (undocumented)
  hiveVersion: String!               # Software version (undocumented)
  hiveType: String!                  # Device model (undocumented)

  # Heartbeat/streaming status
  lastHeartbeat: Int                 # Unix timestamp (undocumented)
  lastRawMessage: Int                # Undocumented
  lastCompressedMessage: Int         # Undocumented
  lastOccupancyMessage: Int          # Undocumented
  lastDetectionMessage: Int          # Undocumented
  lastNetworkId: Int                 # Undocumented
  privateIP: String                  # Undocumented
  isStreaming: Boolean!              # Undocumented
  isOnline: Boolean!                 # Undocumented
  netPathStability: Float!           # Undocumented

  # Spatial
  coordinates: [Float!]!
  name: String!
  note: String
  installed: Boolean!

  # Relationships
  sensors(ids: [String!]): [Sensor!] # Sensors on this hive

  # Configuration
  broker: HiveBroker                 # MQTT config
  topics: HiveTopics                 # MQTT topics
  config: HiveConfig
  connectionHealth: ConnectionHealthHive!
  is_sleep_time: Boolean!            # Based on frame rate schedule
}
```

**Implementation Notes:**
- Resolver correctly implements `ids` and `serial_numbers` filters (queries.resolvers.go:215-264)
- Returns hives for user's organizations
- `hive.sensors` returns sensors with `hive_id = ?`
- Placeholder hives excluded by default

---

### 7. Sensors

**Top-level Queries:**
```graphql
# Get sensors with filters
sensors(
  ids: [String!]
  mac_addresses: [String!]
  floor_ids: [String!]              # ❌ NOT IMPLEMENTED
  room_ids: [String!]               # ❌ NOT IMPLEMENTED
  hive_ids: [String!]               # ❌ NOT IMPLEMENTED
  hive_serials: [String!]           # ❌ NOT IMPLEMENTED
): Sensors!
```

**Filters Supported:**
- ✅ `ids`: Array of sensor IDs (e.g., `["sensor_xxx"]`)
- ✅ `mac_addresses`: Array of MAC addresses (e.g., `["00-17-0d-00-00-6d-35-fc"]`)
- ❌ `floor_ids`: **DEFINED IN SCHEMA BUT NOT IMPLEMENTED** (queries.resolvers.go:267)
- ❌ `room_ids`: **NOT IMPLEMENTED**
- ❌ `hive_ids`: **NOT IMPLEMENTED**
- ❌ `hive_serials`: **NOT IMPLEMENTED**

**Available Fields:**
```graphql
type Sensor {
  id: ID!
  client_id: String!                 # Undocumented

  # Spatial hierarchy
  floorID: String!                   # Required (undocumented)
  floor: Floor
  roomID: String!                    # Can be empty string (undocumented)
  room: Room
  hiveID: String!                    # Can be empty string (undocumented)
  hive: Hive
  hive_serial: String!               # Parent hive serial
  zones: [Zone!]                     # Associated zones
  zone_ids: [String!]                # Zone IDs

  # Identity
  sensor_id: ID!                     # Deprecated, use id
  metadata: MetaData!
  name: String!
  mac_address: String!               # Primary identifier
  sensor_serial: String              # Manufacturing serial

  # Configuration
  mode: String!                      # 'traffic' or 'presence'
  model: String!
  sensitivity: Float!
  center: [Float!]!                  # Coverage area center
  height: Float!
  is_entrance: Boolean!
  parallel_to_door: Boolean!
  door_line: Float!
  in_direction: Float!
  orientation: [Float!]!
  field_of_view: Float!
  effective_field_of_view: Float!

  # Status
  is_online: Boolean!
  is_streaming: Boolean!
  last_heartbeat: Int                # Unix timestamp
  last_raw_message: Int
  last_compressed_message: Int
  last_occupancy_message: Int
  last_detection_message: Int
  connection_health: ConnectionHealthSensor!
  is_sleep_time: Boolean!

  # Battery
  power_type: SensorPowerType        # Wired or Battery
  last_battery_change_date: Time
  next_battery_change_date: Time
  battery_change_by_date: Time       # Undocumented
  estimated_total_runtime_days: Int  # Calculated by backend

  # Algorithm
  algo_config: AlgoConfig!
  algorithm_config: JSON
  config: SensorConfig               # Undocumented
  calibration: SensorCalibration!    # Deprecated

  # Other
  note: String
  installation_status: SensorInstallationStatus  # INSTALLED/UNINSTALLED (undocumented)
  pir_zero_enable: Boolean           # Participate in PIR calibration
  active_hours: [Float!]             # Deprecated
  generation: Float!                 # Deprecated
  messages_per_second: Float!        # Deprecated
}
```

**Implementation Notes:**
- **USE NESTED FIELDS to filter by floor/room/hive** - top-level filters don't work
- `floor.sensors` queries `WHERE floor_id = ?` (returns all sensors for floor)
- `room.sensors` queries `WHERE room_id = ?`
- `hive.sensors` queries `WHERE hive_id = ?`
- Sensors can exist without room assignment (roomID can be empty string)
- Wired sensors don't have battery tracking

---

### 8. Webhooks

**Top-level Queries:**
```graphql
# Get all webhooks for your account
webhooks: [Webhook!]
```

**Filters Supported:**
- None - returns all webhooks for authenticated user's organizations

**Available Fields:**
```graphql
type Webhook {
  id: ID!
  name: String!
  event_types: [EventType!]!         # Event subscriptions
  endpoint_config: EndpointConfig!   # URL, auth, timeout
  org_id: String!                    # Undocumented
  status: Boolean!                   # Active/inactive (undocumented)
  filters: JSON                      # Event filters
  send_on_value_change: Boolean!     # Only trigger on changes
}

enum EventType {
  FLOOR_OCCUPANCY
  FLOOR_OCCUPANCY_1MIN
  ROOM_OCCUPANCY
  ROOM_OCCUPANCY_1MIN
  ZONE_OCCUPANCY
  ZONE_OCCUPANCY_1MIN
  DETECTIONS                         # Coordinate updates
  TRAFFIC                            # Entry/exit events
  PIR_MOTION
  PIR_NO_MOTION
  SENSOR_HEALTH
  HIVE_HEALTH
}
```

**Webhook Filters (JSON):**
```json
{
  "floor_ids": ["floor_1", "floor_2"],
  "room_ids": ["room_abc"],
  "zone_ids": ["zone_xyz"],
  "mac_addresses": ["00-17-0d-00-00-6d-35-fc"],
  "occupancy": {
    "comparison": "gt",    // gt, gte, lt, lte, eq, ne
    "value": 10
  }
}
```

**Implementation Notes:**
- Filters use AND logic between types, OR within ID arrays
- Occupancy filters only apply to `*_OCCUPANCY` events
- `send_on_value_change` reduces noise

---

### 9. Tags

**Top-level Queries:**
```graphql
# Get tags by IDs
tags(ids: [String!]): [Tag!]
```

**Filters Supported:**
- `ids`: Array of tag IDs (optional - returns all if omitted)

**Available Fields:**
```graphql
type Tag {
  id: String!
  name: String!
  organization_id: String!
  rooms: [Room!]!                    # Tagged rooms
  zones: [Zone!]!                    # Tagged zones
  floors: [Floor!]!                  # Tagged floors
}
```

**Implementation Notes:**
- Tags can be associated with floors, rooms, and zones
- Useful for grouping spaces by purpose (e.g., "conference rooms")

---

## Recommended Query Patterns

### Pattern 1: Get All Devices for Organization
```graphql
query GetAllDevices {
  sites {
    data {
      buildings {
        floors {
          sensors {
            id
            mac_address
            is_online
            mode
          }
          hives {
            id
            serialNumber
            isOnline
          }
        }
      }
    }
  }
}
```

**Returns:** ALL sensors and hives (verified to work correctly)

---

### Pattern 2: Get Sensors for Specific Floor (RECOMMENDED)
```graphql
query GetFloorSensors($floorId: ID!) {
  floor(id: $floorId) {
    id
    name
    sensors {
      id
      mac_address
      is_online
      mode
      power_type
      battery_change_by_date
    }
  }
}
```

**Why:** Uses dataloader which correctly queries `WHERE floor_id = ?`

---

### Pattern 3: Get Sensors by IDs (Direct Query)
```graphql
query GetSensorsByIds($ids: [String!]) {
  sensors(ids: $ids) {
    data {
      id
      mac_address
      is_online
    }
  }
}
```

**Limitation:** Can only filter by `ids` or `mac_addresses` - other filters don't work

---

### Pattern 4: Get Hives with Sensors
```graphql
query GetHivesWithSensors {
  hives {
    data {
      id
      serialNumber
      isOnline
      sensors {
        id
        mac_address
        mode
      }
    }
  }
}
```

**Returns:** All hives for organization with their associated sensors

---

## Workarounds for Missing Filters

### Problem: Can't filter sensors by floor_ids at top level

**Workaround 1:** Query floors first, then use nested fields
```graphql
query GetSensorsForFloors($floorIds: [String!]) {
  floors(ids: $floorIds) {
    data {
      id
      sensors {
        id
        mac_address
      }
    }
  }
}
```

**Workaround 2:** Query all sensors, filter client-side
```graphql
query GetAllSensors {
  sites {
    data {
      buildings {
        floors {
          id
          sensors {
            id
            floorID  # Use this to filter client-side
          }
        }
      }
    }
  }
}
```

---

## Performance Considerations

### Dataloader Batching
- `floor.sensors`, `floor.hives` use dataloaders (batch queries)
- Multiple floors in single query → efficient batching
- Example: Querying 10 floors → 1 DB query for all sensors

### Recommended for MCP Tools
1. **Use nested fields** whenever possible (dataloaders are efficient)
2. **Avoid top-level `sensors()` with filters** - they don't work
3. **Cache topology queries** - 600s TTL appropriate
4. **Use `sensors(ids: [...])` for specific lookups** - this works

---

## Field Availability Matrix

| Field | Site | Building | Floor | Room | Zone | Hive | Sensor |
|-------|------|----------|-------|------|------|------|--------|
| id | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| name | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| customID | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| capacity | ❌ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| area | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ |
| coordinates | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |
| timezone | ✅ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| sensors | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ | ❌ |
| hives | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| rooms | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| zones | ❌ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ |
| tags | ❌ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ |
| is_online | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| mac_address | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| serialNumber | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ❌ |
| mode | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| power_type | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| battery_* | ❌ | ❌ | ✅* | ❌ | ❌ | ❌ | ✅ |

*Floor has aggregated battery dates (min/max across all sensors)

---

## Source Code References

### GraphQL Schemas
- Sites: `pkg/graph/schemas/sites.graphqls`
- Buildings: `pkg/graph/schemas/buildings.graphqls`
- Floors: `pkg/graph/schemas/floors.graphqls`
- Rooms: `pkg/graph/schemas/rooms.graphqls`
- Zones: `pkg/graph/schemas/zones.graphqls`
- Hives: `pkg/graph/schemas/hives.graphqls`
- Sensors: `pkg/graph/schemas/sensors.graphqls`
- Webhooks: `pkg/graph/schemas/webhooks.graphqls`
- Tags: `pkg/graph/schemas/tags.graphqls`
- Main queries: `pkg/graph/schemas/queries.graphqls`

### Resolvers
- Query resolvers: `pkg/graph/queries.resolvers.go`
- Floor resolvers: `pkg/graph/floors.resolvers.go`
- Sensor resolvers: `pkg/graph/sensors.resolvers.go`
- Hive resolvers: `pkg/graph/hives.resolvers.go`
- Room resolvers: `pkg/graph/rooms.resolvers.go`
- Zone resolvers: `pkg/graph/zones.resolvers.go`

### Data Layer
- Sensors: `pkg/graph/data/sensors.go`
- Hives: `pkg/graph/data/hives.go`
- Dataloaders: `pkg/graph/dataloaders/sensor.go`, `hive.go`

### Key Dataloader Implementations
- `GetSensorsFromFloorID`: Line 561-588 in `dataloaders/sensor.go`
  - Query: `WHERE floor_id IN (?)`
  - Returns ALL sensors for floor(s)
- `GetSensorsFromRoomID`: Line 590-617
  - Query: `WHERE room_id IN (?)`
- `GetSensorsFromHiveID`: Line 619-646
  - Query: `WHERE hive_id IN (?)`

---

## Recommendations for MCP Tools

### ✅ IMPLEMENTED: Use Top-Level Queries with snake_case Fields

**Hardware Snapshot & Topology Tools:**
- ✅ Query `sensors { data { floor_id room_id ... } }` (top-level)
- ✅ Query `hives { data { floor_id room_id ... } }` (top-level)
- ✅ Group by `floor_id` client-side and merge into topology
- ✅ Result: All 382 sensors, 191 hives returned correctly

**Why nested fields don't work:**
- `floor.sensors` only returns 5 sensors (broken resolver)
- `floor.hives` works but inconsistent with sensors approach
- Top-level queries are more reliable

### Field Name Convention

**CRITICAL:** Use snake_case field names in queries:
- ✅ `floor_id`, `room_id`, `hive_id` (works for ALL sensors)
- ❌ `floorID`, `roomID`, `hiveID` (resolver crashes for NULL values)

**Field validator updated:** Now accepts both formats, normalizes to camelCase for GraphQL

### Occupancy Tool Enhancements

**All 4 occupancy tools now include:**
- `assets_queried`: List of assets requested
- `measurement_type`: "traffic" or "presence"
- `note`: Helpful suggestion when no data returned

**Example empty response:**
```json
{
  "timeseries": [],
  "total_points": 0,
  "assets_queried": ["floor_123"],
  "measurement_type": "traffic",
  "note": "No traffic data returned. Try butlr_fetch_presence_occupancy_timeseries..."
}
```

---

## Future API Improvements Needed

1. **Implement missing sensor filters** in queries.resolvers.go
2. **Add floor/room/building filters to hives query**
3. **Add pagination support** for large sensor lists
4. **Document undocumented fields** (40%+ fields are `@spectaql(undocumented)`)
5. **Add `sensors_count` field to Floor type** (avoid full sensor fetch for counts)
