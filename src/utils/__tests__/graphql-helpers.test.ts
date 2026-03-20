import { describe, it, expect } from "vitest";
import { rethrowIfGraphQLError, isProductionSensor, isProductionHive } from "../graphql-helpers.js";
import type { Sensor, Hive } from "../../clients/types.js";

// ---------------------------------------------------------------------------
// Minimal fixtures — use `as any` to avoid filling every required field
// ---------------------------------------------------------------------------

function makeSensor(overrides: Partial<Sensor>): Sensor {
  return { id: "s-1", name: "Sensor 1", mac_address: "aa:bb:cc:dd:ee:ff", ...overrides } as any;
}

function makeHive(overrides: Partial<Hive>): Hive {
  return { id: "h-1", name: "Hive 1", serialNumber: "SN-12345", ...overrides } as any;
}

// ---------------------------------------------------------------------------
// rethrowIfGraphQLError
// ---------------------------------------------------------------------------

describe("rethrowIfGraphQLError", () => {
  describe("non-GraphQL values pass through (no throw)", () => {
    it("does not throw for a plain Error", () => {
      expect(() => rethrowIfGraphQLError(new Error("plain error"))).not.toThrow();
    });

    it("does not throw for a string", () => {
      expect(() => rethrowIfGraphQLError("string error")).not.toThrow();
    });

    it("does not throw for null", () => {
      expect(() => rethrowIfGraphQLError(null)).not.toThrow();
    });

    it("does not throw for undefined", () => {
      expect(() => rethrowIfGraphQLError(undefined)).not.toThrow();
    });

    it("does not throw for a plain object without GraphQL keys", () => {
      expect(() => rethrowIfGraphQLError({ message: "oops" })).not.toThrow();
    });
  });

  describe("graphQLErrors triggers formatted throw", () => {
    it("throws with formatted message for graphQLErrors", () => {
      const error = {
        graphQLErrors: [{ message: "Field 'x' not found" }],
      };
      expect(() => rethrowIfGraphQLError(error)).toThrow();
    });

    it("includes the GraphQL error message in the thrown error", () => {
      const error = {
        graphQLErrors: [{ message: "Syntax error in query" }],
      };
      expect(() => rethrowIfGraphQLError(error)).toThrow(/Syntax error in query/);
    });
  });

  describe("networkError triggers formatted throw", () => {
    it("throws with formatted message for networkError", () => {
      const error = {
        networkError: { statusCode: 500, message: "Internal Server Error" },
      };
      expect(() => rethrowIfGraphQLError(error)).toThrow();
    });

    it("produces AUTH_EXPIRED message for 401 statusCode", () => {
      const error = {
        networkError: { statusCode: 401, message: "Unauthorized" },
      };
      expect(() => rethrowIfGraphQLError(error)).toThrow(/AUTH_EXPIRED/);
    });

    it("produces AUTH_EXPIRED message for 403 statusCode", () => {
      const error = {
        networkError: { statusCode: 403, message: "Forbidden" },
      };
      expect(() => rethrowIfGraphQLError(error)).toThrow(/AUTH_EXPIRED/);
    });

    it("produces RATE_LIMITED message for 429 statusCode", () => {
      const error = {
        networkError: {
          statusCode: 429,
          message: "Too Many Requests",
          response: { headers: { get: () => "30" } },
        },
      };
      expect(() => rethrowIfGraphQLError(error)).toThrow(/RATE_LIMITED/);
    });
  });
});

// ---------------------------------------------------------------------------
// isProductionSensor
// ---------------------------------------------------------------------------

describe("isProductionSensor", () => {
  it("returns true for a sensor with a valid mac_address", () => {
    expect(isProductionSensor(makeSensor({ mac_address: "aa:bb:cc:dd:ee:ff" }))).toBe(true);
  });

  it("returns false for a sensor with mac_address starting with 'mi-rr-or'", () => {
    expect(isProductionSensor(makeSensor({ mac_address: "mi-rr-or:12:34:56" }))).toBe(false);
  });

  it("returns false for a sensor with mac_address starting with 'fa-ke'", () => {
    expect(isProductionSensor(makeSensor({ mac_address: "fa-ke:ab:cd:ef" }))).toBe(false);
  });

  it("returns false for a sensor with an empty mac_address", () => {
    expect(isProductionSensor(makeSensor({ mac_address: "" }))).toBe(false);
  });

  it("returns false for a sensor with whitespace-only mac_address", () => {
    expect(isProductionSensor(makeSensor({ mac_address: "   " }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isProductionHive
// ---------------------------------------------------------------------------

describe("isProductionHive", () => {
  it("returns true for a hive with a valid serialNumber", () => {
    expect(isProductionHive(makeHive({ serialNumber: "SN-12345" }))).toBe(true);
  });

  it("returns false for a hive with serialNumber starting with 'fake' (lowercase)", () => {
    expect(isProductionHive(makeHive({ serialNumber: "fake-hive-001" }))).toBe(false);
  });

  it("returns false for a hive with serialNumber starting with 'FAKE' (uppercase)", () => {
    expect(isProductionHive(makeHive({ serialNumber: "FAKE-HIVE-002" }))).toBe(false);
  });

  it("returns false for a hive with serialNumber starting with 'Fake' (mixed case)", () => {
    expect(isProductionHive(makeHive({ serialNumber: "Fake123" }))).toBe(false);
  });

  it("returns false for a hive with an empty serialNumber", () => {
    expect(isProductionHive(makeHive({ serialNumber: "" }))).toBe(false);
  });

  it("returns false for a hive with whitespace-only serialNumber", () => {
    expect(isProductionHive(makeHive({ serialNumber: "   " }))).toBe(false);
  });
});
