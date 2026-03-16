/**
 * Utilities for building readable breadcrumb paths for assets
 */

import type { FlattenedAsset } from "./asset-flattener.js";

/**
 * Build a human-readable path for an asset
 * Example: "Acme Corp / Main Building / Floor 1 / Conference Room A"
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
