import { describe, it, expect } from "vitest";
import {
  validateFields,
  getDefaultFields,
  getValidatedFields,
  ENTITY_TYPES,
  DEFAULT_FIELDS,
  type EntityType,
} from "../field-validator.js";

describe("validateFields", () => {
  describe("valid fields accepted", () => {
    it("accepts known fields for site", () => {
      expect(() => validateFields("site", ["id", "name", "timezone"])).not.toThrow();
    });

    it("accepts known fields for building", () => {
      expect(() => validateFields("building", ["id", "name", "capacity", "address"])).not.toThrow();
    });

    it("accepts known fields for floor", () => {
      expect(() =>
        validateFields("floor", ["id", "name", "floorNumber", "building_id", "capacity"])
      ).not.toThrow();
    });

    it("accepts known fields for room", () => {
      expect(() =>
        validateFields("room", ["id", "name", "floorID", "roomType", "capacity"])
      ).not.toThrow();
    });

    it("accepts known fields for zone", () => {
      expect(() =>
        validateFields("zone", ["id", "name", "floorID", "roomID", "capacity"])
      ).not.toThrow();
    });

    it("accepts known fields for sensor", () => {
      expect(() =>
        validateFields("sensor", ["id", "mac_address", "mode", "model", "is_online"])
      ).not.toThrow();
    });

    it("accepts known fields for hive", () => {
      expect(() =>
        validateFields("hive", ["id", "serialNumber", "isOnline", "hiveVersion"])
      ).not.toThrow();
    });

    it("accepts a single valid field", () => {
      expect(() => validateFields("room", ["id"])).not.toThrow();
    });

    it("accepts all valid fields for an entity type", () => {
      // room has: id, name, floorID, roomType, customID, capacity, area, coordinates, rotation, note, sensors, floor
      expect(() =>
        validateFields("room", [
          "id",
          "name",
          "floorID",
          "roomType",
          "customID",
          "capacity",
          "area",
          "coordinates",
          "rotation",
          "note",
          "sensors",
          "floor",
        ])
      ).not.toThrow();
    });
  });

  describe("invalid fields rejected", () => {
    it("throws for an unknown field name", () => {
      expect(() => validateFields("room", ["nonexistent"])).toThrow(/Invalid fields for room/);
    });

    it("throws and lists the invalid field name", () => {
      expect(() => validateFields("room", ["nonexistent"])).toThrow("nonexistent");
    });

    it("throws and lists valid fields in the error message", () => {
      expect(() => validateFields("room", ["badfield"])).toThrow(/Valid fields:/);
    });

    it("throws for a field valid on another entity type but not this one", () => {
      // mac_address is valid for sensor, not room
      expect(() => validateFields("room", ["mac_address"])).toThrow(/Invalid fields for room/);
    });

    it("throws when one field is valid and one is invalid", () => {
      expect(() => validateFields("room", ["id", "badfield"])).toThrow(/Invalid fields for room/);
      expect(() => validateFields("room", ["id", "badfield"])).toThrow("badfield");
    });

    it("throws for multiple invalid fields", () => {
      expect(() => validateFields("site", ["foo", "bar"])).toThrow(/Invalid fields for site/);
    });
  });

  describe("injection attempts blocked", () => {
    it("blocks newline injection in field names", () => {
      const malicious = "id\n} mutation { deleteAll { id";
      expect(() => validateFields("room", [malicious])).toThrow(/Invalid fields/);
    });

    it("blocks introspection field __typename", () => {
      expect(() => validateFields("room", ["__typename"])).toThrow(/Invalid fields/);
    });

    it("blocks comma injection in field names", () => {
      const malicious = "id, password";
      expect(() => validateFields("room", [malicious])).toThrow(/Invalid fields/);
    });

    it("blocks brace injection in field names", () => {
      const malicious = "id } mutation { x";
      expect(() => validateFields("room", [malicious])).toThrow(/Invalid fields/);
    });

    it("blocks field names with special characters", () => {
      expect(() => validateFields("room", ["id;DROP"])).toThrow(/Invalid fields/);
    });

    it("blocks field names with parentheses (function call injection)", () => {
      expect(() => validateFields("room", ["id(args: true)"])).toThrow(/Invalid fields/);
    });

    it("blocks empty string as a field name", () => {
      expect(() => validateFields("room", [""])).toThrow(/Invalid fields/);
    });

    it("blocks field names with only whitespace", () => {
      expect(() => validateFields("room", ["   "])).toThrow(/Invalid fields/);
    });

    it("blocks field names attempting directive injection", () => {
      expect(() => validateFields("room", ["id @skip(if: true)"])).toThrow(/Invalid fields/);
    });

    it("blocks field names with fragment spread syntax", () => {
      expect(() => validateFields("room", ["...on AdminUser { password }"])).toThrow(
        /Invalid fields/
      );
    });
  });

  describe("snake_case aliases", () => {
    it("normalizes floor_id to floorID and validates for room", () => {
      expect(() => validateFields("room", ["floor_id"])).not.toThrow();
    });

    it("normalizes room_id to roomID and validates for zone", () => {
      expect(() => validateFields("zone", ["room_id"])).not.toThrow();
    });

    it("normalizes hive_id to hiveID per FIELD_ALIASES", () => {
      // hive_id maps to "hiveID" -- not currently in any VALID_FIELDS list,
      // so this tests that normalization happens before validation rejects it
      expect(() => validateFields("hive", ["hive_id"])).toThrow(/Invalid fields/);
    });

    it("normalizes sensor_id to id (deprecated alias) and validates for sensor", () => {
      // sensor_id maps to "id" per FIELD_ALIASES
      expect(() => validateFields("sensor", ["sensor_id"])).not.toThrow();
    });

    it("rejects a snake_case alias used on an entity that does not have the target field", () => {
      // floor_id normalizes to floorID, but site does not have floorID
      expect(() => validateFields("site", ["floor_id"])).toThrow(/Invalid fields for site/);
    });
  });

  describe("unknown entity type", () => {
    it("throws for an unknown entity type", () => {
      expect(() => validateFields("admin" as EntityType, ["password"])).toThrow(
        /Unknown entity type: admin/
      );
    });

    it("includes valid types in the error message", () => {
      expect(() => validateFields("admin" as EntityType, ["password"])).toThrow(
        /Valid types:.*site/
      );
    });

    it("throws for empty string entity type", () => {
      expect(() => validateFields("" as EntityType, ["id"])).toThrow(/Unknown entity type/);
    });
  });
});

describe("getDefaultFields", () => {
  describe("returns correct defaults", () => {
    it("returns id and name for site", () => {
      expect(getDefaultFields("site")).toEqual(["id", "name"]);
    });

    it("returns id and name for building", () => {
      expect(getDefaultFields("building")).toEqual(["id", "name"]);
    });

    it("returns id, name, and floorNumber for floor", () => {
      expect(getDefaultFields("floor")).toEqual(["id", "name", "floorNumber"]);
    });

    it("returns id and name for room", () => {
      expect(getDefaultFields("room")).toEqual(["id", "name"]);
    });

    it("returns id and name for zone", () => {
      expect(getDefaultFields("zone")).toEqual(["id", "name"]);
    });

    it("returns id and mac_address for sensor", () => {
      expect(getDefaultFields("sensor")).toEqual(["id", "mac_address"]);
    });

    it("returns id and serialNumber for hive", () => {
      expect(getDefaultFields("hive")).toEqual(["id", "serialNumber"]);
    });

    it("returns a new array (not the original reference)", () => {
      const defaults1 = getDefaultFields("room");
      const defaults2 = getDefaultFields("room");
      expect(defaults1).toEqual(defaults2);
      expect(defaults1).not.toBe(defaults2); // Different array instances
    });
  });

  describe("unknown entity type throws", () => {
    it("throws for nonexistent entity type", () => {
      expect(() => getDefaultFields("nonexistent" as EntityType)).toThrow(
        /Unknown entity type: nonexistent/
      );
    });

    it("throws for undefined-like entity type", () => {
      expect(() => getDefaultFields("undefined" as EntityType)).toThrow(/Unknown entity type/);
    });
  });
});

describe("getValidatedFields", () => {
  describe("empty array returns defaults", () => {
    it("returns default fields when given an empty array for room", () => {
      expect(getValidatedFields("room", [])).toEqual(["id", "name"]);
    });

    it("returns default fields when given an empty array for sensor", () => {
      expect(getValidatedFields("sensor", [])).toEqual(["id", "mac_address"]);
    });

    it("returns default fields when given an empty array for floor", () => {
      expect(getValidatedFields("floor", [])).toEqual(["id", "name", "floorNumber"]);
    });
  });

  describe("undefined returns defaults", () => {
    it("returns default fields when requestedFields is undefined for room", () => {
      expect(getValidatedFields("room")).toEqual(["id", "name"]);
    });

    it("returns default fields when requestedFields is undefined for building", () => {
      expect(getValidatedFields("building")).toEqual(["id", "name"]);
    });

    it("returns default fields when requestedFields is undefined for hive", () => {
      expect(getValidatedFields("hive")).toEqual(["id", "serialNumber"]);
    });
  });

  describe("auto-includes id", () => {
    it('prepends "id" when not in requested fields for room', () => {
      expect(getValidatedFields("room", ["name"])).toEqual(["id", "name"]);
    });

    it('prepends "id" when not in requested fields for sensor', () => {
      expect(getValidatedFields("sensor", ["mac_address", "mode"])).toEqual([
        "id",
        "mac_address",
        "mode",
      ]);
    });

    it('prepends "id" when not in requested fields for site', () => {
      expect(getValidatedFields("site", ["name", "timezone"])).toEqual(["id", "name", "timezone"]);
    });
  });

  describe("doesn't duplicate id", () => {
    it('does not duplicate "id" when already present for room', () => {
      expect(getValidatedFields("room", ["id", "name"])).toEqual(["id", "name"]);
    });

    it('does not duplicate "id" when present at start for sensor', () => {
      expect(getValidatedFields("sensor", ["id", "mac_address"])).toEqual(["id", "mac_address"]);
    });

    it('does not duplicate "id" when present in middle for building', () => {
      expect(getValidatedFields("building", ["name", "id", "capacity"])).toEqual([
        "name",
        "id",
        "capacity",
      ]);
    });
  });

  describe("normalizes aliases", () => {
    it("normalizes floor_id to floorID and auto-includes id for room", () => {
      expect(getValidatedFields("room", ["floor_id"])).toEqual(["id", "floorID"]);
    });

    it("normalizes room_id to roomID and auto-includes id for zone", () => {
      expect(getValidatedFields("zone", ["room_id"])).toEqual(["id", "roomID"]);
    });

    it("normalizes sensor_id to id (no duplication) for sensor", () => {
      // sensor_id → id, so id is already present after normalization
      expect(getValidatedFields("sensor", ["sensor_id", "mac_address"])).toEqual([
        "id",
        "mac_address",
      ]);
    });

    it("normalizes mixed aliases and regular fields", () => {
      expect(getValidatedFields("zone", ["name", "floor_id", "room_id"])).toEqual([
        "id",
        "name",
        "floorID",
        "roomID",
      ]);
    });
  });

  describe("validates before returning", () => {
    it("throws for invalid fields even when some are valid", () => {
      expect(() => getValidatedFields("room", ["name", "badfield"])).toThrow(/Invalid fields/);
    });

    it("throws for unknown entity type", () => {
      expect(() => getValidatedFields("admin" as EntityType, ["id"])).toThrow(
        /Unknown entity type/
      );
    });
  });
});

describe("EntityType and ENTITY_TYPES exports", () => {
  it("contains all 7 expected entity types", () => {
    expect(ENTITY_TYPES).toHaveLength(7);
  });

  it("contains site, building, floor, room, zone, sensor, hive", () => {
    expect([...ENTITY_TYPES]).toEqual([
      "site",
      "building",
      "floor",
      "room",
      "zone",
      "sensor",
      "hive",
    ]);
  });

  it("each entity type has a DEFAULT_FIELDS entry", () => {
    for (const entityType of ENTITY_TYPES) {
      expect(DEFAULT_FIELDS[entityType]).toBeDefined();
      expect(DEFAULT_FIELDS[entityType].length).toBeGreaterThan(0);
    }
  });

  it("each entity type has id in its default fields", () => {
    for (const entityType of ENTITY_TYPES) {
      expect(DEFAULT_FIELDS[entityType]).toContain("id");
    }
  });
});
