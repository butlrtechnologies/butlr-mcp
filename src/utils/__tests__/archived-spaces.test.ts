import { describe, it, expect } from "vitest";
import {
  archivedDisplayName,
  describeSpaceRef,
  indexReplacements,
  findSpace,
  formatArchiveDate,
  isRetired,
  toSpaceRef,
} from "../archived-spaces.js";
import type { Floor } from "../../clients/types.js";

const floors = [
  {
    id: "space_7",
    name: "Floor 07",
    rooms: [
      { id: "room_old", name: "Pilot - Drop In", archivedAt: "2026-10-21T01:30:00Z" },
      { id: "room_v2a", name: "Drop In_V2", replacesID: "room_old" },
      { id: "room_v2b", name: "Focus_V2", replacesID: "room_old" },
      { id: "room_live", name: "Lounge", archivedAt: null },
    ],
    zones: [{ id: "zone_old", name: "Desk Zone", archivedAt: "2026-10-20T12:00:00Z" }],
  },
] as unknown as Floor[];

describe("archived-spaces", () => {
  it("retires only a space with no sensors that is archived or had its sensors removed", () => {
    expect(isRetired({ archivedAt: null }, 0)).toBe(false);
    expect(isRetired({}, 0)).toBe(false);
    expect(isRetired(undefined, 0)).toBe(false);
    expect(isRetired({ archivedAt: "2026-10-21T01:30:00Z" }, 0)).toBe(true);
    expect(isRetired({ sensorsRemovedAt: "2026-10-21T01:30:00Z" }, 0)).toBe(true);
    // Sensors present means live, whatever the dates say.
    expect(isRetired({ archivedAt: "2026-10-21T01:30:00Z" }, 1)).toBe(false);
    // Unknown sensor count is treated as live.
    expect(isRetired({ archivedAt: "2026-10-21T01:30:00Z" }, undefined)).toBe(false);
  });

  it("dates the archive in the site's timezone, not UTC", () => {
    // 01:30 UTC on the 21st is the evening of the 20th in Indianapolis.
    expect(formatArchiveDate("2026-10-21T01:30:00Z", "America/Indiana/Indianapolis")).toBe(
      "2026-10-20"
    );
    expect(formatArchiveDate("2026-10-21T01:30:00Z")).toBe("2026-10-21");
  });

  it("falls back to UTC for an invalid timezone and keeps unparseable input", () => {
    expect(formatArchiveDate("2026-10-21T01:30:00Z", "Not/AZone")).toBe("2026-10-21");
    expect(formatArchiveDate("yesterday")).toBe("yesterday");
  });

  it("suffixes only archived names", () => {
    expect(archivedDisplayName("Pilot - Drop In", floors[0].rooms![0], "UTC")).toBe(
      "Pilot - Drop In (archived 2026-10-21)"
    );
    expect(archivedDisplayName("Lounge", floors[0].rooms![3], "UTC")).toBe("Lounge");
  });

  it("finds spaces and their replacements by kind", () => {
    expect(findSpace(floors, "room", "room_old")?.name).toBe("Pilot - Drop In");
    expect(findSpace(floors, "zone", "room_old")).toBeUndefined();
    const index = indexReplacements(floors);
    expect((index.get("room_old") ?? []).map((r) => r.id)).toEqual(["room_v2a", "room_v2b"]);
    expect(index.get("zone_old")).toBeUndefined();
    // Memoized per floors array.
    expect(indexReplacements(floors)).toBe(index);
  });

  it("projects refs, keeping a bare ID when the space is not in the topology", () => {
    const old = toSpaceRef("room_old", findSpace(floors, "room", "room_old"));
    expect(old).toEqual({
      id: "room_old",
      name: "Pilot - Drop In",
      archived_at: "2026-10-21T01:30:00Z",
    });
    expect(describeSpaceRef(old)).toBe('"Pilot - Drop In" (room_old)');
    expect(toSpaceRef("room_gone", undefined)).toEqual({ id: "room_gone" });
    expect(describeSpaceRef({ id: "room_gone" })).toBe("room_gone");
  });
});
