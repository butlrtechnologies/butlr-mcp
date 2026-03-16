/**
 * TypeScript type definitions for Butlr GraphQL API
 * Based on GraphQL schemas from butlr-api-container
 */

export interface Capacity {
  max?: number;
  mid?: number;
}

export interface Address {
  lines?: string[];
  country?: string;
}

export interface MetaData {
  created_at?: number;
  updated_at?: number;
  deleted_at?: number;
}

export interface Area {
  value?: number;
  unit?: string;
}

/**
 * Site - Top level organizational unit (campus)
 */
export interface Site {
  id: string;
  name: string;
  timezone: string;
  org_id: string;
  siteNumber?: number;
  customID?: string;
  butlrCode?: string;
  buildings: Building[];
}

/**
 * Building - Physical structure containing floors
 */
export interface Building {
  id: string;
  name: string;
  site_id: string;
  building_number?: number;
  buildingNumber?: number; // Legacy field
  butlr_code?: string;
  capacity: Capacity;
  address?: Address;
  customID?: string;
  floors: Floor[];
  site: Site;
}

/**
 * Floor - Level within a building
 */
export interface Floor {
  id: string;
  name: string;
  building_id: string;
  floorNumber?: number;
  timezone: string;
  installation_date: number;
  installation_status?: string;
  service_status?: string;
  capacity: Capacity;
  area: Area;
  metadata: MetaData;
  customID?: string;
  butlrCode?: string;
  rooms?: Room[];
  zones?: Zone[];
  sensors?: Sensor[];
  hives?: Hive[];
  floor_plans?: FloorPlan[];
  building: Building;
}

/**
 * Room - Defined space within a floor
 */
export interface Room {
  id: string;
  name: string;
  floorID?: string; // camelCase (legacy)
  floor_id?: string; // snake_case (preferred)
  roomType?: string;
  capacity: Capacity;
  area: Area;
  coordinates?: number[][];
  rotation?: number;
  metadata: MetaData;
  customID?: string;
  note?: string;
  pir_zero_enable?: boolean;
  pir_zero_threshold?: number;
  pir_zero_window?: number;
  sensors?: Sensor[];
  floor: Floor;
}

/**
 * Zone - Sub-area within a floor or room
 */
export interface Zone {
  id: string;
  name: string;
  floorID?: string; // camelCase (legacy)
  floor_id?: string; // snake_case (preferred)
  roomID?: string; // camelCase (legacy)
  room_id?: string; // snake_case (preferred)
  capacity: Capacity;
  area: Area;
  coordinates?: number[][];
  rotation?: number;
  metadata: MetaData;
  customID?: string;
  note?: string;
  sensors?: Sensor[];
}

/**
 * Sensor - Individual detection device
 */
export interface Sensor {
  id: string;
  name: string;
  mac_address: string;
  mode: string;
  model: string;
  // Both field name formats supported (snake_case is preferred)
  floorID?: string; // camelCase (buggy resolver)
  floor_id?: string; // snake_case (works correctly)
  roomID?: string; // camelCase (buggy resolver)
  room_id?: string; // snake_case (works correctly)
  hiveID?: string; // camelCase
  hive_id?: string; // snake_case
  hive_serial: string;
  is_online: boolean;
  is_streaming?: boolean;
  height: number;
  center: number[];
  orientation: number[];
  field_of_view: number;
  door_line: number;
  in_direction: number;
  is_entrance: boolean;
  parallel_to_door: boolean;
  sensitivity: number;
  metadata: MetaData;
  note?: string;
  last_heartbeat?: number;
  last_raw_message?: number;
  last_occupancy_message?: number;
  power_type?: "Wired" | "Battery";
  sensor_serial?: string;
  installation_status?: "INSTALLED" | "UNINSTALLED";
  // Battery fields
  last_battery_change_date?: string;
  next_battery_change_date?: string;
  battery_change_by_date?: string;
}

/**
 * Hive - Gateway device managing sensors
 */
export interface Hive {
  id: string;
  name: string;
  serialNumber: string;
  floor_id: string;
  floorID: string;
  room_id?: string;
  roomID?: string;
  coordinates?: number[];
  is_online: boolean;
  isOnline: boolean;
  is_streaming?: boolean;
  isStreaming?: boolean;
  hiveVersion?: string;
  hiveType?: string;
  metadata: MetaData;
  note?: string;
  last_heartbeat?: number;
  lastHeartbeat?: number;
  net_path_stability?: number;
  netPathStability?: number;
  installed: boolean;
  sensors?: Sensor[];
}

/**
 * FloorPlan - Visual layout of a floor
 */
export interface FloorPlan {
  floor_plan_id: string;
  name: string;
  url?: string;
  coordinates?: number[][];
}

/**
 * GraphQL response wrapper types
 */
export interface SitesResponse {
  data: Site[];
}

export interface BuildingsResponse {
  data: Building[];
}

export interface FloorsResponse {
  data: Floor[];
}

export interface RoomsResponse {
  data: Room[];
}

export interface ZonesResponse {
  data: Zone[];
}

export interface SensorsResponse {
  data: Sensor[];
}

export interface HivesResponse {
  data: Hive[];
}
