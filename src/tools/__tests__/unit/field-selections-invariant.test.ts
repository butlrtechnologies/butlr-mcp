import { describe, it, expect } from "vitest";
import { FIELD_SELECTIONS } from "../../butlr-fetch-entity-details.js";
import { VALID_FIELDS, ENTITY_TYPES } from "../../../utils/field-validator.js";

/**
 * Object-typed (non-scalar) field names across all entity types in the
 * Butlr GraphQL schema. GraphQL rejects a query that selects one of these
 * without a subselection:
 *   `Field "X" of type "Y!" must have a selection of subfields.`
 *
 * When adding a new object-typed field to VALID_FIELDS, it MUST be added
 * BOTH to this set and to FIELD_SELECTIONS in butlr-fetch-entity-details.ts.
 * The tests below lock that invariant so a missing entry fails CI instead
 * of surfacing as a runtime INTERNAL_ERROR.
 *
 * Scalar-list fields (e.g. coordinates, center, orientation — number[])
 * do NOT belong here: they take no subselection.
 */
const OBJECT_TYPED_FIELDS = new Set([
  "capacity",
  "address",
  "area",
  "tags",
  "buildings",
  "floors",
  "rooms",
  "zones",
  "sensors",
  "hives",
  "site",
  "building",
  "floor",
]);

describe("FIELD_SELECTIONS ↔ VALID_FIELDS sync invariant", () => {
  it("every object-typed field in VALID_FIELDS has a FIELD_SELECTIONS entry", () => {
    for (const entityType of ENTITY_TYPES) {
      for (const field of VALID_FIELDS[entityType]) {
        if (OBJECT_TYPED_FIELDS.has(field)) {
          expect(
            FIELD_SELECTIONS[field],
            `"${field}" (object-typed, valid for ${entityType}) is missing from FIELD_SELECTIONS — ` +
              `it would be emitted without a subselection and the GraphQL API would reject the query`
          ).toBeDefined();
        }
      }
    }
  });

  it("every FIELD_SELECTIONS key is a known object-typed field", () => {
    // Guards the opposite direction: a scalar added to FIELD_SELECTIONS
    // would emit a subselection on a scalar, which GraphQL also rejects.
    for (const key of Object.keys(FIELD_SELECTIONS)) {
      expect(
        OBJECT_TYPED_FIELDS.has(key),
        `FIELD_SELECTIONS contains "${key}", which is not in the known object-typed field set — ` +
          `either it is a scalar (remove it) or a new object-typed field (add it to OBJECT_TYPED_FIELDS)`
      ).toBe(true);
    }
  });

  it("every FIELD_SELECTIONS key is used by at least one entity type", () => {
    // A stale entry is harmless at runtime but signals the two lists drifted.
    const allValidFields = new Set(ENTITY_TYPES.flatMap((t) => [...VALID_FIELDS[t]]));
    for (const key of Object.keys(FIELD_SELECTIONS)) {
      expect(
        allValidFields.has(key),
        `FIELD_SELECTIONS contains "${key}", but no entity type lists it in VALID_FIELDS`
      ).toBe(true);
    }
  });

  it("each FIELD_SELECTIONS value is a subselection on its own key", () => {
    // e.g. "capacity { max mid }" — the substitution must select the same
    // field it replaces, with a non-empty subselection.
    for (const [key, selection] of Object.entries(FIELD_SELECTIONS)) {
      expect(selection, `FIELD_SELECTIONS["${key}"] must be "${key} { …subfields }"`).toMatch(
        new RegExp(`^${key}\\s*\\{[^{}]+\\}$`)
      );
    }
  });
});
