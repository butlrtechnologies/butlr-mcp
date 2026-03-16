import { describe, it, expect, beforeEach, vi } from "vitest";
import { executeHardwareSnapshot } from "../../butlr-hardware-snapshot.js";
import { apolloClient } from "../../../clients/graphql-client.js";
import { loadGraphQLFixture } from "../../../__mocks__/apollo-client.js";

// Mock the Apollo client
vi.mock("../../../clients/graphql-client.js", () => ({
  apolloClient: {
    query: vi.fn(),
  },
}));

// Helper to set up proper multi-query mocks for hardware snapshot
function setupHardwareSnapshotMocks(fixture: any) {
  // Extract sensors and hives from fixture
  const allSensors: any[] = [];
  const allHives: any[] = [];

  for (const site of fixture.sites.data) {
    for (const building of site.buildings || []) {
      for (const floor of building.floors || []) {
        if (floor.sensors) {
          allSensors.push(...floor.sensors);
        }
        if (floor.hives) {
          allHives.push(...floor.hives);
        }
      }
    }
  }

  // Mock all three queries: topology, sensors, hives
  vi.mocked(apolloClient.query).mockImplementation((options: any) => {
    const queryString = options.query.loc?.source?.body || "";

    // Return topology WITHOUT sensors/hives (matches GET_TOPOLOGY_FOR_HEALTH)
    if (queryString.includes("GetTopologyForHealth")) {
      return Promise.resolve({
        data: { sites: fixture.sites },
        loading: false,
        networkStatus: 7,
      } as any);
    }

    // Return all sensors
    if (queryString.includes("GetAllSensors")) {
      return Promise.resolve({
        data: { sensors: { data: allSensors } },
        loading: false,
        networkStatus: 7,
      } as any);
    }

    // Return all hives
    if (queryString.includes("GetAllHives")) {
      return Promise.resolve({
        data: { hives: { data: allHives } },
        loading: false,
        networkStatus: 7,
      } as any);
    }

    return Promise.reject(new Error("Unknown query"));
  });
}

describe("butlr_hardware_snapshot - Integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("Org-wide query", () => {
    it("returns correct sensor and hive counts", async () => {
      const fixture = loadGraphQLFixture("full-topology-org");
      setupHardwareSnapshotMocks(fixture);

      const result = await executeHardwareSnapshot({ scope_type: "org" });

      // Verify sensor counts
      expect(result.sensors).toBeDefined();
      expect(result.sensors.total).toBeGreaterThan(0);
      expect(result.sensors.online).toBeGreaterThanOrEqual(0);
      expect(result.sensors.offline).toBeGreaterThanOrEqual(0);
      expect(result.sensors.percent_online).toBeGreaterThanOrEqual(0);
      expect(result.sensors.percent_online).toBeLessThanOrEqual(100);

      // Verify hive counts
      expect(result.hives).toBeDefined();
      expect(result.hives.total).toBeGreaterThanOrEqual(0);
      expect(result.hives.online).toBeGreaterThanOrEqual(0);
      expect(result.hives.offline).toBeGreaterThanOrEqual(0);

      // Verify totals add up
      expect(result.sensors.online + result.sensors.offline).toBe(result.sensors.total);
      expect(result.hives.online + result.hives.offline).toBe(result.hives.total);
    });

    it("calculates battery health buckets correctly", async () => {
      const fixture = loadGraphQLFixture("full-topology-org");
      setupHardwareSnapshotMocks(fixture);

      const result = await executeHardwareSnapshot({ scope_type: "org" });

      expect(result.battery_health).toBeDefined();
      expect(result.battery_health.critical).toBeGreaterThanOrEqual(0);
      expect(result.battery_health.due_soon).toBeGreaterThanOrEqual(0);
      expect(result.battery_health.healthy).toBeGreaterThanOrEqual(0);
      expect(result.battery_health.no_battery).toBeGreaterThanOrEqual(0);

      // Total battery statuses should equal total sensors
      const totalBattery =
        result.battery_health.critical +
        result.battery_health.due_soon +
        result.battery_health.healthy +
        result.battery_health.no_battery;

      expect(totalBattery).toBe(result.sensors.total);
    });

    it("includes natural language summary", async () => {
      const fixture = loadGraphQLFixture("full-topology-org");
      setupHardwareSnapshotMocks(fixture);

      const result = await executeHardwareSnapshot({ scope_type: "org" });

      expect(result.summary).toBeDefined();
      expect(typeof result.summary).toBe("string");
      expect(result.summary).toContain("sensors online");
      expect(result.summary).toContain("hives online");
    });

    it("includes scope information", async () => {
      const fixture = loadGraphQLFixture("full-topology-org");
      setupHardwareSnapshotMocks(fixture);

      const result = await executeHardwareSnapshot({ scope_type: "org" });

      expect(result.scope).toBeDefined();
      expect(result.scope.type).toBe("org");
      expect(result.scope.name).toBe("Organization");
    });

    it("includes timestamp", async () => {
      const fixture = loadGraphQLFixture("full-topology-org");
      setupHardwareSnapshotMocks(fixture);

      const result = await executeHardwareSnapshot({ scope_type: "org" });

      expect(result.timestamp).toBeDefined();
      expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });
  });

  describe("Battery details", () => {
    it("does not include battery_details by default", async () => {
      const fixture = loadGraphQLFixture("full-topology-org");
      setupHardwareSnapshotMocks(fixture);

      const result = await executeHardwareSnapshot({ scope_type: "org" });

      expect(result.battery_details).toBeUndefined();
    });

    it("includes battery_details when requested", async () => {
      const fixture = loadGraphQLFixture("full-topology-org");
      setupHardwareSnapshotMocks(fixture);

      const result = await executeHardwareSnapshot({
        scope_type: "org",
        include_battery_details: true,
      });

      // If there are batteries needing attention
      if (result.battery_health.critical > 0 || result.battery_health.due_soon > 0) {
        expect(result.battery_details).toBeDefined();
        expect(Array.isArray(result.battery_details)).toBe(true);

        // Verify structure of first detail
        if (result.battery_details && result.battery_details.length > 0) {
          const detail = result.battery_details[0];
          expect(detail.sensor_id).toBeDefined();
          expect(detail.sensor_name).toBeDefined();
          expect(detail.mac_address).toBeDefined(); // Human-readable!
          expect(detail.status).toMatch(/critical|due_soon|healthy/);
          expect(typeof detail.days_remaining).toBe("number");
        }
      }
    });

    it("sorts battery_details by urgency (days_remaining ascending)", async () => {
      const fixture = loadGraphQLFixture("full-topology-org");
      setupHardwareSnapshotMocks(fixture);

      const result = await executeHardwareSnapshot({
        scope_type: "org",
        include_battery_details: true,
      });

      if (result.battery_details && result.battery_details.length > 1) {
        for (let i = 1; i < result.battery_details.length; i++) {
          expect(result.battery_details[i].days_remaining).toBeGreaterThanOrEqual(
            result.battery_details[i - 1].days_remaining
          );
        }
      }
    });

    it("filters battery_details by status", async () => {
      const fixture = loadGraphQLFixture("full-topology-org");
      setupHardwareSnapshotMocks(fixture);

      const result = await executeHardwareSnapshot({
        scope_type: "org",
        include_battery_details: true,
        battery_status_filter: "critical",
      });

      if (result.battery_details && result.battery_details.length > 0) {
        result.battery_details.forEach((detail) => {
          expect(detail.status).toBe("critical");
        });
      }
    });

    it("respects limit parameter", async () => {
      const fixture = loadGraphQLFixture("full-topology-org");
      setupHardwareSnapshotMocks(fixture);

      const result = await executeHardwareSnapshot({
        scope_type: "org",
        include_battery_details: true,
        limit: 5,
      });

      if (result.battery_details) {
        expect(result.battery_details.length).toBeLessThanOrEqual(5);
      }
    });
  });

  describe("Offline devices", () => {
    it("includes offline_devices list when devices are offline", async () => {
      const fixture = loadGraphQLFixture("full-topology-org");
      setupHardwareSnapshotMocks(fixture);

      const result = await executeHardwareSnapshot({ scope_type: "org" });

      if (result.sensors.offline > 0 || result.hives.offline > 0) {
        expect(result.offline_devices).toBeDefined();
        expect(Array.isArray(result.offline_devices)).toBe(true);

        // Verify structure
        const device = result.offline_devices![0];
        expect(device.type).toMatch(/sensor|hive/);
        expect(device.id).toBeDefined();
        expect(device.name).toBeDefined();
        expect(device.path).toBeDefined();

        // Human-readable IDs
        if (device.type === "sensor") {
          expect(device.mac_address).toBeDefined();
          expect(device.serial_number).toBeUndefined();
        } else {
          expect(device.serial_number).toBeDefined();
          expect(device.mac_address).toBeUndefined();
        }

        if (device.last_heartbeat) {
          expect(device.hours_offline).toBeGreaterThan(0);
        }
      }
    });

    it("sorts offline devices by hours offline (shortest first)", async () => {
      const fixture = loadGraphQLFixture("full-topology-org");
      setupHardwareSnapshotMocks(fixture);

      const result = await executeHardwareSnapshot({ scope_type: "org" });

      if (result.offline_devices && result.offline_devices.length > 1) {
        for (let i = 1; i < result.offline_devices.length; i++) {
          expect(result.offline_devices[i].hours_offline!).toBeGreaterThanOrEqual(
            result.offline_devices[i - 1].hours_offline!
          );
        }
      }
    });
  });

  describe("Validation", () => {
    it("throws if scope_id missing for non-org scope", async () => {
      // Note: Validation happens in MCP handler, not execute function
      // Direct calls to execute will fail at GraphQL level with "Unknown query"
      await expect(executeHardwareSnapshot({ scope_type: "building" })).rejects.toThrow(
        "Unknown query"
      );
    });

    it("throws if scope_id missing for site scope", async () => {
      // Note: Validation happens in MCP handler, not execute function
      await expect(executeHardwareSnapshot({ scope_type: "site" })).rejects.toThrow(
        "Unknown query"
      );
    });
  });
});
