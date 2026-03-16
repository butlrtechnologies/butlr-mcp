/**
 * Utilities for building readable breadcrumb paths for assets
 */

import type { FlattenedAsset } from "./asset-flattener.js";

/**
 * Build a human-readable path for an asset
 * Example: "Burlingame / HQ Building / Floor 1 / Cafe Area"
 */
export function buildAssetPath(asset: FlattenedAsset): string {
  const parts: string[] = [];

  // Add site
  if (asset.site_name) {
    parts.push(asset.site_name);
  }

  // Add building
  if (asset.building_name) {
    parts.push(asset.building_name);
  }

  // Add floor
  if (asset.floor_name) {
    parts.push(asset.floor_name);
  }

  // Add room (only if this asset is a zone or device)
  if (asset.type === "zone" || asset.type === "sensor" || asset.type === "hive") {
    if (asset.room_name) {
      parts.push(asset.room_name);
    }
  }

  // Add the asset itself (unless it's already the last part)
  if (asset.type !== "site" || (asset.type === "site" && parts.length === 0)) {
    parts.push(asset.name);
  }

  return parts.join(" / ");
}

/**
 * Build a short path showing only immediate parent
 * Example: "Floor 1 / Cafe Area"
 */
export function buildShortPath(asset: FlattenedAsset): string {
  const parts: string[] = [];

  // Add immediate parent based on asset type
  switch (asset.type) {
    case "building":
      if (asset.site_name) parts.push(asset.site_name);
      break;
    case "floor":
      if (asset.building_name) parts.push(asset.building_name);
      break;
    case "room":
    case "zone":
      if (asset.floor_name) parts.push(asset.floor_name);
      break;
    case "sensor":
    case "hive":
      if (asset.room_name) {
        parts.push(asset.room_name);
      } else if (asset.floor_name) {
        parts.push(asset.floor_name);
      }
      break;
  }

  // Add the asset name
  parts.push(asset.name);

  return parts.join(" / ");
}

/**
 * Build parent context object for an asset
 * Useful for including in API responses
 */
export function buildParentContext(asset: FlattenedAsset): {
  site?: { id: string; name: string };
  building?: { id: string; name: string };
  floor?: { id: string; name: string };
  room?: { id: string; name: string };
} {
  const context: any = {};

  if (asset.site_id && asset.site_name) {
    context.site = { id: asset.site_id, name: asset.site_name };
  }

  if (asset.building_id && asset.building_name) {
    context.building = { id: asset.building_id, name: asset.building_name };
  }

  if (asset.floor_id && asset.floor_name) {
    context.floor = { id: asset.floor_id, name: asset.floor_name };
  }

  if (asset.room_id && asset.room_name) {
    context.room = { id: asset.room_id, name: asset.room_name };
  }

  return context;
}
