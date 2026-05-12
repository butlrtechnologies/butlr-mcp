# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.1] - 2026-05-12

### Fixed
- `butlr_space_busyness` no longer fails with a misleading "Room/Zone not found" error for valid IDs whose sites have a `timezone` configured. The `GET_ROOM` and `GET_ZONE` queries now select `site { id timezone }` instead of `site { timezone }` alone — Apollo Client 4's cache normalization requires the keyField declared in `graphql-client.ts` typePolicies, and a missing `id` silently set `result.data` to `undefined` under `errorPolicy: 'all'`. Surfaced via customer feedback against v0.2.0.
- `butlr_traffic_flow` now counts room-level traffic from every traffic-mode sensor bound to the room, not just sensors with `is_entrance === false`. `is_entrance` is a semantic flag (does this sensor sit at a building/floor entrance), not a routing one — the Reporting API aggregates by `room_id` regardless. Pre-fix the tool reported "does not have traffic-mode sensors" for cafés and similar rooms whose sensors are all entrances. Same fix applied to room-level traffic resolution in `butlr_get_current_occupancy` and `butlr_get_occupancy_timeseries`. Floor-level traffic still filters to `is_entrance === true` (correct).
- `butlr_get_current_occupancy` and `butlr_get_occupancy_timeseries` now query `zone_occupancy` for zones regardless of client-visible sensor count. Zones don't share sensor attribution with rooms — `zone_occupancy` is computed server-side and has no client-side sensor roll-up. The previous behavior gated the query on `presenceSensors.length > 0`, which was always 0 for zones, so the tools silently reported `available: false` even when the Reporting API had data. Sensor count is correctly still reported as 0 for zones.

## [0.2.0] - 2026-04-26

### Added
- `butlr_list_tags` — discover the tag vocabulary in an org with per-level usage counts (`applied_to: { rooms, zones, floors }`). Supports `name_contains` substring filter and `min_usage` threshold. Tags are sorted by total usage descending. (Spot-level tags exist in the data model but are not surfaced by this tool.)
- `butlr_available_rooms` response now includes a structured `unknown_tags` field listing any supplied tag names that did not resolve, so consumers can react programmatically without parsing the prose `warning`.

### Fixed
- `butlr_available_rooms` tag filter — the `roomsByTag` query was sending tag names as `tags`, but the API requires tag IDs as `tagIDs`. The tool now resolves tag names to IDs (case-insensitive) via the `tags` query before calling `roomsByTag(tagIDs:)`. The `roomsByTag` response is now correctly unwrapped from its `data` wrapper.
- `butlr_available_rooms` no longer silently relaxes AND semantics when one of the supplied tag names is unknown. Under `tag_match='all'` (the default), an unresolved tag short-circuits to an empty result with a clear error; only `tag_match='any'` continues with the resolved subset and a soft warning.
- Backend GraphQL errors returned via Apollo's `errorPolicy:'all'` are now surfaced as MCP `AUTH_EXPIRED` / `RATE_LIMITED` / `INTERNAL_ERROR` errors instead of being silently coerced into empty result sets.
- Unexpected response shapes from `roomsByTag` and `sites` queries now raise an MCP `INTERNAL_ERROR` (retryable) instead of a generic `Error`.
- `getTimezoneForAsset` now always returns a valid timezone, falling back to `BUTLR_TIMEZONE` (or `UTC`) with an `isFallback` flag when the site has no configured timezone. Occupancy and timeseries responses include a per-asset `timezone_warning` and an enhanced `timezone_note` when a fallback is in use. Timeseries `.window()` aggregation now uses the site timezone for local-aligned bucket boundaries instead of always defaulting to UTC.

### Changed
- `butlr_available_rooms` accepts a new `tag_match` arg (`"all"` default, or `"any"`) controlling multi-tag semantics. Maps to the GraphQL `useOR` parameter.
- Introduced branded `TagId` / `TagName` types at the tag-resolution boundary so the API's name-vs-id distinction is enforced at compile time.

## [0.1.2] - 2026-04-14

### Changed
- Switch npm publish to OIDC trusted publishing — removes NPM_TOKEN secret in favor of GitHub Actions identity verification
- Re-enable `--provenance` flag for cryptographic build attestation now that the repo is public
- Add `npm-publish` GitHub environment with team reviewer gate for deployment protection

### Improved
- Add "When NOT to Use" negative guidance to all 10 tool descriptions for better LLM tool routing
- Replace non-null assertions (`!`) with safe type narrowing via local variables in tool code

## [0.1.1] - 2026-03-20

### Changed
- Replace `undici` with built-in `fetch()` — lowers Node.js requirement from 20 to 18
- Remove `BUTLR_ORG_ID` from required env vars
- Update Claude Code setup docs to use `-e` flags for env vars
- Expand "Getting API Credentials" with self-service instructions for app.butlr.io

### Added
- `llms.txt` for LLM-assisted installation

## [0.1.0] - 2026-03-20

### Added
- 10 MCP tools for occupancy and asset data:
  - `butlr_search_assets` — fuzzy search across sites, buildings, floors, rooms, sensors
  - `butlr_get_asset_details` — comprehensive asset details with batch support
  - `butlr_hardware_snapshot` — device health: online/offline status, battery levels
  - `butlr_available_rooms` — find unoccupied rooms by capacity and tags
  - `butlr_space_busyness` — current occupancy with qualitative labels and trends
  - `butlr_traffic_flow` — entry/exit counts with hourly breakdown
  - `butlr_list_topology` — org hierarchy tree with depth control
  - `butlr_fetch_entity_details` — selective field fetching by entity ID
  - `butlr_get_occupancy_timeseries` — historical occupancy data
  - `butlr_get_current_occupancy` — real-time occupancy snapshot
- GraphQL and REST API clients with OAuth2 token refresh
- Topology and occupancy caching with configurable TTL
- MCP error translation (AUTH_EXPIRED, RATE_LIMITED, VALIDATION_FAILED)
- npm package configuration for one-shot install via `npx`
- GitHub Actions CI and publish workflows
- Project scaffolding: TypeScript strict mode, ESLint v9, Prettier, Vitest
- Pre-commit hooks: typecheck, tests, secret scanning, file size limits
- MIT license, security policy, contributing guidelines
