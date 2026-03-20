/**
 * Tree formatter for topology visualization
 * Formats organizational hierarchy in a tree structure with depth control
 *
 * ULTRA-COMPACT FORMAT: Positional arrays [id, display_identifier, children?]
 * - Position 0: Asset ID
 * - Position 1: Display identifier (name for sites/buildings/floors/rooms/zones, serialNumber for hives, mac_address for sensors)
 * - Position 2: Children array (optional, only if has children)
 */

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
 * Format topology as a tree structure with depth controls
 * Hierarchy: Sites(0) → Buildings(1) → Floors(2) → Rooms/Zones(3) → Hives(4) → Sensors(5)
 * Format: [id, display_name, children?]
 *
 * @param sites Array of sites with full topology
 * @param startingDepth Depth level to start showing (0=sites, 1=buildings, etc.)
 * @param traversalDepth How many levels below starting_depth to traverse (0=starting level only)
 * @returns Ultra-compact array tree structure
 */
export function formatTopologyTree(
  sites: any[],
  startingDepth: number = 0,
  traversalDepth: number = 0
): any {
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
function collectAssetsAtDepth(sites: any[], targetDepth: number, traversalDepth: number): any[] {
  const results: any[] = [];

  for (const site of sites) {
    if (targetDepth === DEPTH_LEVELS.BUILDING) {
      // Collect buildings
      site.buildings?.forEach((building: any) => {
        results.push(formatBuilding(building, DEPTH_LEVELS.BUILDING, targetDepth, traversalDepth));
      });
    } else if (targetDepth === DEPTH_LEVELS.FLOOR) {
      // Collect floors
      site.buildings?.forEach((building: any) => {
        building.floors?.forEach((floor: any) => {
          results.push(formatFloor(floor, DEPTH_LEVELS.FLOOR, targetDepth, traversalDepth));
        });
      });
    } else if (targetDepth === DEPTH_LEVELS.ROOM_ZONE) {
      // Collect rooms and zones
      site.buildings?.forEach((building: any) => {
        building.floors?.forEach((floor: any) => {
          floor.rooms?.forEach((room: any) => {
            results.push(
              formatRoom(room, floor, DEPTH_LEVELS.ROOM_ZONE, targetDepth, traversalDepth)
            );
          });
          floor.zones?.forEach((zone: any) => {
            results.push(formatZone(zone, DEPTH_LEVELS.ROOM_ZONE, targetDepth, traversalDepth));
          });
        });
      });
    } else if (targetDepth === DEPTH_LEVELS.HIVE) {
      // Collect hives
      site.buildings?.forEach((building: any) => {
        building.floors?.forEach((floor: any) => {
          floor.hives?.forEach((hive: any) => {
            results.push(formatHive(hive, floor, DEPTH_LEVELS.HIVE, targetDepth, traversalDepth));
          });
        });
      });
    } else if (targetDepth === DEPTH_LEVELS.SENSOR) {
      // Collect sensors
      site.buildings?.forEach((building: any) => {
        building.floors?.forEach((floor: any) => {
          floor.sensors?.forEach((sensor: any) => {
            results.push(formatSensor(sensor, DEPTH_LEVELS.SENSOR, targetDepth, traversalDepth));
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
  site: any,
  currentDepth: number,
  startingDepth: number,
  traversalDepth: number
): any[] {
  const result: any[] = [site.id, site.name];

  // Check if we should include children
  const shouldIncludeChildren =
    currentDepth >= startingDepth && currentDepth - startingDepth < traversalDepth;

  if (shouldIncludeChildren && site.buildings && site.buildings.length > 0) {
    const children = site.buildings.map((building: any) =>
      formatBuilding(building, DEPTH_LEVELS.BUILDING, startingDepth, traversalDepth)
    );
    result.push(children);
  }

  return result;
}

/**
 * Format a single building
 * Returns: [id, name, children?]
 */
function formatBuilding(
  building: any,
  currentDepth: number,
  startingDepth: number,
  traversalDepth: number
): any[] {
  const result: any[] = [building.id, building.name];

  const shouldIncludeChildren =
    currentDepth >= startingDepth && currentDepth - startingDepth < traversalDepth;

  if (shouldIncludeChildren && building.floors && building.floors.length > 0) {
    const children = building.floors.map((floor: any) =>
      formatFloor(floor, DEPTH_LEVELS.FLOOR, startingDepth, traversalDepth)
    );
    result.push(children);
  }

  return result;
}

/**
 * Format a single floor
 * Returns: [id, name, children?]
 */
function formatFloor(
  floor: any,
  currentDepth: number,
  startingDepth: number,
  traversalDepth: number
): any[] {
  const result: any[] = [floor.id, floor.name];

  const shouldIncludeChildren =
    currentDepth >= startingDepth && currentDepth - startingDepth < traversalDepth;

  if (!shouldIncludeChildren) {
    return result;
  }

  const children: any[] = [];

  // Add rooms
  if (floor.rooms && floor.rooms.length > 0) {
    children.push(
      ...floor.rooms.map((room: any) =>
        formatRoom(room, floor, DEPTH_LEVELS.ROOM_ZONE, startingDepth, traversalDepth)
      )
    );
  }

  // Add floor-level zones (no room assignment)
  if (floor.zones && floor.zones.length > 0) {
    const floorLevelZones = floor.zones.filter((zone: any) => !(zone.roomID || zone.room_id));
    children.push(
      ...floorLevelZones.map((zone: any) =>
        formatZone(zone, DEPTH_LEVELS.ROOM_ZONE, startingDepth, traversalDepth)
      )
    );
  }

  // Add floor-level hives (no room assignment)
  if (floor.hives && floor.hives.length > 0) {
    const floorLevelHives = floor.hives.filter((hive: any) => !(hive.roomID || hive.room_id));
    children.push(
      ...floorLevelHives.map((hive: any) =>
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
        floorOrphans.map((sensor: any) =>
          formatSensor(sensor, DEPTH_LEVELS.SENSOR, startingDepth, traversalDepth)
        ),
      ]);
    }
  }

  if (children.length > 0) {
    result.push(children);
  }

  return result;
}

/**
 * Format a single room
 * Returns: [id, name, children?]
 */
function formatRoom(
  room: any,
  floor: any,
  currentDepth: number,
  startingDepth: number,
  traversalDepth: number
): any[] {
  const result: any[] = [room.id, room.name];

  const shouldIncludeChildren =
    currentDepth >= startingDepth && currentDepth - startingDepth < traversalDepth;

  if (!shouldIncludeChildren) {
    return result;
  }

  const children: any[] = [];

  // Add zones belonging to this room (zones at room level, not separate depth)
  if (floor.zones && floor.zones.length > 0) {
    const roomZones = floor.zones.filter((zone: any) => (zone.roomID || zone.room_id) === room.id);
    children.push(
      ...roomZones.map((zone: any) => formatZone(zone, currentDepth, startingDepth, traversalDepth))
    );
  }

  // Add hives belonging to this room
  if (floor.hives && floor.hives.length > 0) {
    const roomHives = floor.hives.filter((hive: any) => (hive.roomID || hive.room_id) === room.id);
    children.push(
      ...roomHives.map((hive: any) =>
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
        roomOrphans.map((sensor: any) =>
          formatSensor(sensor, DEPTH_LEVELS.SENSOR, startingDepth, traversalDepth)
        ),
      ]);
    }
  }

  if (children.length > 0) {
    result.push(children);
  }

  return result;
}

/**
 * Format a single zone
 * Returns: [id, name]
 */
function formatZone(
  zone: any,
  _currentDepth: number,
  _startingDepth: number,
  _traversalDepth: number
): any[] {
  return [zone.id, zone.name];
}

/**
 * Format a single hive (with its sensors)
 * Returns: [id, serialNumber, children?]
 * NOTE: Uses serialNumber, NOT name (name is optional metadata)
 */
function formatHive(
  hive: any,
  floor: any,
  currentDepth: number,
  startingDepth: number,
  traversalDepth: number
): any[] {
  const result: any[] = [hive.id, hive.serialNumber];

  const shouldIncludeChildren =
    currentDepth >= startingDepth && currentDepth - startingDepth < traversalDepth;

  // Find sensors belonging to this hive
  if (shouldIncludeChildren && floor.sensors && floor.sensors.length > 0) {
    const hiveSensors = floor.sensors.filter(
      (sensor: any) => sensor.hive_serial === hive.serialNumber
    );

    if (hiveSensors.length > 0) {
      const children = hiveSensors.map((sensor: any) =>
        formatSensor(sensor, DEPTH_LEVELS.SENSOR, startingDepth, traversalDepth)
      );
      result.push(children);
    }
  }

  return result;
}

/**
 * Format a single sensor
 * Returns: [id, mac_address]
 * NOTE: Uses mac_address, NOT name (name is optional metadata)
 */
function formatSensor(
  sensor: any,
  _currentDepth: number,
  _startingDepth: number,
  _traversalDepth: number
): any[] {
  return [sensor.id, sensor.mac_address];
}

/**
 * Get orphan sensors (sensors without a parent hive) for a room or floor
 * @param floor Floor object containing sensors and hives
 * @param roomID Room ID to filter by (null for floor-level)
 * @returns Array of orphan sensors
 */
function getOrphanSensors(floor: any, roomID: string | null): any[] {
  if (!floor.sensors || floor.sensors.length === 0) {
    return [];
  }

  // Get all hive serial numbers
  const hiveSerials = new Set(floor.hives?.map((hive: any) => hive.serialNumber) || []);

  // Find sensors without a parent hive that belong to this room/floor
  return floor.sensors.filter((sensor: any) => {
    const hasNoHive = !sensor.hive_serial || !hiveSerials.has(sensor.hive_serial);
    const sensorRoomID = sensor.roomID || sensor.room_id;
    const matchesLocation = sensorRoomID === roomID;
    return hasNoHive && matchesLocation;
  });
}
