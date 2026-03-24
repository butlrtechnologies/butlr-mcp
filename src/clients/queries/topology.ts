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
 * NOTE: Does NOT include sensors/hives in nested fields (broken - only returns 5 sensors)
 * Use GET_ALL_SENSORS and GET_ALL_HIVES separately, then merge by floor_id/room_id
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
