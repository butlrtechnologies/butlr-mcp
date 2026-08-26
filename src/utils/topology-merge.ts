/**
 * Shared topology/device merge.
 *
 * Two tools need floors to carry their `sensors` and `hives` arrays:
 * `butlr_list_topology` renders them, and `butlr_search_assets` flattens them
 * into its search corpus. Keeping the merge in one place is what lets both
 * read the same `devicesMerged: true` cache entry.
 */

import type { Site, Sensor, Hive } from "../clients/types.js";

/**
 * Merge sensors and hives into topology structure.
 * Groups by floor_id and nests under appropriate floors.
 *
 * IN-PLACE MUTATION: assigns `floor.sensors` and `floor.hives` directly on
 * the input site tree (returned for chaining; no new array is allocated).
 * `setCachedTopology` reads from the same `sites` reference that this
 * function mutates — any caller that captures the pre-merge `sites` (via
 * Apollo cache-restore, structural clone, or fork-then-await) would
 * observe the un-merged shape and could write a device-incomplete tree
 * to the cache. If you change this to immutable assignment, audit the
 * cache write site to confirm it sees the merged result.
 */
export function mergeSensorsAndHivesIntoTopology(
  sites: Site[],
  allSensors: Sensor[],
  allHives: Hive[]
): Site[] {
  // Group sensors by floor_id
  const sensorsByFloor: Record<string, Sensor[]> = {};
  for (const sensor of allSensors) {
    const floorId = sensor.floor_id || sensor.floorID;
    if (floorId) {
      if (!sensorsByFloor[floorId]) {
        sensorsByFloor[floorId] = [];
      }
      sensorsByFloor[floorId].push(sensor);
    }
  }

  // Group hives by floor_id
  const hivesByFloor: Record<string, Hive[]> = {};
  for (const hive of allHives) {
    const floorId = hive.floor_id || hive.floorID;
    if (floorId) {
      if (!hivesByFloor[floorId]) {
        hivesByFloor[floorId] = [];
      }
      hivesByFloor[floorId].push(hive);
    }
  }

  // Merge into topology
  for (const site of sites) {
    for (const building of site.buildings || []) {
      for (const floor of building.floors || []) {
        // Add sensors and hives to this floor
        floor.sensors = sensorsByFloor[floor.id] || [];
        floor.hives = hivesByFloor[floor.id] || [];
      }
    }
  }

  return sites;
}
