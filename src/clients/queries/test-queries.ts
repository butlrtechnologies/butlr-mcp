import { gql } from "@apollo/client";

/**
 * Test queries for incremental field testing
 * Use these to systematically find problematic fields
 */

// Baseline - we know this works
export const TEST_BASELINE = gql`
  query TestBaseline {
    sites {
      data {
        id
        name
        buildings {
          id
          name
          floors {
            id
            name
            rooms {
              id
              name
            }
            zones {
              id
              name
            }
          }
        }
      }
    }
  }
`;

// Test 1: Add minimal sensor fields
export const TEST_MINIMAL_SENSORS = gql`
  query TestMinimalSensors {
    sites {
      data {
        id
        name
        buildings {
          id
          name
          floors {
            id
            name
            rooms {
              id
              name
            }
            sensors {
              id
              name
              mac_address
            }
          }
        }
      }
    }
  }
`;

// Test 2: Add sensor mode & model
export const TEST_SENSORS_MODE_MODEL = gql`
  query TestSensorsModeModel {
    sites {
      data {
        id
        name
        buildings {
          id
          name
          floors {
            id
            name
            sensors {
              id
              name
              mac_address
              mode
              model
            }
          }
        }
      }
    }
  }
`;

// Test 3: Add sensor location fields
export const TEST_SENSORS_LOCATION = gql`
  query TestSensorsLocation {
    sites {
      data {
        id
        name
        buildings {
          id
          name
          floors {
            id
            name
            sensors {
              id
              name
              mac_address
              mode
              model
              floorID
              roomID
              hiveID
              hive_serial
            }
          }
        }
      }
    }
  }
`;

// Test 4: Add sensor status
export const TEST_SENSORS_STATUS = gql`
  query TestSensorsStatus {
    sites {
      data {
        id
        name
        buildings {
          id
          name
          floors {
            id
            name
            sensors {
              id
              name
              mac_address
              mode
              model
              floorID
              roomID
              hive_serial
              is_online
              is_streaming
              installation_status
            }
          }
        }
      }
    }
  }
`;

// Test 5: Add minimal hives
export const TEST_MINIMAL_HIVES = gql`
  query TestMinimalHives {
    sites {
      data {
        id
        name
        buildings {
          id
          name
          floors {
            id
            name
            hives {
              id
              name
              serialNumber
            }
          }
        }
      }
    }
  }
`;

// Test 6: Add hive status
export const TEST_HIVES_STATUS = gql`
  query TestHivesStatus {
    sites {
      data {
        id
        name
        buildings {
          id
          name
          floors {
            id
            name
            hives {
              id
              name
              serialNumber
              floorID
              roomID
              isOnline
              coordinates
            }
          }
        }
      }
    }
  }
`;

// Test 7: Sensors + Hives together (minimal)
export const TEST_SENSORS_AND_HIVES_MINIMAL = gql`
  query TestSensorsAndHivesMinimal {
    sites {
      data {
        id
        name
        buildings {
          id
          name
          floors {
            id
            name
            rooms {
              id
              name
            }
            zones {
              id
              name
            }
            sensors {
              id
              name
              mac_address
              mode
              model
              roomID
              hive_serial
              is_online
            }
            hives {
              id
              name
              serialNumber
              roomID
              isOnline
            }
          }
        }
      }
    }
  }
`;

// Test 8: Add sensor physical properties
export const TEST_SENSORS_PHYSICAL = gql`
  query TestSensorsPhysical {
    sites {
      data {
        id
        name
        buildings {
          id
          name
          floors {
            id
            name
            sensors {
              id
              name
              mac_address
              mode
              model
              roomID
              hive_serial
              is_online
              height
              center
              orientation
              field_of_view
            }
          }
        }
      }
    }
  }
`;

// Test 9: Add sensor door detection fields
export const TEST_SENSORS_DOOR = gql`
  query TestSensorsDoor {
    sites {
      data {
        id
        name
        buildings {
          id
          name
          floors {
            id
            name
            sensors {
              id
              name
              mac_address
              mode
              model
              roomID
              hive_serial
              is_online
              door_line
              in_direction
              is_entrance
              parallel_to_door
            }
          }
        }
      }
    }
  }
`;

// Test 10: Add sensor timestamps
export const TEST_SENSORS_TIMESTAMPS = gql`
  query TestSensorsTimestamps {
    sites {
      data {
        id
        name
        buildings {
          id
          name
          floors {
            id
            name
            sensors {
              id
              name
              mac_address
              mode
              model
              roomID
              hive_serial
              is_online
              last_heartbeat
              last_raw_message
              last_occupancy_message
            }
          }
        }
      }
    }
  }
`;

// Test 11: Add sensor other fields
export const TEST_SENSORS_OTHER = gql`
  query TestSensorsOther {
    sites {
      data {
        id
        name
        buildings {
          id
          name
          floors {
            id
            name
            sensors {
              id
              name
              mac_address
              mode
              model
              roomID
              hive_serial
              is_online
              sensitivity
              note
              power_type
              sensor_serial
              installation_status
              is_streaming
            }
          }
        }
      }
    }
  }
`;

// Test 12: Add ALL sensor fields together
export const TEST_SENSORS_ALL_FIELDS = gql`
  query TestSensorsAllFields {
    sites {
      data {
        id
        name
        buildings {
          id
          name
          floors {
            id
            name
            sensors {
              id
              name
              mac_address
              mode
              model
              roomID
              hive_serial
              is_online
              is_streaming
              height
              center
              orientation
              field_of_view
              door_line
              in_direction
              is_entrance
              parallel_to_door
              sensitivity
              note
              last_heartbeat
              last_raw_message
              last_occupancy_message
              power_type
              sensor_serial
              installation_status
            }
          }
        }
      }
    }
  }
`;

// Test 13: Add hive extended fields
export const TEST_HIVES_EXTENDED = gql`
  query TestHivesExtended {
    sites {
      data {
        id
        name
        buildings {
          id
          name
          floors {
            id
            name
            hives {
              id
              name
              serialNumber
              floorID
              roomID
              isOnline
              coordinates
              isStreaming
              hiveVersion
              hiveType
            }
          }
        }
      }
    }
  }
`;

// Test 14: Add hive timestamps and other
export const TEST_HIVES_FULL = gql`
  query TestHivesFull {
    sites {
      data {
        id
        name
        buildings {
          id
          name
          floors {
            id
            name
            hives {
              id
              name
              serialNumber
              floorID
              roomID
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
      }
    }
  }
`;

// Test 15: Complete query with all working fields
export const TEST_COMPLETE = gql`
  query TestComplete {
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
              floorID
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
              floorID
              roomID
              customID
              coordinates
            }
            sensors {
              id
              name
              mac_address
              mode
              model
              roomID
              hive_serial
              is_online
              is_streaming
              height
              center
              orientation
              field_of_view
              door_line
              in_direction
              is_entrance
              parallel_to_door
              sensitivity
              note
              last_heartbeat
              last_raw_message
              last_occupancy_message
              power_type
              sensor_serial
              installation_status
            }
            hives {
              id
              name
              serialNumber
              floorID
              roomID
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
      }
    }
  }
`;
