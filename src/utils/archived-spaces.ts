/**
 * Helpers for archived rooms/zones and replaced-space links.
 *
 * An archived space was retired but kept for its history: it has no sensors,
 * produces no live data, and stays out of floor totals and room/zone counts.
 * It stays findable by name, because users ask for old rooms by name. A space
 * with `replacesID` set superseded another of the same kind (for example a
 * "_V2" room re-drawn under the sensors of an old "Pilot - ..." room); its
 * series starts at the switch-over, and earlier history lives under the
 * predecessor's own ID. Series are not merged.
 */

import type { ArchivableSpace, Floor, Room, Zone } from "../clients/types.js";

/** A space referenced from another one's lifecycle fields. */
export interface SpaceRef {
  id: string;
  /** Absent when the referenced space is not in the fetched topology. */
  name?: string;
  /** RFC 3339; present only when the referenced space is archived. */
  archived_at?: string;
}

/** Whether a room or zone is archived. Absent/null `archivedAt` = active. */
export function isArchived(space: ArchivableSpace | null | undefined): boolean {
  return Boolean(space?.archivedAt);
}

/**
 * Calendar date (YYYY-MM-DD) of an archive time in the site's timezone, so a
 * room archived on a Pacific evening is not reported as archived the next
 * (UTC) day. An unparseable value is returned as-is rather than dropped.
 */
export function formatArchiveDate(archivedAt: string, timezone: string = "UTC"): string {
  const date = new Date(archivedAt);
  if (Number.isNaN(date.getTime())) return archivedAt;
  const format = (timeZone: string) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);
  try {
    return format(timezone);
  } catch {
    return format("UTC");
  }
}

/** Display name with an "(archived YYYY-MM-DD)" suffix for archived spaces. */
export function archivedDisplayName(
  name: string,
  space: ArchivableSpace | null | undefined,
  timezone?: string
): string {
  if (!space?.archivedAt) return name;
  return `${name} (archived ${formatArchiveDate(space.archivedAt, timezone)})`;
}

/** Find a room or zone (by kind) anywhere in the topology. */
export function findSpace(
  floors: Floor[],
  kind: "room" | "zone",
  id: string
): Room | Zone | undefined {
  for (const floor of floors) {
    const list: Array<Room | Zone> = (kind === "room" ? floor.rooms : floor.zones) ?? [];
    const match = list.find((s) => s.id === id);
    if (match) return match;
  }
  return undefined;
}

/** Spaces of the same kind whose `replacesID` points at `id` (a split yields several). */
export function findReplacements(
  floors: Floor[],
  kind: "room" | "zone",
  id: string
): Array<Room | Zone> {
  const out: Array<Room | Zone> = [];
  for (const floor of floors) {
    const list: Array<Room | Zone> = (kind === "room" ? floor.rooms : floor.zones) ?? [];
    for (const s of list) if (s.replacesID === id) out.push(s);
  }
  return out;
}

/** Project a space (or a bare ID that did not resolve) to a SpaceRef. */
export function toSpaceRef(id: string, space: (Room | Zone) | undefined): SpaceRef {
  return {
    id,
    ...(space?.name ? { name: space.name } : {}),
    ...(space?.archivedAt ? { archived_at: space.archivedAt } : {}),
  };
}

/** `"Name" (id)` when the name is known, else the bare ID. */
export function describeSpaceRef(ref: SpaceRef): string {
  return ref.name ? `"${ref.name}" (${ref.id})` : ref.id;
}
