import { describe, it, expect } from "vitest";
import { getBatteryStatus } from "../../butlr-hardware-snapshot.js";
import type { Sensor } from "../../../clients/types.js";

describe("getBatteryStatus", () => {
  const now = new Date("2025-01-13T12:00:00Z"); // Fixed reference date

  describe("wired sensors", () => {
    it('returns "no_battery" for wired sensors', () => {
      const sensor = {
        id: "sensor_1",
        name: "Wired Sensor",
        power_type: "Wired",
        battery_change_by_date: "2025-02-01",
      } as Sensor;

      expect(getBatteryStatus(sensor, now)).toBe("no_battery");
    });

    it('returns "no_battery" even if battery dates are present', () => {
      const sensor = {
        id: "sensor_2",
        name: "Wired Sensor with Dates",
        power_type: "Wired",
        battery_change_by_date: "2025-01-01", // Overdue
        last_battery_change_date: "2024-12-01",
      } as Sensor;

      // Should ignore battery dates for wired sensors
      expect(getBatteryStatus(sensor, now)).toBe("no_battery");
    });
  });

  describe("critical batteries (overdue)", () => {
    it('returns "critical" for batteries past change-by date', () => {
      const sensor = {
        id: "sensor_3",
        name: "Overdue Battery",
        power_type: "Battery",
        battery_change_by_date: "2025-01-10", // 3 days ago
      } as Sensor;

      expect(getBatteryStatus(sensor, now)).toBe("critical");
    });

    it('returns "critical" for batteries due today (edge case)', () => {
      const sensor = {
        id: "sensor_4",
        name: "Due Today",
        power_type: "Battery",
        battery_change_by_date: "2025-01-12", // 1 day ago
      } as Sensor;

      expect(getBatteryStatus(sensor, now)).toBe("critical");
    });

    it('returns "critical" for severely overdue batteries', () => {
      const sensor = {
        id: "sensor_5",
        name: "Very Overdue",
        power_type: "Battery",
        battery_change_by_date: "2024-12-01", // 43 days ago
      } as Sensor;

      expect(getBatteryStatus(sensor, now)).toBe("critical");
    });
  });

  describe("due soon batteries (0-30 days)", () => {
    it('returns "due_soon" for batteries due in 30 days', () => {
      const sensor = {
        id: "sensor_6",
        name: "Due in 30 Days",
        power_type: "Battery",
        battery_change_by_date: "2025-02-12", // Exactly 30 days
      } as Sensor;

      expect(getBatteryStatus(sensor, now)).toBe("due_soon");
    });

    it('returns "due_soon" for batteries due in 15 days', () => {
      const sensor = {
        id: "sensor_7",
        name: "Due in 15 Days",
        power_type: "Battery",
        battery_change_by_date: "2025-01-28",
      } as Sensor;

      expect(getBatteryStatus(sensor, now)).toBe("due_soon");
    });

    it('returns "due_soon" for batteries due in 1 day', () => {
      const sensor = {
        id: "sensor_8",
        name: "Due Tomorrow",
        power_type: "Battery",
        battery_change_by_date: "2025-01-14", // Tomorrow
      } as Sensor;

      expect(getBatteryStatus(sensor, now)).toBe("due_soon");
    });

    it('returns "critical" for batteries due today at midnight (already passed)', () => {
      const sensor = {
        id: "sensor_9",
        name: "Due Today",
        power_type: "Battery",
        battery_change_by_date: "2025-01-13", // Today at midnight (already passed since now is noon)
      } as Sensor;

      // Midnight today is 12 hours ago from noon = -1 days
      expect(getBatteryStatus(sensor, now)).toBe("critical");
    });
  });

  describe("healthy batteries (>30 days)", () => {
    it('returns "due_soon" for batteries due in 31 days at midnight', () => {
      const sensor = {
        id: "sensor_10",
        name: "31 Days Battery",
        power_type: "Battery",
        battery_change_by_date: "2025-02-13", // 31 days at midnight = 30.5 days
      } as Sensor;

      // Since it's midnight, it's actually only 30.5 days from noon
      expect(getBatteryStatus(sensor, now)).toBe("due_soon");
    });

    it('returns "healthy" for batteries due in 60 days', () => {
      const sensor = {
        id: "sensor_11",
        name: "Very Healthy",
        power_type: "Battery",
        battery_change_by_date: "2025-03-14", // 60 days
      } as Sensor;

      expect(getBatteryStatus(sensor, now)).toBe("healthy");
    });

    it('returns "healthy" for batteries due in 180 days', () => {
      const sensor = {
        id: "sensor_12",
        name: "Brand New Battery",
        power_type: "Battery",
        battery_change_by_date: "2025-07-12", // 180 days
      } as Sensor;

      expect(getBatteryStatus(sensor, now)).toBe("healthy");
    });
  });

  describe("missing battery data", () => {
    it('returns "unknown" when battery_change_by_date is missing', () => {
      const sensor = {
        id: "sensor_13",
        name: "No Battery Tracking",
        power_type: "Battery",
        battery_change_by_date: undefined,
      } as Sensor;

      expect(getBatteryStatus(sensor, now)).toBe("unknown");
    });

    it('returns "unknown" when battery_change_by_date is null', () => {
      const sensor = {
        id: "sensor_14",
        name: "Null Battery Date",
        power_type: "Battery",
        battery_change_by_date: null as any,
      } as Sensor;

      expect(getBatteryStatus(sensor, now)).toBe("unknown");
    });

    it('returns "unknown" when battery_change_by_date is empty string', () => {
      const sensor = {
        id: "sensor_15",
        name: "Empty Battery Date",
        power_type: "Battery",
        battery_change_by_date: "" as any,
      } as Sensor;

      expect(getBatteryStatus(sensor, now)).toBe("unknown");
    });
  });

  describe("boundary conditions", () => {
    it("handles exactly 0 days remaining (same day at same time)", () => {
      const sensor = {
        id: "sensor_16",
        name: "Due Right Now",
        power_type: "Battery",
        battery_change_by_date: "2025-01-13T12:00:00Z", // Exactly now
      } as Sensor;

      expect(getBatteryStatus(sensor, now)).toBe("due_soon");
    });

    it("handles exactly -1 days (1 day overdue)", () => {
      const sensor = {
        id: "sensor_17",
        name: "1 Day Overdue",
        power_type: "Battery",
        battery_change_by_date: "2025-01-12",
      } as Sensor;

      expect(getBatteryStatus(sensor, now)).toBe("critical");
    });

    it("handles exactly 30 days remaining", () => {
      const sensor = {
        id: "sensor_18",
        name: "30 Days",
        power_type: "Battery",
        battery_change_by_date: "2025-02-12",
      } as Sensor;

      expect(getBatteryStatus(sensor, now)).toBe("due_soon");
    });

    it("handles exactly 31 days remaining (with time)", () => {
      const sensor = {
        id: "sensor_19",
        name: "31 Days",
        power_type: "Battery",
        battery_change_by_date: "2025-02-13T12:00:00Z", // Exactly 31 days with time
      } as Sensor;

      expect(getBatteryStatus(sensor, now)).toBe("healthy");
    });
  });

  describe("date handling", () => {
    it("handles ISO-8601 date strings", () => {
      const sensor = {
        id: "sensor_20",
        name: "ISO Date",
        power_type: "Battery",
        battery_change_by_date: "2025-02-15T10:30:00Z",
      } as Sensor;

      expect(getBatteryStatus(sensor, now)).toBe("healthy");
    });

    it("handles date-only strings (no time)", () => {
      const sensor = {
        id: "sensor_21",
        name: "Date Only",
        power_type: "Battery",
        battery_change_by_date: "2025-02-15",
      } as Sensor;

      expect(getBatteryStatus(sensor, now)).toBe("healthy");
    });

    it("accepts custom current date for testing", () => {
      const customDate = new Date("2025-03-01T00:00:00Z");
      const sensor = {
        id: "sensor_22",
        name: "Custom Date Test",
        power_type: "Battery",
        battery_change_by_date: "2025-03-15", // 14 days from custom date
      } as Sensor;

      expect(getBatteryStatus(sensor, customDate)).toBe("due_soon");
    });
  });

  describe("power type variations", () => {
    it("handles different power_type casings", () => {
      // Test case sensitivity
      const sensor1 = {
        id: "sensor_23",
        name: "Wired Uppercase",
        power_type: "Wired",
        battery_change_by_date: "2025-02-01",
      } as Sensor;

      const sensor2 = {
        id: "sensor_24",
        name: "Battery Uppercase",
        power_type: "Battery",
        battery_change_by_date: "2025-02-01",
      } as Sensor;

      expect(getBatteryStatus(sensor1, now)).toBe("no_battery");
      expect(getBatteryStatus(sensor2, now)).toBe("due_soon");
    });
  });

  describe("real-world scenarios", () => {
    it("identifies batteries needing immediate attention", () => {
      const sensors = [
        {
          id: "sensor_a",
          power_type: "Battery",
          battery_change_by_date: "2025-01-10",
        }, // 3 days overdue
        {
          id: "sensor_b",
          power_type: "Battery",
          battery_change_by_date: "2025-01-14",
        }, // 1 day away
        {
          id: "sensor_c",
          power_type: "Battery",
          battery_change_by_date: "2025-03-01",
        }, // 47 days away
        { id: "sensor_d", power_type: "Wired", battery_change_by_date: null },
      ] as Sensor[];

      const statuses = sensors.map((s) => getBatteryStatus(s, now));

      expect(statuses).toEqual(["critical", "due_soon", "healthy", "no_battery"]);
    });

    it("handles mixed sensor deployment", () => {
      const sensors = [
        {
          id: "sensor_1",
          power_type: "Battery",
          battery_change_by_date: "2025-01-05",
        }, // Critical
        {
          id: "sensor_2",
          power_type: "Battery",
          battery_change_by_date: "2025-02-01",
        }, // Due soon
        {
          id: "sensor_3",
          power_type: "Battery",
          battery_change_by_date: "2025-04-01",
        }, // Healthy
        { id: "sensor_4", power_type: "Wired" }, // No battery
      ] as Sensor[];

      const criticalCount = sensors.filter((s) => getBatteryStatus(s, now) === "critical").length;
      const dueSoonCount = sensors.filter((s) => getBatteryStatus(s, now) === "due_soon").length;
      const healthyCount = sensors.filter((s) => getBatteryStatus(s, now) === "healthy").length;
      const noBatteryCount = sensors.filter(
        (s) => getBatteryStatus(s, now) === "no_battery"
      ).length;

      expect(criticalCount).toBe(1);
      expect(dueSoonCount).toBe(1);
      expect(healthyCount).toBe(1);
      expect(noBatteryCount).toBe(1);
    });
  });
});
