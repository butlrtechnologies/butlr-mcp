/**
 * Utilities for flattening hierarchical topology into searchable lists
 */

import type { Site } from "../clients/types.js";

export interface FlattenedAsset {
  id: string;
  name: string;
  type: "site" | "building" | "floor" | "room" | "zone" | "sensor" | "hive";

  // Parent IDs for context
  site_id?: string;
  site_name?: string;
  building_id?: string;
  building_name?: string;
  floor_id?: string;
  floor_name?: string;
  room_id?: string;
  room_name?: string;

  // Type-specific fields (kept as-is)
  [key: string]: any;
}

/**
 * Flatten topology hierarchy into a searchable list
 */
export function flattenTopology(sites: Site[]): FlattenedAsset[] {
  const flattened: FlattenedAsset[] = [];

  for (const site of sites) {
    // Add site
    flattened.push({
      id: site.id,
      name: site.name,
      type: "site",
      timezone: site.timezone,
      siteNumber: site.siteNumber,
      customID: site.customID,
      org_id: site.org_id,
    });

    // Add buildings
    for (const building of site.buildings || []) {
      flattened.push({
        id: building.id,
        name: building.name,
        type: "building",
        site_id: site.id,
        site_name: site.name,
        building_number: building.building_number || building.buildingNumber,
        customID: building.customID,
        capacity: building.capacity,
        address: building.address,
      });

      // Add floors
      for (const floor of building.floors || []) {
        flattened.push({
          id: floor.id,
          name: floor.name,
          type: "floor",
          site_id: site.id,
          site_name: site.name,
          building_id: building.id,
          building_name: building.name,
          floorNumber: floor.floorNumber,
          customID: floor.customID,
          timezone: floor.timezone,
          installation_date: floor.installation_date,
          capacity: floor.capacity,
          area: floor.area,
        });

        // Add rooms
        for (const room of floor.rooms || []) {
          flattened.push({
            id: room.id,
            name: room.name,
            type: "room",
            site_id: site.id,
            site_name: site.name,
            building_id: building.id,
            building_name: building.name,
            floor_id: floor.id,
            floor_name: floor.name,
            roomType: room.roomType,
            customID: room.customID,
            capacity: room.capacity,
            area: room.area,
            coordinates: room.coordinates,
          });
        }

        // Add zones
        for (const zone of floor.zones || []) {
          flattened.push({
            id: zone.id,
            name: zone.name,
            type: "zone",
            site_id: site.id,
            site_name: site.name,
            building_id: building.id,
            building_name: building.name,
            floor_id: floor.id,
            floor_name: floor.name,
            room_id: zone.roomID,
            customID: zone.customID,
            capacity: zone.capacity,
            coordinates: zone.coordinates,
          });
        }

        // Add sensors
        for (const sensor of floor.sensors || []) {
          flattened.push({
            id: sensor.id,
            name: sensor.name,
            type: "sensor",
            site_id: site.id,
            site_name: site.name,
            building_id: building.id,
            building_name: building.name,
            floor_id: floor.id,
            floor_name: floor.name,
            room_id: sensor.roomID,
            mac_address: sensor.mac_address,
            mode: sensor.mode,
            model: sensor.model,
            hive_serial: sensor.hive_serial,
            is_online: sensor.is_online,
          });
        }

        // Add hives
        for (const hive of floor.hives || []) {
          flattened.push({
            id: hive.id,
            name: hive.name,
            type: "hive",
            site_id: site.id,
            site_name: site.name,
            building_id: building.id,
            building_name: building.name,
            floor_id: floor.id,
            floor_name: floor.name,
            room_id: hive.roomID,
            serialNumber: hive.serialNumber,
            is_online: hive.isOnline || hive.is_online,
            hiveVersion: hive.hiveVersion,
            coordinates: hive.coordinates,
          });
        }
      }
    }
  }

  return flattened;
}

/**
 * Filter flattened assets by type
 */
export function filterFlattenedByType(assets: FlattenedAsset[], types: string[]): FlattenedAsset[] {
  if (!types || types.length === 0) {
    return assets;
  }

  return assets.filter((asset) => types.includes(asset.type));
}
