#!/usr/bin/env tsx

/**
 * Fixture Generation Script
 *
 * Captures real API responses from Butlr APIs and saves them as test fixtures.
 * Run this manually when API schemas change or when adding new integration tests.
 *
 * Usage:
 *   npx tsx scripts/snapshot-api-responses.ts
 *
 * Requirements:
 *   - Valid BUTLR_CLIENT_ID and BUTLR_CLIENT_SECRET in .env
 *   - Access to Butlr organization with test data
 *
 * Output:
 *   - src/__fixtures__/graphql/*.json (GraphQL query responses)
 *   - src/__fixtures__/reporting/*.json (v3 Reporting API responses)
 *   - src/__fixtures__/stats/*.json (v4 Stats API responses)
 */

import { writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { apolloClient } from "../src/clients/graphql-client.js";
import { gql } from "@apollo/client";
import {
  queryReporting,
  ReportingRequestBuilder,
  getCurrentOccupancy,
} from "../src/clients/reporting-client.js";
import { queryStats, StatsRequestBuilder } from "../src/clients/stats-client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURES_DIR = join(__dirname, "../src/__fixtures__");

/**
 * Sanitize sensitive data from responses
 */
function sanitizeData(data: any): any {
  if (!data) return data;

  const sanitized = JSON.parse(JSON.stringify(data));

  // Helper to recursively sanitize
  function sanitizeRecursive(obj: any): any {
    if (Array.isArray(obj)) {
      return obj.map(sanitizeRecursive);
    }

    if (typeof obj === "object" && obj !== null) {
      // Sanitize organization/site names
      if (obj.name && typeof obj.name === "string") {
        if (obj.id && obj.id.startsWith("site_")) {
          obj.name = `Test Site ${obj.id.slice(-3)}`;
        }
      }

      // Sanitize MAC addresses (keep format but anonymize)
      if (obj.mac_address && typeof obj.mac_address === "string") {
        const parts = obj.mac_address.split(":");
        if (parts.length === 6) {
          obj.mac_address = parts.map((_, i) => (i === 0 ? "AA" : `${i}${i}`)).join(":");
        }
      }

      // Sanitize serial numbers
      if (obj.serialNumber && typeof obj.serialNumber === "string") {
        obj.serialNumber = `TEST-${obj.id?.slice(-8) || "12345678"}`;
      }

      // Recursively sanitize nested objects
      for (const key in obj) {
        obj[key] = sanitizeRecursive(obj[key]);
      }
    }

    return obj;
  }

  return sanitizeRecursive(sanitized);
}

/**
 * Save fixture to file
 */
function saveFixture(category: string, filename: string, data: any) {
  const dir = join(FIXTURES_DIR, category);
  const filepath = join(dir, filename);

  const sanitized = sanitizeData(data);

  writeFileSync(filepath, JSON.stringify(sanitized, null, 2));
  console.log(`✓ Saved: ${category}/${filename}`);
}

/**
 * Main execution
 */
async function main() {
  console.log("Starting API response snapshot...\n");

  try {
    // 1. GraphQL Fixtures
    console.log("📊 Capturing GraphQL responses...");

    // Full topology (org-wide device health)
    const fullTopology = await apolloClient.query({
      query: gql`
        query GetDeviceHealth {
          sites {
            data {
              id
              name
              buildings {
                id
                name
                site_id
                floors {
                  id
                  name
                  building_id
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
                  }
                  sensors {
                    id
                    name
                    mac_address
                    is_online
                    power_type
                    last_battery_change_date
                    next_battery_change_date
                    battery_change_by_date
                    last_heartbeat
                    floorID
                    roomID
                  }
                  hives {
                    id
                    name
                    serialNumber
                    isOnline
                    lastHeartbeat
                    floorID
                  }
                }
              }
            }
          }
        }
      `,
      fetchPolicy: "network-only",
    });

    saveFixture("graphql", "full-topology-org.json", fullTopology.data);

    // Get a single building ID for scoped queries
    const firstBuilding = fullTopology.data?.sites?.data?.[0]?.buildings?.[0];
    const firstFloor = firstBuilding?.floors?.[0];

    if (firstBuilding) {
      const buildingHealth = await apolloClient.query({
        query: gql`
          query GetBuildingDeviceHealth($buildingId: ID!) {
            building(id: $buildingId) {
              id
              name
              site_id
              floors {
                id
                name
                building_id
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
                }
                sensors {
                  id
                  name
                  mac_address
                  is_online
                  power_type
                  last_battery_change_date
                  next_battery_change_date
                  battery_change_by_date
                  last_heartbeat
                  floorID
                  roomID
                }
                hives {
                  id
                  name
                  serialNumber
                  isOnline
                  lastHeartbeat
                  floorID
                }
              }
            }
          }
        `,
        variables: { buildingId: firstBuilding.id },
        fetchPolicy: "network-only",
      });

      saveFixture("graphql", "building-device-health.json", buildingHealth.data);
    }

    if (firstFloor) {
      const floorHealth = await apolloClient.query({
        query: gql`
          query GetFloorDeviceHealth($floorId: ID!) {
            floor(id: $floorId) {
              id
              name
              building_id
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
              }
              sensors {
                id
                name
                mac_address
                is_online
                power_type
                last_battery_change_date
                next_battery_change_date
                battery_change_by_date
                last_heartbeat
                floorID
                roomID
              }
              hives {
                id
                name
                serialNumber
                isOnline
                lastHeartbeat
                floorID
              }
            }
          }
        `,
        variables: { floorId: firstFloor.id },
        fetchPolicy: "network-only",
      });

      saveFixture("graphql", "floor-device-health.json", floorHealth.data);
    }

    // Query rooms for available-rooms tool
    const roomsQuery = await apolloClient.query({
      query: gql`
        query GetRoomsWithCapacity {
          rooms {
            data {
              id
              name
              capacity
              tags
              floor_id
              building_id
              floor {
                id
                name
                building {
                  id
                  name
                }
              }
            }
          }
        }
      `,
      fetchPolicy: "network-only",
    });

    saveFixture("graphql", "rooms-with-capacity.json", roomsQuery.data);

    // 2. v3 Reporting API Fixtures
    console.log("\n📈 Capturing v3 Reporting responses...");

    // Get room IDs that have sensors (extract from sensor.roomID)
    const allSensors =
      fullTopology.data?.sites?.data?.flatMap(
        (site: any) =>
          site.buildings?.flatMap((building: any) =>
            building.floors?.flatMap((floor: any) => floor.sensors || [])
          ) || []
      ) || [];

    const roomsWithSensors = Array.from(
      new Set(allSensors.map((s: any) => s.roomID).filter(Boolean))
    );

    console.log(
      `  Found ${roomsWithSensors.length} rooms with sensors, querying occupancy for ALL of them...`
    );

    if (roomsWithSensors.length > 0) {
      // Query BOTH endpoints separately to inspect data availability
      console.log(
        `  Querying room_occupancy (presence) for all ${roomsWithSensors.length} rooms...`
      );

      const presenceRequest = new ReportingRequestBuilder()
        .assets("room", roomsWithSensors)
        .measurements(["room_occupancy"])
        .timeRange(
          new Date(Date.now() - 20 * 60 * 1000).toISOString(),
          new Date(Date.now() - 1 * 60 * 1000).toISOString()
        )
        .window("1m", "max")
        .groupBy(["room_id", "time"], true)
        .build();

      presenceRequest.filter.value = { gte: 0 };
      const presenceResponse = await queryReporting(presenceRequest);

      console.log(
        `  Querying traffic_room_occupancy (traffic) for all ${roomsWithSensors.length} rooms...`
      );

      const trafficRequest = new ReportingRequestBuilder()
        .assets("room", roomsWithSensors)
        .measurements(["traffic_room_occupancy"])
        .timeRange(
          new Date(Date.now() - 20 * 60 * 1000).toISOString(),
          new Date(Date.now() - 1 * 60 * 1000).toISOString()
        )
        .window("1m", "max")
        .groupBy(["room_id", "time"], true)
        .build();

      trafficRequest.filter.calibrated = "true";
      trafficRequest.filter.value = { gte: 0 };

      let trafficResponse;
      try {
        trafficResponse = await queryReporting(trafficRequest);
      } catch (error) {
        console.log(`  ⚠️  Traffic query failed:`, (error as Error).message);
        trafficResponse = { data: {} };
      }

      // Count rooms in each response
      const presenceRoomCount = presenceResponse.data
        ? Object.keys(presenceResponse.data).length
        : 0;
      const trafficRoomCount = trafficResponse.data ? Object.keys(trafficResponse.data).length : 0;

      console.log(`  ✓ Presence response: ${presenceRoomCount} rooms`);
      console.log(`  ✓ Traffic response: ${trafficRoomCount} rooms`);

      // Save BOTH responses for inspection
      saveFixture("reporting", "current-occupancy-presence.json", presenceResponse);
      saveFixture("reporting", "current-occupancy-traffic.json", trafficResponse);

      // Now use getCurrentOccupancy (which combines both)
      const currentOccupancyData = await getCurrentOccupancy("room", roomsWithSensors);

      console.log(`  ✓ Combined occupancy data for ${currentOccupancyData.length} rooms`);

      const presenceCount = currentOccupancyData.filter((d) =>
        d.measurement.includes("room_occupancy")
      ).length;
      const trafficCount = currentOccupancyData.filter((d) =>
        d.measurement.includes("traffic")
      ).length;

      console.log(`    - Using presence: ${presenceCount} rooms`);
      console.log(`    - Using traffic: ${trafficCount} rooms`);

      // Wrap in response format for fixture compatibility
      const currentOccupancy = {
        data: currentOccupancyData,
        page_info: {
          page: 1,
          page_item_count: currentOccupancyData.length,
          total_item_count: currentOccupancyData.length,
          total_pages: 1,
        },
      };

      saveFixture("reporting", "current-occupancy-rooms.json", currentOccupancy);

      // Hourly traffic flow (if we have traffic-mode sensors)
      try {
        const hourlyTraffic = await new ReportingRequestBuilder()
          .measurements(["traffic"])
          .timeRange("-1h", "now")
          .window("5m", "sum")
          .build();

        const trafficResponse = await queryReporting(hourlyTraffic);
        saveFixture("reporting", "traffic-flow-hourly.json", trafficResponse);
      } catch (error) {
        console.log("  ℹ️  Skipping traffic fixtures (no traffic sensors found)");
      }

      // Full day traffic
      try {
        const dailyTraffic = await new ReportingRequestBuilder()
          .measurements(["traffic"])
          .timeRange("-24h", "now")
          .window("1h", "sum")
          .build();

        const dailyResponse = await queryReporting(dailyTraffic);
        saveFixture("reporting", "traffic-flow-today.json", dailyResponse);
      } catch (error) {
        console.log("  ℹ️  Skipping daily traffic fixtures");
      }
    }

    // 3. v4 Stats API Fixtures
    console.log("\n📊 Capturing v4 Stats responses...");

    // Use first 20 rooms for stats (better validation sample)
    const sampleRoomIds = roomsWithSensors.slice(0, 20);

    if (sampleRoomIds.length > 0) {
      // Stats for single room (4 weeks)
      // Use correct v4 measurement name: occupancy_avg_presence
      const singleRoomStats = await new StatsRequestBuilder()
        .measurements(["occupancy_avg_presence"])
        .assets([sampleRoomIds[0]])
        .timeRange("-28d") // Will be converted to ISO-8601
        .execute();

      saveFixture("stats", "room-stats-4weeks.json", singleRoomStats);

      // Stats for multiple rooms
      const multiRoomStats = await new StatsRequestBuilder()
        .measurements(["occupancy_avg_presence", "occupancy_median_presence"])
        .assets(sampleRoomIds.slice(0, 3))
        .timeRange("-7d")
        .execute();

      saveFixture("stats", "multi-room-stats.json", multiRoomStats);

      console.log("  ✓ Stats fixtures generated successfully");
    }

    console.log("\n✅ All fixtures generated successfully!");
    console.log("\nNote: Review fixtures for any remaining sensitive data before committing.");
  } catch (error: any) {
    console.error("\n❌ Error generating fixtures:", error.message);
    if (process.env.DEBUG) {
      console.error(error);
    }
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
