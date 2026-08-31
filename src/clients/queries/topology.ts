import { gql } from "@apollo/client";

/**
 * GraphQL queries for topology retrieval
 */

/**
 * Minimal sites list - fast loading, no nested data
 */
export const GET_SITES_LIST = gql`
  query GetSitesList {
    sites {
      data {
        id
        name
        timezone
        siteNumber
        customID
      }
    }
  }
`;

/**
 * Single site structure without sensors/hives
 * Good for quick hierarchy lookup
 */
export const GET_SITE_STRUCTURE = gql`
  query GetSiteStructure($siteId: ID!) {
    site(id: $siteId) {
      id
      name
      timezone
      siteNumber
      customID
      buildings {
        id
        name
        building_number
        capacity {
          max
          mid
        }
        address {
          lines
          country
        }
        floors {
          id
          name
          floorNumber
          timezone
        }
      }
    }
  }
`;

/**
 * Full topology with all sites, buildings, floors, rooms, zones
 * Zones include a nested `sensors` selection — the only way to attribute sensors
 * to zones, since GET_ALL_SENSORS selects no zone linkage. Verified live against
 * the API: nested sensor selections are NOT truncated (an earlier note here
 * claimed nested fields returned only 5 sensors; that does not reproduce — zone
 * and floor nested counts match the flat sensors list exactly, and introspection
 * shows no pagination args on the nested `sensors` field).
 * Still use GET_ALL_SENSORS and GET_ALL_HIVES for full device detail (model,
 * battery, heartbeat, ...), merged by floor_id/room_id.
 */
export const GET_FULL_TOPOLOGY = gql`
  query GetFullTopology {
    sites {
      data {
        id
        name
        timezone
        siteNumber
        customID
        org_id
        buildings {
          id
          name
          building_number
          site_id
          customID
          capacity {
            max
            mid
          }
          address {
            lines
            country
          }
          floors {
            id
            name
            floorNumber
            building_id
            timezone
            installation_date
            customID
            capacity {
              max
              mid
            }
            area {
              value
              unit
            }
            rooms {
              id
              name
              floor_id
              roomType
              customID
              capacity {
                max
                mid
              }
              coordinates
            }
            zones {
              id
              name
              floor_id
              room_id
              customID
              coordinates
              sensors {
                id
                name
                mac_address
                mode
                floor_id
                room_id
                hive_serial
                is_entrance
                is_online
              }
            }
          }
        }
      }
    }
  }
`;

/**
 * Get all sensors for the organization
 * Uses snake_case fields (floor_id, room_id) which work correctly
 * CamelCase fields (floorID, roomID) have buggy resolvers that fail for NULL values
 */
export const GET_ALL_SENSORS = gql`
  query GetAllSensors {
    sensors {
      data {
        id
        name
        mac_address
        mode
        model
        floor_id
        room_id
        hive_serial
        is_entrance
        is_online
        is_streaming
        power_type
        last_battery_change_date
        next_battery_change_date
        battery_change_by_date
        last_heartbeat
        installation_status
      }
    }
  }
`;

/**
 * Get specific sensors by ID (batch).
 *
 * The `sensors` root field accepts an `ids` argument, so a caller that needs
 * one known sensor does not have to download the org's whole inventory and
 * `.find()` in it. Selects only what an ID-addressed lookup needs: identity,
 * mode, parent linkage, and liveness (is_online + last_heartbeat, which the
 * offline-warning gate compares against the query window). Use GET_ALL_SENSORS when the
 * caller genuinely needs the full list (e.g. aggregating a room's sensors).
 *
 * Uses snake_case fields (floor_id, room_id) for the same reason as
 * GET_ALL_SENSORS: the camelCase resolvers are buggy for NULL values.
 */
export const GET_SENSORS_BY_IDS = gql`
  query GetSensorsByIds($ids: [String!]) {
    sensors(ids: $ids) {
      data {
        id
        name
        mac_address
        mode
        floor_id
        room_id
        hive_serial
        is_entrance
        is_online
        last_heartbeat
      }
    }
  }
`;

export const GET_SENSORS_BY_ROOM_IDS = gql`
  query GetSensorsByRoomIds($roomIds: [String!]) {
    sensors(room_ids: $roomIds) {
      data {
        id
        name
        mac_address
        mode
        floor_id
        room_id
        hive_serial
        is_entrance
        is_online
        last_heartbeat
      }
    }
  }
`;

/**
 * Get all hives for the organization
 * Uses snake_case fields (floor_id, room_id) for consistency
 */
export const GET_ALL_HIVES = gql`
  query GetAllHives {
    hives {
      data {
        id
        name
        serialNumber
        floor_id
        room_id
        isOnline
        coordinates
        isStreaming
        hiveVersion
        hiveType
        note
        lastHeartbeat
        netPathStability
        installed
      }
    }
  }
`;

/**
 * Lightweight topology without devices
 * Faster when sensor/hive data isn't needed
 */
export const GET_TOPOLOGY_NO_DEVICES = gql`
  query GetTopologyNoDevices {
    sites {
      data {
        id
        name
        timezone
        siteNumber
        customID
        org_id
        buildings {
          id
          name
          building_number
          site_id
          customID
          capacity {
            max
            mid
          }
          address {
            lines
            country
          }
          floors {
            id
            name
            floorNumber
            building_id
            timezone
            installation_date
            customID
            capacity {
              max
              mid
            }
            area {
              value
              unit
            }
            rooms {
              id
              name
              floor_id
              customID
              capacity {
                max
                mid
              }
              coordinates
            }
            zones {
              id
              name
              floor_id
              room_id
              customID
              coordinates
            }
          }
        }
      }
    }
  }
`;
