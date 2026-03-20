/**
 * Tree formatter for topology visualization
 * Formats organizational hierarchy in a tree structure with depth control
 *
 * ULTRA-COMPACT FORMAT: Positional arrays [id, display_identifier, children?]
 * - Position 0: Asset ID
 * - Position 1: Display identifier (name for sites/buildings/floors/rooms/zones, serialNumber for hives, mac_address for sensors)
 * - Position 2: Children array (optional, only if has children)
 */

import type { Site, Building, Floor, Room, Zone, Sensor, Hive } from "../clients/types.js";
import type { TopologyNode } from "../types/responses.js";

/**
 * Depth level mappings
 */
const DEPTH_LEVELS = {
  SITE: 0,
  BUILDING: 1,
  FLOOR: 2,
  ROOM_ZONE: 3,
  HIVE: 4,
  SENSOR: 5,
};

/**
 * Determine whether children should be included at the current depth level.
 */
function shouldTraverse(
  currentDepth: number,
  startingDepth: number,
  traversalDepth: number
): boolean {
  return currentDepth >= startingDepth && currentDepth - startingDepth < traversalDepth;
}

/**
 * Format topology as a tree structure with depth controls
 * Hierarchy: Sites(0) -> Buildings(1) -> Floors(2) -> Rooms/Zones(3) -> Hives(4) -> Sensors(5)
 * Format: [id, display_name, children?]
 *
 * @param sites Array of sites with full topology
 * @param startingDepth Depth level to start showing (0=sites, 1=buildings, etc.)
 * @param traversalDepth How many levels below starting_depth to traverse (0=starting level only)
 * @returns Ultra-compact array tree structure
 */
export function formatTopologyTree(
  sites: Site[],
  startingDepth: number = 0,
  traversalDepth: number = 0
): TopologyNode[] {
  const currentDepth = DEPTH_LEVELS.SITE;

  // If starting depth is 0 (sites), format sites
  if (startingDepth === 0) {
    return sites.map((site) => formatSite(site, currentDepth, startingDepth, traversalDepth));
  }

  // Otherwise, collect assets at starting depth from all sites
  return collectAssetsAtDepth(sites, startingDepth, traversalDepth);
}

/**
 * Collect all assets at a specific depth level
 */
function collectAssetsAtDepth(
  sites: Site[],
  targetDepth: number,
  traversalDepth: number
): TopologyNode[] {
  const results: TopologyNode[] = [];

  for (const site of sites) {
    if (targetDepth === DEPTH_LEVELS.BUILDING) {
      // Collect buildings
      site.buildings?.forEach((building: Building) => {
        results.push(formatBuilding(building, DEPTH_LEVELS.BUILDING, targetDepth, traversalDepth));
      });
    } else if (targetDepth === DEPTH_LEVELS.FLOOR) {
      // Collect floors
      site.buildings?.forEach((building: Building) => {
        building.floors?.forEach((floor: Floor) => {
          results.push(formatFloor(floor, DEPTH_LEVELS.FLOOR, targetDepth, traversalDepth));
        });
      });
    } else if (targetDepth === DEPTH_LEVELS.ROOM_ZONE) {
      // Collect rooms and zones
      site.buildings?.forEach((building: Building) => {
        building.floors?.forEach((floor: Floor) => {
          floor.rooms?.forEach((room: Room) => {
            results.push(
              formatRoom(room, floor, DEPTH_LEVELS.ROOM_ZONE, targetDepth, traversalDepth)
            );
          });
          floor.zones?.forEach((zone: Zone) => {
            results.push(formatZone(zone));
          });
        });
      });
    } else if (targetDepth === DEPTH_LEVELS.HIVE) {
      // Collect hives
      site.buildings?.forEach((building: Building) => {
        building.floors?.forEach((floor: Floor) => {
          floor.hives?.forEach((hive: Hive) => {
            results.push(formatHive(hive, floor, DEPTH_LEVELS.HIVE, targetDepth, traversalDepth));
          });
        });
      });
    } else if (targetDepth === DEPTH_LEVELS.SENSOR) {
      // Collect sensors
      site.buildings?.forEach((building: Building) => {
        building.floors?.forEach((floor: Floor) => {
          floor.sensors?.forEach((sensor: Sensor) => {
            results.push(formatSensor(sensor));
          });
        });
      });
    }
  }

  return results;
}

/**
 * Format a single site
 * Returns: [id, name, children?]
 */
function formatSite(
  site: Site,
  currentDepth: number,
  startingDepth: number,
  traversalDepth: number
): TopologyNode {
  const includeChildren = shouldTraverse(currentDepth, startingDepth, traversalDepth);

  if (includeChildren && site.buildings && site.buildings.length > 0) {
    const children = site.buildings.map((building: Building) =>
      formatBuilding(building, DEPTH_LEVELS.BUILDING, startingDepth, traversalDepth)
    );
    return [site.id, site.name, children];
  }

  return [site.id, site.name];
}

/**
 * Format a single building
 * Returns: [id, name, children?]
 */
function formatBuilding(
  building: Building,
  currentDepth: number,
  startingDepth: number,
  traversalDepth: number
): TopologyNode {
  const includeChildren = shouldTraverse(currentDepth, startingDepth, traversalDepth);

  if (includeChildren && building.floors && building.floors.length > 0) {
    const children = building.floors.map((floor: Floor) =>
      formatFloor(floor, DEPTH_LEVELS.FLOOR, startingDepth, traversalDepth)
    );
    return [building.id, building.name, children];
  }

  return [building.id, building.name];
}

/**
 * Format a single floor
 * Returns: [id, name, children?]
 */
function formatFloor(
  floor: Floor,
  currentDepth: number,
  startingDepth: number,
  traversalDepth: number
): TopologyNode {
  const includeChildren = shouldTraverse(currentDepth, startingDepth, traversalDepth);

  if (!includeChildren) {
    return [floor.id, floor.name];
  }

  const children: TopologyNode[] = [];

  // Add rooms
  if (floor.rooms && floor.rooms.length > 0) {
    children.push(
      ...floor.rooms.map((room: Room) =>
        formatRoom(room, floor, DEPTH_LEVELS.ROOM_ZONE, startingDepth, traversalDepth)
      )
    );
  }

  // Add floor-level zones (no room assignment)
  if (floor.zones && floor.zones.length > 0) {
    const floorLevelZones = floor.zones.filter((zone: Zone) => !(zone.roomID || zone.room_id));
    children.push(...floorLevelZones.map((zone: Zone) => formatZone(zone)));
  }

  // Add floor-level hives (no room assignment)
  if (floor.hives && floor.hives.length > 0) {
    const floorLevelHives = floor.hives.filter((hive: Hive) => !(hive.roomID || hive.room_id));
    children.push(
      ...floorLevelHives.map((hive: Hive) =>
        formatHive(hive, floor, DEPTH_LEVELS.HIVE, startingDepth, traversalDepth)
      )
    );
  }

  // Add floor-level orphan sensors (only if depth allows)
  const shouldIncludeSensors = DEPTH_LEVELS.SENSOR - startingDepth <= traversalDepth;
  if (shouldIncludeSensors) {
    const floorOrphans = getOrphanSensors(floor, null);
    if (floorOrphans.length > 0) {
      // Orphan group: ["orphan", "Orphan (no parent hive)", [sensors]]
      children.push([
        "orphan",
        "Orphan (no parent hive)",
        floorOrphans.map((sensor: Sensor) => formatSensor(sensor)),
      ]);
    }
  }

  if (children.length > 0) {
    return [floor.id, floor.name, children];
  }

  return [floor.id, floor.name];
}

/**
 * Format a single room
 * Returns: [id, name, children?]
 */
function formatRoom(
  room: Room,
  floor: Floor,
  currentDepth: number,
  startingDepth: number,
  traversalDepth: number
): TopologyNode {
  const includeChildren = shouldTraverse(currentDepth, startingDepth, traversalDepth);

  if (!includeChildren) {
    return [room.id, room.name];
  }

  const children: TopologyNode[] = [];

  // Add zones belonging to this room (zones at room level, not separate depth)
  if (floor.zones && floor.zones.length > 0) {
    const roomZones = floor.zones.filter((zone: Zone) => (zone.roomID || zone.room_id) === room.id);
    children.push(...roomZones.map((zone: Zone) => formatZone(zone)));
  }

  // Add hives belonging to this room
  if (floor.hives && floor.hives.length > 0) {
    const roomHives = floor.hives.filter((hive: Hive) => (hive.roomID || hive.room_id) === room.id);
    children.push(
      ...roomHives.map((hive: Hive) =>
        formatHive(hive, floor, DEPTH_LEVELS.HIVE, startingDepth, traversalDepth)
      )
    );
  }

  // Add orphan sensors belonging to this room (only if depth allows)
  const shouldIncludeSensors = DEPTH_LEVELS.SENSOR - startingDepth <= traversalDepth;
  if (shouldIncludeSensors) {
    const roomOrphans = getOrphanSensors(floor, room.id);
    if (roomOrphans.length > 0) {
      // Orphan group: ["orphan", "Orphan (no parent hive)", [sensors]]
      children.push([
        "orphan",
        "Orphan (no parent hive)",
        roomOrphans.map((sensor: Sensor) => formatSensor(sensor)),
      ]);
    }
  }

  if (children.length > 0) {
    return [room.id, room.name, children];
  }

  return [room.id, room.name];
}

/**
 * Format a single zone
 * Returns: [id, name]
 */
function formatZone(zone: Zone): TopologyNode {
  return [zone.id, zone.name];
}

/**
 * Format a single hive (with its sensors)
 * Returns: [id, serialNumber, children?]
 * NOTE: Uses serialNumber, NOT name (name is optional metadata)
 */
function formatHive(
  hive: Hive,
  floor: Floor,
  currentDepth: number,
  startingDepth: number,
  traversalDepth: number
): TopologyNode {
  const includeChildren = shouldTraverse(currentDepth, startingDepth, traversalDepth);

  // Find sensors belonging to this hive
  if (includeChildren && floor.sensors && floor.sensors.length > 0) {
    const hiveSensors = floor.sensors.filter(
      (sensor: Sensor) => sensor.hive_serial === hive.serialNumber
    );

    if (hiveSensors.length > 0) {
      const children = hiveSensors.map((sensor: Sensor) => formatSensor(sensor));
      return [hive.id, hive.serialNumber, children];
    }
  }

  return [hive.id, hive.serialNumber];
}

/**
 * Format a single sensor
 * Returns: [id, mac_address]
 * NOTE: Uses mac_address, NOT name (name is optional metadata)
 */
function formatSensor(sensor: Sensor): TopologyNode {
  return [sensor.id, sensor.mac_address];
}

/**
 * Get orphan sensors (sensors without a parent hive) for a room or floor
 * @param floor Floor object containing sensors and hives
 * @param roomID Room ID to filter by (null for floor-level)
 * @returns Array of orphan sensors
 */
function getOrphanSensors(floor: Floor, roomID: string | null): Sensor[] {
  if (!floor.sensors || floor.sensors.length === 0) {
    return [];
  }

  // Get all hive serial numbers
  const hiveSerials = new Set(floor.hives?.map((hive: Hive) => hive.serialNumber) || []);

  // Find sensors without a parent hive that belong to this room/floor
  return floor.sensors.filter((sensor: Sensor) => {
    const hasNoHive = !sensor.hive_serial || !hiveSerials.has(sensor.hive_serial);
    const sensorRoomID = sensor.roomID || sensor.room_id || null;
    const matchesLocation = sensorRoomID === roomID;
    return hasNoHive && matchesLocation;
  });
}
