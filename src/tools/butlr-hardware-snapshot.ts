import { apolloClient } from "../clients/graphql-client.js";
import { gql } from "@apollo/client";
import { z } from "zod";
import { GET_ALL_SENSORS, GET_ALL_HIVES } from "../clients/queries/topology.js";
import type { Site, Building, Floor, Sensor, Hive } from "../clients/types.js";
import { buildHardwareSummary, daysBetween, hoursBetween } from "../utils/natural-language.js";
import { translateGraphQLError, formatMCPError } from "../errors/mcp-errors.js";

/**
 * Zod validation schema for butlr_hardware_snapshot
 */
export const HardwareSnapshotArgsSchema = z
  .object({
    scope_type: z.enum(["org", "site", "building", "floor"]).default("org"),

    scope_id: z.string().min(1, "scope_id cannot be empty").optional(),

    include_battery_details: z.boolean().default(false),

    battery_status_filter: z.enum(["critical", "due_soon", "healthy", "all"]).default("all"),

    limit: z
      .number()
      .int("limit must be an integer")
      .min(1, "limit must be at least 1")
      .max(500, "limit cannot exceed 500")
      .default(20),

    offline_devices_limit: z
      .number()
      .int("offline_devices_limit must be an integer")
      .min(1)
      .max(500)
      .default(20),
  })
  .strict()
  .refine(
    (data) => {
      if (data.scope_type !== "org" && !data.scope_id) {
        return false;
      }
      return true;
    },
    {
      message: "scope_id is required when scope_type is not 'org'",
      path: ["scope_id"],
    }
  );

/**
 * Tool definition for butlr_hardware_snapshot
 */
export const hardwareSnapshotTool = {
  name: "butlr_hardware_snapshot",
  description:
    "Get unified device health check combining online/offline status and battery health across your entire portfolio or specific locations. Provides proactive maintenance insights for facilities teams managing IoT sensor infrastructure.\n\n" +
    "Primary Users:\n" +
    "- IT Manager: Monitor sensor/hive uptime, track device health KPIs, report on system reliability\n" +
    "- Field Technician: Identify devices needing maintenance before site visits, prioritize battery replacements\n" +
    "- Facilities Manager: Verify system health before quarterly reviews, validate sensor coverage\n\n" +
    "Example Queries:\n" +
    '1. "Show me all offline sensors in Building 2 East Tower"\n' +
    '2. "Which sensors need battery replacements in the next 7 days?"\n' +
    '3. "Give me a hardware health snapshot for the SF office"\n' +
    '4. "Are there any sensors that haven\'t reported in 24 hours?"\n' +
    '5. "What\'s the battery status for Floor 3?"\n' +
    '6. "How many hives are offline organization-wide?"\n' +
    '7. "Show me sensors with overdue battery changes (critical status)"\n' +
    '8. "I\'m planning a site visit to Chicago - what devices need attention?"\n\n' +
    "When to Use:\n" +
    "- Quick overview of device health for planning maintenance\n" +
    "- Preparing for site visits (know which devices need service)\n" +
    "- Proactive battery alerts before sensor failures impact data quality\n" +
    "- Reporting uptime metrics or system reliability to leadership\n" +
    "- Troubleshooting missing data issues (check if sensors are online)\n\n" +
    "When NOT to Use:\n" +
    "- Need detailed config for specific sensor → use butlr_get_asset_details with include_devices: true\n" +
    "- Searching for sensor by name/MAC → use butlr_search_assets first with asset_types: ['sensor']\n" +
    "- Historical device uptime trends → this tool shows current snapshot only\n\n" +
    "CRE Context: Battery-powered sensors typically last 1-2 years depending on mode. Proactive battery management prevents data gaps that could impact space utilization reporting and right-sizing decisions.\n\n" +
    "See Also: butlr_search_assets, butlr_get_asset_details, butlr_list_topology",
  inputSchema: {
    type: "object",
    properties: {
      scope_type: {
        type: "string",
        enum: ["org", "site", "building", "floor"],
        default: "org",
        description: "Scope of the health check",
      },
      scope_id: {
        type: "string",
        description: "Required if scope_type != 'org'",
      },
      include_battery_details: {
        type: "boolean",
        default: false,
        description:
          "Include list of sensors needing battery service (context-efficient: only when needed)",
      },
      battery_status_filter: {
        type: "string",
        enum: ["critical", "due_soon", "healthy", "all"],
        default: "all",
        description: "Filter battery details. 'critical'=overdue, 'due_soon'=<30 days",
      },
      limit: {
        type: "number",
        default: 20,
        description: "Max devices in battery_details list",
      },
      offline_devices_limit: {
        type: "number",
        default: 20,
        description: "Max offline devices to show (default: 20, sorted newest first)",
      },
    },
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
};

/**
 * Input arguments (output type from Zod schema after defaults applied)
 */
export type HardwareSnapshotArgs = z.output<typeof HardwareSnapshotArgsSchema>;

/**
 * Battery status for a sensor
 */
type BatteryStatus = "critical" | "due_soon" | "healthy" | "no_battery";

/**
 * Battery detail for a specific sensor
 */
interface BatteryDetail {
  sensor_id: string;
  sensor_name: string;
  mac_address: string; // Human-readable identifier
  path: string;
  status: BatteryStatus;
  battery_change_by_date: string;
  days_remaining: number;
  last_battery_change_date?: string;
  next_battery_change_date?: string;
}

/**
 * Floor breakdown
 */
interface FloorBreakdown {
  floor_id: string;
  floor_name: string;
  sensors_online: number;
  sensors_total: number;
  percent_online: number;
  batteries_critical: number;
  batteries_due_soon: number;
}

/**
 * Offline device
 */
interface OfflineDevice {
  type: "sensor" | "hive";
  id: string;
  name: string;
  serial_number?: string; // Hive serial number (hives only)
  mac_address?: string; // Sensor MAC address (sensors only)
  path: string;
  last_heartbeat?: string;
  hours_offline?: number;
}

/**
 * GraphQL query for topology (without devices - they're queried separately)
 */
const GET_TOPOLOGY_FOR_HEALTH = gql`
  query GetTopologyForHealth {
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
          }
        }
      }
    }
  }
`;

/**
 * Calculate battery status for a sensor
 * Exported for unit testing
 */
export function getBatteryStatus(sensor: Sensor, currentDate: Date = new Date()): BatteryStatus {
  // Wired sensors don't use batteries
  if (sensor.power_type === "Wired") {
    return "no_battery";
  }

  // No battery_change_by_date means we don't have battery tracking
  if (!sensor.battery_change_by_date) {
    return "healthy"; // Assume healthy if no tracking
  }

  const changeByDate = new Date(sensor.battery_change_by_date);
  const daysRemaining = daysBetween(currentDate, changeByDate);

  if (daysRemaining < 0) {
    return "critical"; // Overdue!
  } else if (daysRemaining <= 30) {
    return "due_soon"; // Within 30 days
  } else {
    return "healthy";
  }
}

/**
 * Build hierarchy context for a sensor/hive
 */
function buildDevicePath(
  device: Sensor | Hive,
  floors: Floor[],
  buildings: Building[],
  sites: Site[]
): string {
  const deviceFloorId = (device as any).floor_id || (device as any).floorID;
  const floor = floors.find((f) => f.id === deviceFloorId);
  if (!floor) return device.name;

  const building = buildings.find((b) => b.id === floor.building_id);
  if (!building) return `${floor.name} > ${device.name}`;

  const site = sites.find((s) => s.id === building.site_id);
  if (!site) return `${building.name} > ${floor.name} > ${device.name}`;

  return `${site.name} > ${building.name} > ${floor.name} > ${device.name}`;
}

/**
 * Filter production devices from raw API responses, excluding test/mirror/placeholder devices.
 * Returns production devices and counts of excluded test devices.
 */
function filterProductionDevices(rawSensors: Sensor[], rawHives: Hive[]) {
  const sensors = rawSensors.filter(
    (s) =>
      s.mac_address &&
      s.mac_address.trim() !== "" &&
      !s.mac_address.startsWith("mi-rr-or") &&
      !s.mac_address.startsWith("fa-ke")
  );

  const hives = rawHives.filter(
    (h) =>
      h.serialNumber &&
      h.serialNumber.trim() !== "" &&
      !h.serialNumber.toLowerCase().startsWith("fake")
  );

  const mirrorSensors = rawSensors.filter(
    (s) => s.mac_address?.startsWith("mi-rr-or") || s.mac_address?.startsWith("fa-ke")
  ).length;
  const emptySensors = rawSensors.filter(
    (s) => !s.mac_address || s.mac_address.trim() === ""
  ).length;
  const fakeHives = rawHives.filter((h) => h.serialNumber?.toLowerCase().startsWith("fake")).length;
  const emptyHives = rawHives.filter((h) => !h.serialNumber || h.serialNumber.trim() === "").length;

  return {
    sensors,
    hives,
    testCounts: {
      sensors: {
        mirror: mirrorSensors,
        placeholder: emptySensors,
        total_test: mirrorSensors + emptySensors,
      },
      hives: { fake: fakeHives, placeholder: emptyHives, total_test: fakeHives + emptyHives },
    },
  };
}

/**
 * Group devices by floor ID and merge into floor objects
 */
function assignDevicesToFloors(sensors: Sensor[], hives: Hive[], floors: Floor[]): void {
  const sensorsByFloor: Record<string, Sensor[]> = {};
  const hivesByFloor: Record<string, Hive[]> = {};

  for (const sensor of sensors) {
    const floorId = sensor.floor_id || sensor.floorID;
    if (floorId) {
      if (!sensorsByFloor[floorId]) sensorsByFloor[floorId] = [];
      sensorsByFloor[floorId].push(sensor);
    }
  }

  for (const hive of hives) {
    const floorId = hive.floor_id || hive.floorID;
    if (floorId) {
      if (!hivesByFloor[floorId]) hivesByFloor[floorId] = [];
      hivesByFloor[floorId].push(hive);
    }
  }

  for (const floor of floors) {
    floor.sensors = sensorsByFloor[floor.id] || [];
    floor.hives = hivesByFloor[floor.id] || [];
  }
}

interface TestDeviceCounts {
  sensors: { mirror: number; placeholder: number; total_test: number };
  hives: { fake: number; placeholder: number; total_test: number };
}

/**
 * Execute hardware snapshot tool
 */
export async function executeHardwareSnapshot(args: HardwareSnapshotArgs) {
  const scopeType = args.scope_type;

  if (process.env.DEBUG) {
    console.error(
      `[hardware-snapshot] Querying device health for scope: ${scopeType}${args.scope_id ? `:${args.scope_id}` : ""}`
    );
  }

  let floors: Floor[] = [];
  let buildings: Building[] = [];
  let sites: Site[] = [];
  let scopeName = "";
  let testDeviceCounts: TestDeviceCounts | null = null;

  try {
    // Fetch all devices org-wide (API doesn't support scope-filtered device queries)
    const [sensorsResult, hivesResult] = await Promise.all([
      apolloClient.query<{ sensors: { data: Sensor[] } }>({
        query: GET_ALL_SENSORS,
        fetchPolicy: "network-only",
      }),
      apolloClient.query<{ hives: { data: Hive[] } }>({
        query: GET_ALL_HIVES,
        fetchPolicy: "network-only",
      }),
    ]);

    const allSensorsRaw = sensorsResult.data?.sensors?.data || [];
    const allHivesRaw = hivesResult.data?.hives?.data || [];

    if (scopeType === "org") {
      const topoResult = await apolloClient.query<{ sites: { data: Site[] } }>({
        query: GET_TOPOLOGY_FOR_HEALTH,
        fetchPolicy: "network-only",
      });

      if (!topoResult.data?.sites?.data) {
        throw new Error("Invalid response structure from API");
      }

      sites = topoResult.data.sites.data;
      buildings = sites.flatMap((s) => s.buildings || []);
      floors = buildings.flatMap((b) => b.floors || []);
      scopeName = "Organization";
    } else if (scopeType === "site") {
      const siteResult = await apolloClient.query<{ site: Site }>({
        query: gql`
          query GetSite($id: ID!) {
            site(id: $id) {
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
                }
              }
            }
          }
        `,
        variables: { id: args.scope_id },
        fetchPolicy: "network-only",
      });

      if (!siteResult.data?.site) {
        throw new Error(`Site ${args.scope_id} not found`);
      }

      sites = [siteResult.data.site];
      buildings = sites[0].buildings || [];
      floors = buildings.flatMap((b) => b.floors || []);
      scopeName = sites[0].name;
    } else if (scopeType === "building") {
      const buildingResult = await apolloClient.query<{ building: Building }>({
        query: gql`
          query GetBuilding($id: ID!) {
            building(id: $id) {
              id
              name
              site_id
              floors {
                id
                name
                building_id
              }
            }
          }
        `,
        variables: { id: args.scope_id },
        fetchPolicy: "network-only",
      });

      if (!buildingResult.data?.building) {
        throw new Error(`Building ${args.scope_id} not found`);
      }

      buildings = [buildingResult.data.building];
      floors = buildings[0].floors || [];
      scopeName = buildings[0].name;
    } else if (scopeType === "floor") {
      const floorResult = await apolloClient.query<{ floor: Floor }>({
        query: gql`
          query GetFloor($id: ID!) {
            floor(id: $id) {
              id
              name
              building_id
            }
          }
        `,
        variables: { id: args.scope_id },
        fetchPolicy: "network-only",
      });

      if (!floorResult.data?.floor) {
        throw new Error(`Floor ${args.scope_id} not found`);
      }

      floors = [floorResult.data.floor];
      scopeName = floors[0].name;
    }

    // Filter production devices and assign to scoped floors
    const {
      sensors: prodSensors,
      hives: prodHives,
      testCounts,
    } = filterProductionDevices(allSensorsRaw, allHivesRaw);
    assignDevicesToFloors(prodSensors, prodHives, floors);

    // Only include test device counts for org scope (where they're meaningful)
    if (scopeType === "org") {
      testDeviceCounts = testCounts;
    }
  } catch (error: unknown) {
    if (
      error &&
      typeof error === "object" &&
      ("graphQLErrors" in error || "networkError" in error)
    ) {
      const mcpError = translateGraphQLError(error as Parameters<typeof translateGraphQLError>[0]);
      const errorMessage = formatMCPError(mcpError);
      throw new Error(errorMessage);
    }
    throw error;
  }

  // Collect scoped sensors and hives (only devices on floors within this scope)
  const allSensors = floors.flatMap((f) => f.sensors || []);
  const allHives = floors.flatMap((f) => f.hives || []);

  if (process.env.DEBUG) {
    console.error(
      `[hardware-snapshot] Found ${allSensors.length} sensors, ${allHives.length} hives`
    );
  }

  // Calculate sensor statistics
  const sensorsOnline = allSensors.filter((s) => s.is_online).length;
  const sensorsOffline = allSensors.length - sensorsOnline;
  const sensorsPercentOnline =
    allSensors.length > 0 ? parseFloat(((sensorsOnline / allSensors.length) * 100).toFixed(1)) : 0;

  // Calculate hive statistics
  const hivesOnline = allHives.filter((h) => h.isOnline).length;
  const hivesOffline = allHives.length - hivesOnline;
  const hivesPercentOnline =
    allHives.length > 0 ? parseFloat(((hivesOnline / allHives.length) * 100).toFixed(1)) : 0;

  // Calculate battery health
  const batteryStatusCounts = {
    critical: 0,
    due_soon: 0,
    healthy: 0,
    no_battery: 0,
  };

  const batteryDetails: BatteryDetail[] = [];

  for (const sensor of allSensors) {
    const status = getBatteryStatus(sensor);
    batteryStatusCounts[status]++;

    // If user requested battery details and this sensor matches filter
    if (args.include_battery_details) {
      const statusFilter = args.battery_status_filter || "all";

      if (statusFilter === "all" || statusFilter === status) {
        const now = new Date();
        const changeByDate = sensor.battery_change_by_date
          ? new Date(sensor.battery_change_by_date)
          : null;
        const daysRemaining = changeByDate ? daysBetween(now, changeByDate) : 0;

        batteryDetails.push({
          sensor_id: sensor.id,
          sensor_name: sensor.name,
          mac_address: sensor.mac_address, // Human-readable identifier
          path: buildDevicePath(sensor, floors, buildings, sites),
          status,
          battery_change_by_date: sensor.battery_change_by_date || "N/A",
          days_remaining: daysRemaining,
          last_battery_change_date: sensor.last_battery_change_date,
          next_battery_change_date: sensor.next_battery_change_date,
        });
      }
    }
  }

  // Sort battery details by urgency (most urgent first)
  batteryDetails.sort((a, b) => a.days_remaining - b.days_remaining);

  // Limit battery details
  const limit = args.limit || 20;
  const limitedBatteryDetails = batteryDetails.slice(0, limit);

  // Build summary
  const summary = buildHardwareSummary({
    sensorsOnline,
    sensorsTotal: allSensors.length,
    hivesOnline,
    hivesTotal: allHives.length,
    batteriesCritical: batteryStatusCounts.critical,
    batteriesDueSoon: batteryStatusCounts.due_soon,
  });

  // Build floor breakdown if multiple floors
  const breakdownByFloor: FloorBreakdown[] = [];
  if (floors.length > 1) {
    for (const floor of floors) {
      const floorSensors = allSensors.filter((s) => (s.floor_id || s.floorID) === floor.id);
      const floorSensorsOnline = floorSensors.filter((s) => s.is_online).length;

      const floorBatteriesCritical = floorSensors.filter(
        (s) => getBatteryStatus(s) === "critical"
      ).length;
      const floorBatteriesDueSoon = floorSensors.filter(
        (s) => getBatteryStatus(s) === "due_soon"
      ).length;

      breakdownByFloor.push({
        floor_id: floor.id,
        floor_name: floor.name,
        sensors_online: floorSensorsOnline,
        sensors_total: floorSensors.length,
        percent_online:
          floorSensors.length > 0
            ? parseFloat(((floorSensorsOnline / floorSensors.length) * 100).toFixed(1))
            : 0,
        batteries_critical: floorBatteriesCritical,
        batteries_due_soon: floorBatteriesDueSoon,
      });
    }
  }

  // Build offline devices list
  const offlineDevices: OfflineDevice[] = [];
  const now = new Date();

  for (const sensor of allSensors) {
    if (!sensor.is_online) {
      // Use isOnline consistently, heartbeat is optional enrichment
      const lastHeartbeat = sensor.last_heartbeat
        ? new Date(sensor.last_heartbeat * 1000)
        : undefined;
      const hoursOffline = lastHeartbeat ? hoursBetween(lastHeartbeat, now) : undefined;

      offlineDevices.push({
        type: "sensor",
        id: sensor.id,
        name: sensor.name,
        mac_address: sensor.mac_address,
        path: buildDevicePath(sensor, floors, buildings, sites),
        last_heartbeat: lastHeartbeat?.toISOString(),
        hours_offline: hoursOffline,
      });
    }
  }

  for (const hive of allHives) {
    if (!hive.isOnline) {
      // Use isOnline consistently, heartbeat is optional enrichment
      const lastHeartbeat = hive.lastHeartbeat ? new Date(hive.lastHeartbeat * 1000) : undefined;
      const hoursOffline = lastHeartbeat ? hoursBetween(lastHeartbeat, now) : undefined;

      offlineDevices.push({
        type: "hive",
        id: hive.id,
        name: hive.name,
        serial_number: hive.serialNumber,
        path: buildDevicePath(hive, floors, buildings, sites),
        last_heartbeat: lastHeartbeat?.toISOString(),
        hours_offline: hoursOffline,
      });
    }
  }

  // Sort offline devices by hours offline (SHORTEST first for devices with heartbeat data)
  // Devices without heartbeat go to end
  offlineDevices.sort((a, b) => {
    if (a.hours_offline === undefined && b.hours_offline === undefined) return 0;
    if (a.hours_offline === undefined) return 1; // No heartbeat goes to end
    if (b.hours_offline === undefined) return -1; // No heartbeat goes to end
    return a.hours_offline - b.hours_offline; // Shortest offline first
  });

  // Count offline devices by type
  const offlineSensorCount = offlineDevices.filter((d) => d.type === "sensor").length;
  const offlineHiveCount = offlineDevices.filter((d) => d.type === "hive").length;

  // Build enhanced summary with truncation info
  const offlineDeviceLimit = args.offline_devices_limit || 20;
  let enhancedSummary = summary;
  if (offlineDevices.length > offlineDeviceLimit) {
    enhancedSummary += ` Showing ${offlineDeviceLimit} most recently offline devices (${offlineSensorCount} sensors, ${offlineHiveCount} hives offline).`;
  }

  // Build response
  const response: Record<string, unknown> = {
    summary: enhancedSummary,
    sensors: {
      total: allSensors.length,
      online: sensorsOnline,
      offline: sensorsOffline,
      percent_online: sensorsPercentOnline,
    },
    hives: {
      total: allHives.length,
      online: hivesOnline,
      offline: hivesOffline,
      percent_online: hivesPercentOnline,
    },
    battery_health: batteryStatusCounts,
    scope: {
      type: scopeType,
      id: args.scope_id,
      name: scopeName,
    },
    timestamp: new Date().toISOString(),
  };

  // Add test device breakdown if any exist
  if (testDeviceCounts !== null) {
    const totalTestSensors = testDeviceCounts.sensors.total_test;
    const totalTestHives = testDeviceCounts.hives.total_test;

    if (totalTestSensors > 0 || totalTestHives > 0) {
      response.test_devices_excluded = {
        sensors: {
          mirror: testDeviceCounts.sensors.mirror,
          placeholder: testDeviceCounts.sensors.placeholder,
          total: totalTestSensors,
        },
        hives: {
          fake: testDeviceCounts.hives.fake,
          placeholder: testDeviceCounts.hives.placeholder,
          total: totalTestHives,
        },
        note: `Totals exclude ${totalTestSensors} test/placeholder sensors and ${totalTestHives} test hives. These devices still produce occupancy data.`,
      };
    }
  }

  // Conditionally add optional fields
  if (args.include_battery_details && limitedBatteryDetails.length > 0) {
    response.battery_details = limitedBatteryDetails;

    if (batteryDetails.length > limit) {
      response.battery_details_truncated = true;
      response.battery_details_total = batteryDetails.length;
    }
  }

  if (breakdownByFloor.length > 0) {
    response.breakdown_by_floor = breakdownByFloor;
  }

  if (offlineDevices.length > 0) {
    const limitedOffline = offlineDevices.slice(0, offlineDeviceLimit);
    response.offline_devices = limitedOffline;
    response.offline_devices_summary = {
      sensors_offline: offlineSensorCount,
      hives_offline: offlineHiveCount,
      total_offline: offlineDevices.length,
      showing: limitedOffline.length,
    };

    if (offlineDevices.length > offlineDeviceLimit) {
      response.offline_devices_truncated = true;
      response.offline_devices_total = offlineDevices.length;
    }
  }

  return response;
}
